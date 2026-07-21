import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';

import { initializeSchema } from '../../src/db/schema.js';
import { createJobHandlers } from '../../src/jobs/handlers.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('job handler idempotency after worker restart', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const config = {
    freshnessMs: 3 * 24 * 60 * 60 * 1000,
    JOB_MAX_ATTEMPTS: 3,
    LLM_BASE_URL: 'https://example.invalid/v1',
    LLM_MODEL: 'test-model'
  };

  before(async () => {
    await initializeSchema(pool);
  });

  beforeEach(async () => {
    await pool.query(`
      truncate table instagram_accounts, discovery_runs, criteria_versions,
        llm_logs, provider_call_logs restart identity cascade
    `);
  });

  after(async () => {
    await pool.end();
  });

  async function accountWithContent(lifecycle = 'candidate') {
    const account = await pool.query(`
      insert into instagram_accounts(username,instagram_url,source_type,lifecycle_status)
      values ('idempotent_user','https://www.instagram.com/idempotent_user/','manual',$1)
      returning *
    `, [lifecycle]);
    await pool.query(`
      insert into account_profiles(account_id,username,profile_status,provider,fetched_at)
      values ($1,'idempotent_user','available','fixture',now())
    `, [account.rows[0].id]);
    await pool.query(`
      insert into reels(account_id,instagram_media_id,reel_url,transcript_status,
        transcript_text,transcript_quality,fetched_at)
      values ($1,'media-idempotent','https://www.instagram.com/reel/idempotent/',
        'available','useful clothing review','useful',now())
    `, [account.rows[0].id]);
    const criteria = await pool.query(`
      insert into criteria_versions(version_number,checklist_markdown,status,source)
      values (1,'active criteria','active','manual') returning *
    `);
    return { account: account.rows[0], criteria: criteria.rows[0] };
  }

  async function insertJob(jobType, accountId = null, extra = {}) {
    const result = await pool.query(`
      insert into jobs(account_id,reel_id,pipeline_run_id,discovery_run_id,job_type,dedupe_key,payload)
      values ($1,$2,$3,$4,$5,$6,$7) returning *
    `, [accountId, extra.reelId || null, extra.pipelineRunId || null,
      extra.discoveryRunId || null, jobType, extra.dedupeKey || `${jobType}:test`, extra.payload || {}]);
    return result.rows[0];
  }

  test('repeated discovery stores one source row for the same run', async () => {
    const run = await pool.query(`
      insert into discovery_runs(query,requested_limit) values ('clothing',1) returning *
    `);
    const job = await insertJob('discover_accounts', null, {
      discoveryRunId: run.rows[0].id,
      payload: { query: 'clothing', limit: 1 }
    });
    const instagram = {
      search: async () => ({
        provider: 'fixture', requestMeta: { status: 200 },
        items: [{ username: 'same_result' }]
      })
    };
    const handler = createJobHandlers({ pool, instagram, config }).discover_accounts;

    await handler(job);
    await handler(job);

    const accounts = await pool.query("select count(*)::int as count from instagram_accounts where username='same_result'");
    const sources = await pool.query('select count(*)::int as count from account_sources where discovery_run_id=$1', [run.rows[0].id]);
    const pipelines = await pool.query('select count(*)::int as count from pipeline_runs');
    const enrichmentJobs = await pool.query("select count(*)::int as count from jobs where job_type <> 'discover_accounts'");
    assert.equal(accounts.rows[0].count, 1);
    assert.equal(sources.rows[0].count, 1);
    assert.equal(pipelines.rows[0].count, 0);
    assert.equal(enrichmentJobs.rows[0].count, 0);
  });

  test('fresh profile and reels are cached while force refresh upserts without duplicates', async () => {
    const { account } = await accountWithContent();
    let profileCalls = 0;
    let reelsCalls = 0;
    const instagram = {
      profile: async () => {
        profileCalls += 1;
        return {
          provider: 'fixture', requestMeta: { status: 200 }, rawPayload: { fixture: true },
          profile: {
            instagramId: 'fixture-id', username: account.username, displayName: 'Updated', bio: null,
            avatarUrl: null, externalUrl: null, followers: 10, following: 2, postsCount: 3,
            verified: false, isPrivate: false, engagementRate: null, language: 'ru', contentCategory: 'fashion'
          }
        };
      },
      reels: async () => {
        reelsCalls += 1;
        return {
          provider: 'fixture', requestMeta: { status: 200 },
          items: [{
            instagramMediaId: 'media-idempotent', shortcode: 'IDEMPOTENT',
            reelUrl: 'https://www.instagram.com/reel/idempotent/', caption: 'updated',
            publishedAt: new Date('2026-01-01T00:00:00Z'), playCount: 100, likeCount: 5,
            commentCount: 1, thumbnailUrl: null, mediaUrl: null, provider: 'fixture', rawPayload: {}
          }]
        };
      }
    };
    const handlers = createJobHandlers({ pool, instagram, config });
    const cachedProfile = await insertJob('fetch_profile', account.id, {
      dedupeKey: 'profile:cached', payload: { forceRefresh: false }
    });
    const forcedProfile = await insertJob('fetch_profile', account.id, {
      dedupeKey: 'profile:forced', payload: { forceRefresh: true }
    });
    assert.deepEqual(await handlers.fetch_profile(cachedProfile), { cached: true });
    await handlers.fetch_profile(forcedProfile);
    assert.equal(profileCalls, 1);

    const run = await pool.query(`
      insert into pipeline_runs(account_id,run_type,reels_limit)
      values ($1,'candidate_enrichment',3) returning *
    `, [account.id]);
    const cachedReels = await insertJob('fetch_reels', account.id, {
      pipelineRunId: run.rows[0].id, dedupeKey: 'reels:cached',
      payload: { forceRefresh: false, reelsLimit: 3 }
    });
    const forcedReels = await insertJob('fetch_reels', account.id, {
      pipelineRunId: run.rows[0].id, dedupeKey: 'reels:forced',
      payload: { forceRefresh: true, reelsLimit: 3 }
    });
    assert.deepEqual(await handlers.fetch_reels(cachedReels), { cached: true });
    await handlers.fetch_reels(forcedReels);
    assert.equal(reelsCalls, 1);
    const reels = await pool.query('select count(*)::int as count from reels where account_id=$1', [account.id]);
    assert.equal(reels.rows[0].count, 1);
  });

  test('repeated transcript handler enqueues one deterministic classify job', async () => {
    const { account } = await accountWithContent();
    const reel = (await pool.query('select * from reels where account_id=$1', [account.id])).rows[0];
    const run = await pool.query(`
      insert into pipeline_runs(account_id,run_type,reels_limit)
      values ($1,'candidate_enrichment',3) returning *
    `, [account.id]);
    const job = await insertJob('fetch_transcript', account.id, {
      reelId: reel.id,
      pipelineRunId: run.rows[0].id,
      payload: { forceRefresh: true }
    });
    const instagram = {
      transcript: async () => ({
        provider: 'fixture', text: 'useful clothing review', requestMeta: { status: 200 }
      })
    };
    const handler = createJobHandlers({ pool, instagram, config }).fetch_transcript;

    await handler(job);
    await handler(job);

    const queued = await pool.query(`
      select count(*)::int as count from jobs
      where pipeline_run_id=$1 and reel_id=$2 and job_type='classify_transcript'
    `, [run.rows[0].id, reel.id]);
    assert.equal(queued.rows[0].count, 1);
  });

  test('repeated evaluation reuses the persisted result without another LLM call', async () => {
    const { account } = await accountWithContent();
    const job = await insertJob('evaluate_candidate', account.id);
    let calls = 0;
    const parsed = {
      recommendation: 'needs_manual_review', confidence: 60,
      positive_signals: ['useful'], negative_signals: [], explanation: 'fixture'
    };
    const llm = {
      evaluate: async () => {
        calls += 1;
        return {
          parsed, rawResponse: { fixture: true }, usage: {}, meta: { durationMs: 1 }
        };
      }
    };
    const handler = createJobHandlers({ pool, llm, config }).evaluate_candidate;

    assert.deepEqual(await handler(job), parsed);
    assert.deepEqual(await handler(job), parsed);
    assert.equal(calls, 1);
    const evaluations = await pool.query('select count(*)::int as count from evaluations where job_id=$1', [job.id]);
    const logs = await pool.query("select count(*)::int as count from llm_logs where job_id=$1 and status='succeeded'", [job.id]);
    assert.equal(evaluations.rows[0].count, 1);
    assert.equal(logs.rows[0].count, 1);
  });

  test('repeated criteria proposal reuses one draft without another LLM call', async () => {
    await accountWithContent('approved');
    const job = await insertJob('propose_criteria');
    let calls = 0;
    const llm = {
      proposeCriteria: async () => {
        calls += 1;
        return {
          parsed: {
            checklist_markdown: 'proposed criteria', search_queries: ['clothing'],
            transcript_rules: { noisePatterns: [], lowValuePatterns: [], minCharacters: 12, minWords: 3 },
            diff_summary: 'fixture change'
          },
          rawResponse: { fixture: true }, usage: {}, meta: { durationMs: 1 }
        };
      }
    };
    const handler = createJobHandlers({ pool, llm, config }).propose_criteria;

    await handler(job);
    const repeated = await handler(job);
    assert.equal(repeated.cached, true);
    assert.equal(calls, 1);
    const drafts = await pool.query("select count(*)::int as count from criteria_versions where source_job_id=$1", [job.id]);
    const logs = await pool.query("select count(*)::int as count from llm_logs where job_id=$1 and status='succeeded'", [job.id]);
    assert.equal(drafts.rows[0].count, 1);
    assert.equal(logs.rows[0].count, 1);
  });
});
