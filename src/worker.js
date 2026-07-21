import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config/index.js';
import { createPool } from './db/pool.js';
import { reserveJob, completeJob, failJob, recoverStaleJobs } from './db/repositories/jobs.js';
import { createInstagramProviders } from './providers/instagram.js';
import { createLlmClient } from './providers/llm.js';
import { createJobHandlers, maybeAdvancePipeline } from './jobs/handlers.js';
import { createLogger } from './lib/logger.js';

const config = loadConfig();
const logger = createLogger('worker');
const pool = createPool(config);
const workerId = `${os.hostname()}:${process.pid}`;
const context = { config, pool, logger, instagram: createInstagramProviders(config), llm: createLlmClient(config) };
const handlers = createJobHandlers(context);
let stopping = false;

await recoverStaleJobs(pool);
await pool.query(`
  insert into worker_heartbeats(worker_id,process_id,hostname) values ($1,$2,$3)
  on conflict(worker_id) do update set process_id=excluded.process_id,hostname=excluded.hostname,started_at=now(),heartbeat_at=now()
`, [workerId, process.pid, os.hostname()]);
const heartbeatTimer = setInterval(() => {
  pool.query(`update worker_heartbeats set heartbeat_at=now() where worker_id=$1`, [workerId]).catch((error) => logger.error({ err: error }, 'worker heartbeat failed'));
}, 15_000);
heartbeatTimer.unref();

async function loop(slot) {
  while (!stopping) {
    const job = await reserveJob(pool, `${workerId}:${slot}`);
    if (!job) { await delay(750); continue; }
    const log = logger.child({ jobId: job.id, jobType: job.job_type, accountId: job.account_id, slot });
    try {
      const handler = handlers[job.job_type];
      if (!handler) throw new Error(`No handler for ${job.job_type}`);
      const result = await handler(job);
      await completeJob(pool, job.id, result || {});
      log.info('job succeeded');
    } catch (error) {
      await failJob(pool, job, error);
      log.error({ err: error }, 'job failed');
    }
    await maybeAdvancePipeline(context, job.pipeline_run_id);
  }
}

logger.info({ workerId, concurrency: config.WORKER_CONCURRENCY }, 'worker started');
const loops = Array.from({ length: config.WORKER_CONCURRENCY }, (_, slot) => loop(slot));

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeatTimer);
  logger.info({ signal }, 'worker stopping');
  await Promise.allSettled(loops);
  await pool.query('delete from worker_heartbeats where worker_id=$1', [workerId]).catch(() => {});
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
