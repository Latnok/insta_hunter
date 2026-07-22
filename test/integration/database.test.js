import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';

import {
  currentSchemaVersion,
  getSchemaStatus,
  initializeSchema
} from '../../src/db/schema.js';
import { withTransaction } from '../../src/db/pool.js';
import { listAccounts, upsertAccount } from '../../src/db/repositories/accounts.js';
import { completeJob, enqueueJob, reserveJob } from '../../src/db/repositories/jobs.js';
import {
  approveAccount,
  archiveAccount,
  rejectAccount,
  restoreAccount
} from '../../src/services/accounts.js';
import { commitCsv } from '../../src/services/imports.js';
import { createCriteriaDraft } from '../../src/services/criteria.js';
import { decideOutreachDraft, regenerateOutreachDraft, saveOutreachDraft } from '../../src/services/outreach.js';
import { runAutomationCycle } from '../../src/services/automation.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('PostgreSQL repositories, constraints and lifecycle transitions', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

  before(async () => {
    await initializeSchema(pool);
  });

  beforeEach(async () => {
    await pool.query(`
      truncate table
        instagram_accounts,
        discovery_runs,
        criteria_versions,
        llm_logs,
        audit_events,
        provider_call_logs,
        user_sessions,
        worker_heartbeats
        ,csv_import_batches
      restart identity cascade
    `);
  });

  after(async () => {
    await pool.end();
  });

  async function insertAccount(username = 'test_account') {
    const result = await pool.query(`
      insert into instagram_accounts(username, instagram_url, source_type)
      values ($1, $2, 'manual') returning *
    `, [username, `https://www.instagram.com/${username}/`]);
    return result.rows[0];
  }

  async function expectPgError(query, code) {
    await assert.rejects(query, (error) => error?.code === code);
  }

  test('schema compatibility is explicit, versioned and read-only', async () => {
    const compatible = await getSchemaStatus(pool);
    assert.deepEqual(compatible, {
      state: 'compatible', compatible: true,
      expectedVersion: currentSchemaVersion,
      actualVersion: currentSchemaVersion,
      missingTables: []
    });

    await pool.query('update schema_metadata set schema_version = 999 where singleton = true');
    try {
      const incompatible = await getSchemaStatus(pool);
      assert.equal(incompatible.state, 'incompatible');
      assert.equal(incompatible.compatible, false);
      assert.equal(incompatible.actualVersion, 999);
      assert.equal(incompatible.expectedVersion, currentSchemaVersion);
      await assert.rejects(
        initializeSchema(pool),
        /incompatible schema.*refusing to modify it/
      );
      const unchanged = await pool.query(
        'select schema_version from schema_metadata where singleton = true'
      );
      assert.equal(unchanged.rows[0].schema_version, 999);
    } finally {
      await pool.query(
        'update schema_metadata set schema_version = $1 where singleton = true',
        [currentSchemaVersion]
      );
    }
  });

  test('account upsert is idempotent, preserves lifecycle and records every source', async () => {
    const first = await upsertAccount(pool, {
      input: '@Stable_User', sourceType: 'manual', sourceNote: 'first'
    });
    assert.equal(first.inserted, true);

    await pool.query(
      "update instagram_accounts set lifecycle_status='rejected', rejected_at=now() where id=$1",
      [first.id]
    );

    const second = await upsertAccount(pool, {
      input: 'https://instagram.com/stable_user/', sourceType: 'csv', sourceNote: 'second'
    });
    assert.equal(second.inserted, false);
    assert.equal(second.id, first.id);
    assert.equal(second.lifecycle_status, 'rejected');

    const sources = await pool.query(
      'select source_type from account_sources where account_id=$1 order by id',
      [first.id]
    );
    assert.deepEqual(sources.rows.map((row) => row.source_type), ['manual', 'csv']);
  });

  test('database rejects invalid account, discovery and pipeline values', async () => {
    await expectPgError(pool.query(`
      insert into instagram_accounts(username, instagram_url, source_type)
      values ('UpperCase', 'https://www.instagram.com/UpperCase/', 'manual')
    `), '23514');

    await expectPgError(pool.query(`
      insert into discovery_runs(query, requested_limit) values ('query', 0)
    `), '23514');

    const account = await insertAccount();
    await expectPgError(pool.query(`
      insert into pipeline_runs(account_id, run_type, reels_limit)
      values ($1, 'candidate_enrichment', 21)
    `, [account.id]), '23514');

    await pool.query(`
      insert into pipeline_runs(account_id, run_type, reels_limit)
      values ($1, 'candidate_enrichment', 3)
    `, [account.id]);
    await expectPgError(pool.query(`
      insert into pipeline_runs(account_id, run_type, reels_limit)
      values ($1, 'candidate_enrichment', 3)
    `, [account.id]), '23505');
  });

  test('reel identity, job dedupe and active criteria constraints are enforced', async () => {
    const account = await insertAccount();
    await expectPgError(pool.query(`
      insert into reels(account_id, reel_url, fetched_at)
      values ($1, 'https://www.instagram.com/reel/invalid/', now())
    `, [account.id]), '23514');

    await pool.query(`
      insert into reels(account_id, instagram_media_id, reel_url, fetched_at)
      values ($1, 'media-1', 'https://www.instagram.com/reel/one/', now())
    `, [account.id]);
    await expectPgError(pool.query(`
      insert into reels(account_id, instagram_media_id, reel_url, fetched_at)
      values ($1, 'media-1', 'https://www.instagram.com/reel/two/', now())
    `, [account.id]), '23505');

    await pool.query(`
      insert into jobs(account_id, job_type, dedupe_key)
      values ($1, 'fetch_profile', 'profile:1')
    `, [account.id]);
    await expectPgError(pool.query(`
      insert into jobs(account_id, job_type, dedupe_key)
      values ($1, 'fetch_profile', 'profile:1')
    `, [account.id]), '23505');
    await expectPgError(pool.query(`
      insert into jobs(account_id, job_type, dedupe_key, max_attempts)
      values ($1, 'fetch_profile', 'profile:bad-attempts', 0)
    `, [account.id]), '23514');

    await pool.query(`
      insert into criteria_versions(version_number, checklist_markdown, status, source)
      values (1, 'first', 'active', 'manual')
    `);
    await expectPgError(pool.query(`
      insert into criteria_versions(version_number, checklist_markdown, status, source)
      values (2, 'second', 'active', 'manual')
    `), '23505');
  });

  test('reject cancels pending work and writes an audit event atomically', async () => {
    const account = await insertAccount('reject_me');
    const pipeline = (await pool.query(`
      insert into pipeline_runs(account_id,run_type,reels_limit)
      values ($1,'candidate_enrichment',3) returning *
    `, [account.id])).rows[0];
    await enqueueJob(pool, {
      accountId: account.id, pipelineRunId: pipeline.id, jobType: 'fetch_profile',
      dedupeKey: 'reject:running', maxAttempts: 3
    });
    await enqueueJob(pool, {
      accountId: account.id, pipelineRunId: pipeline.id, jobType: 'fetch_reels',
      dedupeKey: 'reject:pending', maxAttempts: 3
    });
    const running = await reserveJob(pool, 'reject-worker');

    const rejected = await rejectAccount(pool, account.id, 'not relevant', {
      ip: '127.0.0.1', userAgent: 'integration-test'
    });
    assert.equal(rejected.lifecycle_status, 'rejected');
    assert.equal(rejected.rejection_reason, 'not relevant');

    const jobs = await pool.query('select status, finished_at from jobs order by id');
    assert.deepEqual(jobs.rows.map((row) => row.status), ['cancelled', 'cancelled']);
    assert.ok(jobs.rows.every((row) => row.finished_at));
    const storedPipeline = await pool.query('select status,finished_at from pipeline_runs where id=$1', [pipeline.id]);
    assert.equal(storedPipeline.rows[0].status, 'cancelled');
    assert.ok(storedPipeline.rows[0].finished_at);
    const attempt = await pool.query('select outcome,error_detail from job_attempts where id=$1', [running.current_attempt_id]);
    assert.deepEqual(attempt.rows[0], { outcome: 'failed', error_detail: 'account rejected' });
    assert.equal(await completeJob(pool, running, { tooLate: true }), false);

    const audit = await pool.query('select action, reason from audit_events');
    assert.deepEqual(audit.rows, [{ action: 'rejected', reason: 'not relevant' }]);
  });

  test('approve requires an evaluation; approved accounts can be archived and restored', async () => {
    const account = await insertAccount('approve_me');
    await assert.rejects(
      approveAccount(pool, account.id, {}),
      /valid LLM evaluation is required/
    );

    const criteria = await pool.query(`
      insert into criteria_versions(version_number, checklist_markdown, status, source)
      values (1, 'criteria', 'active', 'manual') returning id
    `);
    const log = await pool.query(`
      insert into llm_logs(
        purpose, account_id, criteria_version_id, base_url, model,
        request_messages, status
      ) values (
        'candidate_evaluation', $1, $2, 'https://example.invalid', 'test-model',
        '[]'::jsonb, 'succeeded'
      ) returning id
    `, [account.id, criteria.rows[0].id]);
    await pool.query(`
      insert into evaluations(
        account_id, criteria_version_id, recommendation, confidence,
        explanation, llm_log_id
      ) values ($1, $2, 'needs_manual_review', 50, 'test', $3)
    `, [account.id, criteria.rows[0].id, log.rows[0].id]);

    const approved = await approveAccount(pool, account.id, {});
    assert.equal(approved.lifecycle_status, 'approved');
    assert.ok(approved.approved_at);
    const outreachJobs = await pool.query("select job_type,status from jobs where account_id=$1 and job_type='draft_outreach'", [account.id]);
    assert.deepEqual(outreachJobs.rows, [{ job_type: 'draft_outreach', status: 'pending' }]);

    const archived = await archiveAccount(pool, account.id, 'pause', {});
    assert.equal(archived.lifecycle_status, 'archived');
    assert.ok(archived.archived_at);

    const restored = await restoreAccount(pool, account.id, {});
    assert.equal(restored.lifecycle_status, 'approved');
    assert.equal(restored.archived_at, null);
    const outreachJobCount = await pool.query("select count(*)::int as count from jobs where account_id=$1 and job_type='draft_outreach'", [account.id]);
    assert.equal(outreachJobCount.rows[0].count, 1);

    const audit = await pool.query(
      'select action from audit_events where entity_id=$1 order by id',
      [account.id]
    );
    assert.deepEqual(audit.rows.map((row) => row.action), ['approved', 'archived', 'approved']);
  });

  test('decision threshold queues one low-priority automatic criteria proposal', async () => {
    const automation = {
      criteriaEnabled: true, decisionThreshold: 2, refreshHours: 168,
      discoveryEnabled: false, dailyDiscoveryLimit: 20, perQueryLimit: 5
    };
    await pool.query(`
      insert into criteria_versions(version_number,checklist_markdown,search_queries,transcript_rules,status,source)
      values (1,'criteria','["fashion"]',$1,'active','manual')
    `, [{ criteriaAutomation: automation }]);
    const first = await insertAccount('auto_reject_one');
    const second = await insertAccount('auto_reject_two');
    const config = { JOB_MAX_ATTEMPTS: 3 };

    await rejectAccount(pool, first.id, 'not relevant', {}, config);
    assert.equal((await pool.query("select count(*)::int as count from jobs where job_type='propose_criteria'")).rows[0].count, 0);
    await rejectAccount(pool, second.id, 'not relevant', {}, config);

    const jobs = await pool.query("select priority,payload from jobs where job_type='propose_criteria'");
    assert.equal(jobs.rowCount, 1);
    assert.equal(jobs.rows[0].priority, -5);
    assert.equal(jobs.rows[0].payload.trigger, 'automatic_threshold');
    assert.equal(jobs.rows[0].payload.decisionCount, 2);
  });

  test('automation cycle respects unique queries and the global daily discovery budget', async () => {
    const automation = {
      criteriaEnabled: false, decisionThreshold: 10, refreshHours: 24,
      discoveryEnabled: true, dailyDiscoveryLimit: 7, perQueryLimit: 3
    };
    await pool.query(`
      insert into criteria_versions(version_number,checklist_markdown,search_queries,transcript_rules,status,source)
      values (1,'criteria',$1,$2,'active','manual')
    `, [JSON.stringify(['Fashion Moscow', 'fashion moscow', 'Обзоры одежды', 'стиль']), { criteriaAutomation: automation }]);
    const config = { JOB_MAX_ATTEMPTS: 3, DISCOVERY_DEFAULT_LIMIT: 5, DISCOVERY_MAX_LIMIT: 100 };

    const first = await runAutomationCycle(pool, config);
    const second = await runAutomationCycle(pool, config);
    assert.equal(first.discovery.queued, 3);
    assert.equal(second.discovery.queued, 0);
    assert.equal(second.discovery.reason, 'daily_limit');

    const runs = await pool.query('select query,requested_limit,created_by from discovery_runs order by id');
    assert.deepEqual(runs.rows, [
      { query: 'Fashion Moscow', requested_limit: 3, created_by: 'automation' },
      { query: 'Обзоры одежды', requested_limit: 3, created_by: 'automation' },
      { query: 'стиль', requested_limit: 1, created_by: 'automation' }
    ]);
    const jobs = await pool.query("select priority from jobs where job_type='discover_accounts' order by id");
    assert.ok(jobs.rows.every((row) => row.priority === -10));
  });

  test('candidate listing prioritizes uncertain evaluated accounts', async () => {
    const criteria = (await pool.query(`
      insert into criteria_versions(version_number,checklist_markdown,status,source)
      values (1,'criteria','active','manual') returning id
    `)).rows[0];
    const manual = await insertAccount('manual_review_first');
    const uncertain = await insertAccount('uncertain_second');
    await insertAccount('not_evaluated_last');
    for (const [account, recommendation, confidence] of [
      [manual, 'needs_manual_review', 90], [uncertain, 'recommended_approve', 52]
    ]) {
      const log = (await pool.query(`
        insert into llm_logs(purpose,account_id,criteria_version_id,base_url,model,request_messages,status)
        values ('candidate_evaluation',$1,$2,'https://example.invalid','test','[]','succeeded') returning id
      `, [account.id, criteria.id])).rows[0];
      await pool.query(`
        insert into evaluations(account_id,criteria_version_id,recommendation,confidence,explanation,llm_log_id)
        values ($1,$2,$3,$4,'fixture',$5)
      `, [account.id, criteria.id, recommendation, confidence, log.id]);
    }
    const accounts = await listAccounts(pool, {
      statuses: ['candidate'], prioritizeUncertain: true, limit: 10, offset: 0
    });
    assert.deepEqual(accounts.map((account) => account.username), [
      'manual_review_first', 'uncertain_second', 'not_evaluated_last'
    ]);
  });

  test('outreach draft can be edited, approved and regenerated only for approved bloggers', async () => {
    const account = (await pool.query(`
      insert into instagram_accounts(username,instagram_url,source_type,lifecycle_status)
      values ('outreach_user','https://www.instagram.com/outreach_user/','manual','approved') returning *
    `)).rows[0];
    const proposal = (await pool.query(`
      insert into outreach_proposals(account_id,message_text,personalization_reason)
      values ($1,'Initial text','Relevant clothing content') returning *
    `, [account.id])).rows[0];

    const edited = await saveOutreachDraft(pool, proposal.id, 'Edited warm proposal', { ip: '127.0.0.1' });
    assert.equal(edited.message_text, 'Edited warm proposal');
    const approved = await decideOutreachDraft(pool, proposal.id, 'approved', {}, 'Final text approved with one click');
    assert.equal(approved.status, 'approved');
    assert.equal(approved.message_text, 'Final text approved with one click');
    assert.ok(approved.approved_at);
    await assert.rejects(saveOutreachDraft(pool, proposal.id, 'Too late', {}), /only a draft|только черновик/i);

    const job = await regenerateOutreachDraft(pool, { JOB_MAX_ATTEMPTS: 3 }, account.id, {});
    assert.equal(job.job_type, 'draft_outreach');
    assert.equal(job.status, 'pending');
    const actions = await pool.query("select action from audit_events where action like 'outreach_%' order by id");
    assert.deepEqual(actions.rows.map((row) => row.action), ['outreach_edit', 'outreach_approved', 'outreach_regenerate']);
  });

  test('CSV commit atomically creates every new account, pipeline and job', async () => {
    const config = { REELS_DEFAULT_LIMIT: 3, REELS_MAX_LIMIT: 20, JOB_MAX_ATTEMPTS: 3 };
    const previewId = crypto.randomUUID();
    const preview = {
      valid: [
        { username: 'csv_atomic_one', sourceNote: 'one' },
        { username: 'csv_atomic_two', sourceNote: 'two' }
      ]
    };
    const attempts = await Promise.allSettled([
      commitCsv(pool, config, { previewId, version: 1, preview }),
      commitCsv(pool, config, { previewId, version: 1, preview })
    ]);
    const succeeded = attempts.filter((result) => result.status === 'fulfilled');
    const rejected = attempts.filter((result) => result.status === 'rejected');
    assert.equal(succeeded.length, 1);
    assert.equal(succeeded[0].value.length, 2);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /already committed/);
    assert.equal((await pool.query("select count(*)::int as count from instagram_accounts where source_type='csv'")).rows[0].count, 2);
    assert.equal((await pool.query('select count(*)::int as count from pipeline_runs')).rows[0].count, 2);
    assert.equal((await pool.query('select count(*)::int as count from jobs')).rows[0].count, 4);
    assert.equal((await pool.query('select count(*)::int as count from csv_import_batches where id=$1', [previewId])).rows[0].count, 1);
    await assert.rejects(
      commitCsv(pool, config, { previewId, version: 1, preview }),
      /already committed/
    );
  });

  test('CSV commit rollback leaves no partial rows or consumed preview marker', async () => {
    const config = { REELS_DEFAULT_LIMIT: 3, REELS_MAX_LIMIT: 20, JOB_MAX_ATTEMPTS: 3 };
    const previewId = crypto.randomUUID();
    await assert.rejects(commitCsv(pool, config, {
      previewId,
      version: 1,
      preview: { valid: [{ username: 'csv_before_error' }, { username: 'bad username' }] }
    }), /Invalid Instagram username/);
    assert.equal((await pool.query("select count(*)::int as count from instagram_accounts where username='csv_before_error'")).rows[0].count, 0);
    assert.equal((await pool.query('select count(*)::int as count from pipeline_runs')).rows[0].count, 0);
    assert.equal((await pool.query('select count(*)::int as count from jobs')).rows[0].count, 0);
    assert.equal((await pool.query('select count(*)::int as count from csv_import_batches where id=$1', [previewId])).rows[0].count, 0);
  });

  test('concurrent manual and LLM drafts receive unique sequential version numbers', async () => {
    const active = (await pool.query(`
      insert into criteria_versions(version_number,checklist_markdown,status,source)
      values (1,'active criteria','active','manual') returning id
    `)).rows[0];
    const rules = { noisePatterns: [], lowValuePatterns: [], minCharacters: 12, minWords: 3 };
    const drafts = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      withTransaction(pool, (client) => createCriteriaDraft(client, {
        checklistMarkdown: `draft ${index}`,
        searchQueries: [`query ${index}`],
        transcriptRules: rules,
        source: index % 2 ? 'llm' : 'manual',
        parentVersionId: index % 2 ? active.id : null,
        diffSummary: `concurrent ${index}`
      }))
    ));

    assert.equal(new Set(drafts.map((draft) => draft.version_number)).size, 12);
    const stored = await pool.query(`
      select version_number,parent_version_id,source from criteria_versions
      where status='draft' order by version_number
    `);
    assert.deepEqual(stored.rows.map((row) => row.version_number), Array.from({ length: 12 }, (_, index) => index + 2));
    assert.ok(stored.rows.every((row) => row.parent_version_id === active.id));
    assert.equal(stored.rows.filter((row) => row.source === 'manual').length, 6);
    assert.equal(stored.rows.filter((row) => row.source === 'llm').length, 6);
  });
});
