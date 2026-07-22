import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';

import { initializeSchema } from '../../src/db/schema.js';
import { upsertAccount } from '../../src/db/repositories/accounts.js';
import { completeJob, enqueueJob, reserveJob } from '../../src/db/repositories/jobs.js';
import {
  approveAccount,
  archiveAccount,
  rejectAccount,
  restoreAccount
} from '../../src/services/accounts.js';
import { commitCsv } from '../../src/services/imports.js';

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

    const archived = await archiveAccount(pool, account.id, 'pause', {});
    assert.equal(archived.lifecycle_status, 'archived');
    assert.ok(archived.archived_at);

    const restored = await restoreAccount(pool, account.id, {});
    assert.equal(restored.lifecycle_status, 'approved');
    assert.equal(restored.archived_at, null);

    const audit = await pool.query(
      'select action from audit_events where entity_id=$1 order by id',
      [account.id]
    );
    assert.deepEqual(audit.rows.map((row) => row.action), ['approved', 'archived', 'approved']);
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
});
