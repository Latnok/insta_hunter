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

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('PostgreSQL job queue concurrency and recovery', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });

  before(async () => {
    await initializeSchema(pool);
  });

  beforeEach(async () => {
    await pool.query('truncate table jobs restart identity cascade');
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
});
