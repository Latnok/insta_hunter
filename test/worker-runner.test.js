import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { runWorkerSlot } from '../src/jobs/runner.js';

function logger() {
  const entries = [];
  const target = {
    entries,
    child: () => target,
    info: (...args) => entries.push(['info', ...args]),
    warn: (...args) => entries.push(['warn', ...args]),
    error: (...args) => entries.push(['error', ...args])
  };
  return target;
}

function queuedJob(id, jobType = 'fixture') {
  return {
    id,
    job_type: jobType,
    account_id: 1,
    pipeline_run_id: 2,
    locked_by: 'worker:0',
    current_attempt_id: id,
    attempts: 1,
    max_attempts: 3
  };
}

describe('worker slot supervisor', () => {
  test('retries after a reservation failure and survives pipeline advancement failure', async () => {
    let stopping = false;
    let reservations = 0;
    let handled = 0;
    let advancementAttempts = 0;
    const log = logger();
    await runWorkerSlot({
      slot: 0,
      workerId: 'worker',
      context: { pool: {}, logger: log },
      handlers: { fixture: async () => { handled += 1; return { ok: true }; } },
      shouldStop: () => stopping,
      dependencies: {
        reserveJob: async () => {
          reservations += 1;
          if (reservations === 1) throw new Error('temporary database outage');
          return queuedJob(1);
        },
        completeJob: async () => { stopping = true; return true; },
        maybeAdvancePipeline: async () => {
          advancementAttempts += 1;
          if (advancementAttempts === 1) throw new Error('temporary pipeline lock failure');
        },
        heartbeatJob: async () => true,
        delay: async () => {}
      }
    });

    assert.equal(reservations, 2);
    assert.equal(handled, 1);
    assert.equal(advancementAttempts, 2);
    assert.ok(log.entries.some((entry) => String(entry.at(-1)).includes('slot will retry')));
    assert.ok(log.entries.some((entry) => String(entry.at(-1)).includes('pipeline advancement failed')));
  });

  test('continues reserving work when persisting a job failure temporarily fails', async () => {
    let stopping = false;
    const jobs = [queuedJob(1, 'broken'), queuedJob(2, 'fixture')];
    const completed = [];
    let failureUpdates = 0;
    const log = logger();
    await runWorkerSlot({
      slot: 0,
      workerId: 'worker',
      context: { pool: {}, logger: log },
      handlers: {
        broken: async () => { throw new Error('provider failed'); },
        fixture: async (job) => ({ id: job.id })
      },
      shouldStop: () => stopping,
      dependencies: {
        reserveJob: async () => jobs.shift(),
        failJob: async () => {
          failureUpdates += 1;
          if (failureUpdates === 1) throw new Error('database write failed');
          return true;
        },
        completeJob: async (_pool, job) => {
          completed.push(job.id);
          stopping = true;
          return true;
        },
        maybeAdvancePipeline: async () => {},
        heartbeatJob: async () => true,
        delay: async () => {}
      }
    });

    assert.deepEqual(completed, [2]);
    assert.equal(failureUpdates, 2);
    assert.ok(log.entries.some((entry) => String(entry.at(-1)).includes('job failure update failed')));
  });
});
