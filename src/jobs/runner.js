import { setTimeout as delay } from 'node:timers/promises';
import {
  completeJob,
  failJob,
  heartbeatJob,
  reserveJob
} from '../db/repositories/jobs.js';
import { maybeAdvancePipeline } from './handlers.js';

const defaultDependencies = {
  reserveJob,
  completeJob,
  failJob,
  heartbeatJob,
  maybeAdvancePipeline,
  delay
};

export async function runWorkerSlot({
  slot,
  workerId,
  context,
  handlers,
  shouldStop,
  dependencies = {},
  pollDelayMs = 750,
  errorBackoffMs = 1_000
}) {
  const deps = { ...defaultDependencies, ...dependencies };
  let consecutiveInfrastructureFailures = 0;

  while (!shouldStop()) {
    let job;
    try {
      job = await deps.reserveJob(context.pool, `${workerId}:${slot}`);
      consecutiveInfrastructureFailures = 0;
    } catch (error) {
      consecutiveInfrastructureFailures += 1;
      context.logger.error({ err: error, slot }, 'job reservation failed; slot will retry');
      await deps.delay(backoff(errorBackoffMs, consecutiveInfrastructureFailures));
      continue;
    }

    if (!job) {
      await deps.delay(pollDelayMs);
      continue;
    }

    await processJob({ job, slot, context, handlers, deps });
  }
}

async function processJob({ job, slot, context, handlers, deps }) {
  const log = context.logger.child({
    jobId: job.id,
    jobType: job.job_type,
    accountId: job.account_id,
    slot
  });
  let heartbeatBusy = false;
  const jobHeartbeatTimer = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      if (!await deps.heartbeatJob(context.pool, job)) log.warn('job lease heartbeat rejected');
    } catch (error) {
      log.error({ err: error }, 'job lease heartbeat failed');
    } finally {
      heartbeatBusy = false;
    }
  }, 30_000);
  jobHeartbeatTimer.unref();

  let transitioned = false;
  try {
    const handler = handlers[job.job_type];
    if (!handler) throw new Error(`No handler for ${job.job_type}`);
    const result = await handler(job);
    transitioned = await persistTerminalUpdate({
      operation: () => deps.completeJob(context.pool, job, result || {}),
      deps,
      log,
      failureMessage: 'job completion update failed'
    });
    if (transitioned) log.info('job succeeded');
    else log.warn('job result discarded because lease ownership changed');
  } catch (error) {
    transitioned = await persistTerminalUpdate({
      operation: () => deps.failJob(context.pool, job, error),
      deps,
      log,
      failureMessage: 'job failure update failed',
      jobError: error
    });
    if (transitioned) log.error({ err: error }, 'job failed');
    else log.warn({ err: error }, 'job failure discarded because lease ownership changed');
  } finally {
    clearInterval(jobHeartbeatTimer);
  }

  if (!transitioned || !job.pipeline_run_id) return;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await deps.maybeAdvancePipeline(context, job.pipeline_run_id);
      return;
    } catch (error) {
      log.error({ err: error, attempt }, 'pipeline advancement failed');
      if (attempt < 3) await deps.delay(backoff(250, attempt));
    }
  }
  log.error('pipeline advancement retries exhausted; slot will continue');
}

async function persistTerminalUpdate({ operation, deps, log, failureMessage, jobError }) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      log.error({ err: error, jobError, attempt }, failureMessage);
      if (attempt < 3) await deps.delay(backoff(250, attempt));
    }
  }
  log.error(`${failureMessage}; retries exhausted and lease recovery is required`);
  return false;
}

function backoff(baseMs, failureCount) {
  return Math.min(baseMs * (2 ** Math.min(failureCount - 1, 5)), 30_000);
}
