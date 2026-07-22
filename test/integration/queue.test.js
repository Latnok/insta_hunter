import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';

import { initializeSchema } from '../../src/db/schema.js';
import {
  completeJob,
  enqueueJob,
  failJob,
  heartbeatJob,
  recoverStaleJobs,
  reserveJob
} from '../../src/db/repositories/jobs.js';
import { cancelJob, retryJob } from '../../src/services/jobs.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('PostgreSQL job queue concurrency and recovery', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });

  before(async () => {
    await initializeSchema(pool);
  });

  beforeEach(async () => {
    await pool.query('truncate table instagram_accounts, jobs restart identity cascade');
  });

  after(async () => {
    await pool.end();
  });

  function job(overrides = {}) {
    return {
      jobType: 'discover_accounts',
      dedupeKey: 'discovery:test',
      maxAttempts: 3,
      ...overrides
    };
  }

  async function accountPipeline(username, lifecycle = 'candidate', runType = 'candidate_enrichment') {
    const account = (await pool.query(`
      insert into instagram_accounts(username,instagram_url,source_type,lifecycle_status)
      values ($1,$2,'manual',$3) returning *
    `, [username, `https://www.instagram.com/${username}/`, lifecycle])).rows[0];
    const pipeline = (await pool.query(`
      insert into pipeline_runs(account_id,run_type,reels_limit)
      values ($1,$2,3) returning *
    `, [account.id, runType])).rows[0];
    return { account, pipeline };
  }

  test('concurrent enqueue calls preserve a single deduplicated job', async () => {
    const [first, second] = await Promise.all([
      enqueueJob(pool, job()),
      enqueueJob(pool, job())
    ]);
    assert.equal(first.id, second.id);
    const count = await pool.query('select count(*)::int as count from jobs');
    assert.equal(count.rows[0].count, 1);
  });

  test('two workers cannot reserve the same job', async () => {
    await enqueueJob(pool, job());
    const reservations = await Promise.all([
      reserveJob(pool, 'worker-a'),
      reserveJob(pool, 'worker-b')
    ]);
    const claimed = reservations.filter(Boolean);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].attempts, 1);

    const attempts = await pool.query('select attempt_number, outcome from job_attempts');
    assert.deepEqual(attempts.rows, [{ attempt_number: 1, outcome: 'running' }]);
  });

  test('expired lease closes the crashed attempt and permits exactly one retry', async () => {
    const queued = await enqueueJob(pool, job());
    const first = await reserveJob(pool, 'crashed-worker');
    assert.equal(first.id, queued.id);
    await pool.query(`
      update jobs set heartbeat_at=now() - interval '20 minutes' where id=$1
    `, [queued.id]);

    assert.equal(await recoverStaleJobs(pool, 10), 1);
    const recovered = await pool.query(
      'select status, locked_by, error_summary from jobs where id=$1',
      [queued.id]
    );
    assert.deepEqual(recovered.rows[0], {
      status: 'retry_wait',
      locked_by: null,
      error_summary: 'worker lease expired'
    });

    const firstAttempt = await pool.query(
      'select outcome, error_detail, finished_at from job_attempts where job_id=$1 and attempt_number=1',
      [queued.id]
    );
    assert.equal(firstAttempt.rows[0].outcome, 'failed');
    assert.equal(firstAttempt.rows[0].error_detail, 'worker lease expired');
    assert.ok(firstAttempt.rows[0].finished_at);

    const reservations = await Promise.all([
      reserveJob(pool, 'replacement-a'),
      reserveJob(pool, 'replacement-b')
    ]);
    const claimed = reservations.filter(Boolean);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].attempts, 2);

    assert.equal(await completeJob(pool, claimed[0], { ok: true }), true);
    const attempts = await pool.query(`
      select attempt_number, outcome from job_attempts where job_id=$1 order by attempt_number
    `, [queued.id]);
    assert.deepEqual(attempts.rows, [
      { attempt_number: 1, outcome: 'failed' },
      { attempt_number: 2, outcome: 'succeeded' }
    ]);
  });

  test('retry schedule ends in failed after max attempts', async () => {
    const queued = await enqueueJob(pool, job({ dedupeKey: 'retry:test', maxAttempts: 2 }));
    const first = await reserveJob(pool, 'worker-a');
    assert.equal(await failJob(pool, first, new Error('first failure')), true);

    let stored = await pool.query('select status, error_summary from jobs where id=$1', [queued.id]);
    assert.equal(stored.rows[0].status, 'retry_wait');
    assert.equal(stored.rows[0].error_summary, 'first failure');

    await pool.query('update jobs set available_at=now() where id=$1', [queued.id]);
    const second = await reserveJob(pool, 'worker-b');
    assert.equal(await failJob(pool, second, new Error('final failure')), true);

    stored = await pool.query('select status, attempts, finished_at from jobs where id=$1', [queued.id]);
    assert.equal(stored.rows[0].status, 'failed');
    assert.equal(stored.rows[0].attempts, 2);
    assert.ok(stored.rows[0].finished_at);
  });

  test('heartbeat keeps a long-running current attempt from stale recovery', async () => {
    await enqueueJob(pool, job({ dedupeKey: 'heartbeat:test' }));
    const running = await reserveJob(pool, 'live-worker');
    await pool.query(`
      update jobs set locked_at=now() - interval '20 minutes', heartbeat_at=now() - interval '20 minutes'
      where id=$1
    `, [running.id]);

    assert.equal(await heartbeatJob(pool, running), true);
    assert.equal(await recoverStaleJobs(pool, 10), 0);
    const stored = await pool.query(
      'select status, locked_by, current_attempt_id from jobs where id=$1',
      [running.id]
    );
    assert.deepEqual(stored.rows[0], {
      status: 'running',
      locked_by: 'live-worker',
      current_attempt_id: running.current_attempt_id
    });
  });

  test('stale worker cannot complete or fail a replacement attempt', async () => {
    await enqueueJob(pool, job({ dedupeKey: 'fencing:test' }));
    const stale = await reserveJob(pool, 'stale-worker');
    await pool.query("update jobs set heartbeat_at=now() - interval '20 minutes' where id=$1", [stale.id]);
    assert.equal(await recoverStaleJobs(pool, 10), 1);
    const replacement = await reserveJob(pool, 'replacement-worker');

    assert.equal(await completeJob(pool, stale, { stale: true }), false);
    assert.equal(await failJob(pool, stale, new Error('late failure')), false);
    const running = await pool.query(
      'select status, locked_by, current_attempt_id from jobs where id=$1',
      [stale.id]
    );
    assert.deepEqual(running.rows[0], {
      status: 'running',
      locked_by: 'replacement-worker',
      current_attempt_id: replacement.current_attempt_id
    });

    assert.equal(await completeJob(pool, replacement, { fresh: true }), true);
    const attempts = await pool.query(`
      select attempt_number, outcome from job_attempts where job_id=$1 order by attempt_number
    `, [stale.id]);
    assert.deepEqual(attempts.rows, [
      { attempt_number: 1, outcome: 'failed' },
      { attempt_number: 2, outcome: 'succeeded' }
    ]);
  });

  test('expired lease on the final allowed attempt fails permanently', async () => {
    await enqueueJob(pool, job({ dedupeKey: 'stale-final:test', maxAttempts: 1 }));
    const running = await reserveJob(pool, 'crashed-final-worker');
    await pool.query("update jobs set heartbeat_at=now() - interval '20 minutes' where id=$1", [running.id]);

    assert.equal(await recoverStaleJobs(pool, 10), 1);
    const stored = await pool.query(`
      select status, finished_at, locked_by, current_attempt_id, error_summary
      from jobs where id=$1
    `, [running.id]);
    assert.equal(stored.rows[0].status, 'failed');
    assert.ok(stored.rows[0].finished_at);
    assert.equal(stored.rows[0].locked_by, null);
    assert.equal(stored.rows[0].current_attempt_id, null);
    assert.equal(stored.rows[0].error_summary, 'worker lease expired');
    assert.equal(await reserveJob(pool, 'too-late-worker'), null);

    const attempt = await pool.query(
      'select outcome, error_detail, finished_at from job_attempts where id=$1',
      [running.current_attempt_id]
    );
    assert.equal(attempt.rows[0].outcome, 'failed');
    assert.equal(attempt.rows[0].error_detail, 'worker lease expired');
    assert.ok(attempt.rows[0].finished_at);
  });

  test('manual cancellation fences a running attempt and terminates its pipeline', async () => {
    const { account, pipeline } = await accountPipeline('cancel_running');
    await enqueueJob(pool, job({
      accountId: account.id, pipelineRunId: pipeline.id,
      dedupeKey: 'cancel:running', jobType: 'fetch_profile'
    }));
    await enqueueJob(pool, job({
      accountId: account.id, pipelineRunId: pipeline.id,
      dedupeKey: 'cancel:pending', jobType: 'fetch_reels'
    }));
    const running = await reserveJob(pool, 'cancel-worker');

    await cancelJob(pool, running.id);
    const storedPipeline = await pool.query('select status,finished_at from pipeline_runs where id=$1', [pipeline.id]);
    assert.equal(storedPipeline.rows[0].status, 'cancelled');
    assert.ok(storedPipeline.rows[0].finished_at);
    const jobs = await pool.query('select status,current_attempt_id from jobs where pipeline_run_id=$1 order by id', [pipeline.id]);
    assert.deepEqual(jobs.rows.map((row) => row.status), ['cancelled', 'cancelled']);
    assert.ok(jobs.rows.every((row) => row.current_attempt_id === null));
    const attempt = await pool.query('select outcome,error_detail from job_attempts where id=$1', [running.current_attempt_id]);
    assert.deepEqual(attempt.rows[0], { outcome: 'failed', error_detail: 'cancelled manually' });
    assert.equal(await completeJob(pool, running, { tooLate: true }), false);
  });

  test('manual retry reopens a valid pipeline and rejects unsafe retry contexts', async () => {
    const valid = await accountPipeline('retry_valid');
    await enqueueJob(pool, job({
      accountId: valid.account.id, pipelineRunId: valid.pipeline.id,
      dedupeKey: 'manual-retry:valid', jobType: 'fetch_profile', maxAttempts: 1
    }));
    const failed = await reserveJob(pool, 'retry-worker');
    assert.equal(await failJob(pool, failed, new Error('failed once')), true);
    await pool.query("update pipeline_runs set status='failed',error_summary='stale pipeline error',finished_at=now() where id=$1", [valid.pipeline.id]);
    const retried = await retryJob(pool, failed.id);
    assert.equal(retried.status, 'retry_wait');
    assert.equal(retried.max_attempts, 4);
    const reopened = await pool.query('select status,error_summary,finished_at from pipeline_runs where id=$1', [valid.pipeline.id]);
    assert.deepEqual(reopened.rows[0], { status: 'running', error_summary: null, finished_at: null });

    const discovery = (await pool.query(`
      insert into discovery_runs(query,requested_limit,status,error_summary,finished_at)
      values ('retry discovery',5,'failed','stale discovery error',now()) returning *
    `)).rows[0];
    const discoveryJob = (await pool.query(`
      insert into jobs(discovery_run_id,job_type,dedupe_key,status,attempts,error_summary)
      values ($1,'discover_accounts','manual-retry:discovery','failed',1,'failed once') returning *
    `, [discovery.id])).rows[0];
    await retryJob(pool, discoveryJob.id);
    const reopenedDiscovery = await pool.query('select status,error_summary,finished_at from discovery_runs where id=$1', [discovery.id]);
    assert.deepEqual(reopenedDiscovery.rows[0], { status: 'running', error_summary: null, finished_at: null });

    await pool.query("update jobs set status='failed',attempts=10,max_attempts=10 where id=$1", [failed.id]);
    await assert.rejects(retryJob(pool, failed.id), /retry budget is exhausted/);

    const rejected = await accountPipeline('retry_rejected');
    const rejectedJob = (await pool.query(`
      insert into jobs(account_id,pipeline_run_id,job_type,dedupe_key,status,attempts)
      values ($1,$2,'fetch_profile','manual-retry:rejected','failed',1) returning *
    `, [rejected.account.id, rejected.pipeline.id])).rows[0];
    await pool.query("update instagram_accounts set lifecycle_status='rejected',rejected_at=now() where id=$1", [rejected.account.id]);
    await assert.rejects(retryJob(pool, rejectedJob.id), /rejected or archived/);

    const cancelled = await accountPipeline('retry_cancelled');
    const cancelledJob = (await pool.query(`
      insert into jobs(account_id,pipeline_run_id,job_type,dedupe_key,status,attempts)
      values ($1,$2,'fetch_profile','manual-retry:cancelled','failed',1) returning *
    `, [cancelled.account.id, cancelled.pipeline.id])).rows[0];
    await pool.query("update pipeline_runs set status='cancelled',finished_at=now() where id=$1", [cancelled.pipeline.id]);
    await assert.rejects(retryJob(pool, cancelledJob.id), /Cancelled pipelines/);
  });
});
