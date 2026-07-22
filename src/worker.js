import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config/index.js';
import { createPool } from './db/pool.js';
import { recoverStaleJobs } from './db/repositories/jobs.js';
import { createInstagramProviders } from './providers/instagram.js';
import { createLlmClient } from './providers/llm.js';
import { createJobHandlers } from './jobs/handlers.js';
import { runWorkerSlot } from './jobs/runner.js';
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
  pool.query(`update worker_heartbeats set heartbeat_at=now() where worker_id=$1 or worker_id like $2`, [workerId, `${workerId}:slot:%`])
    .catch((error) => logger.error({ err: error }, 'worker heartbeat failed'));
}, 15_000);
heartbeatTimer.unref();

async function superviseSlot(slot) {
  const slotWorkerId = `${workerId}:slot:${slot}`;
  while (!stopping) {
    try {
      await pool.query(`
        insert into worker_heartbeats(worker_id,process_id,hostname) values ($1,$2,$3)
        on conflict(worker_id) do update set process_id=excluded.process_id,hostname=excluded.hostname,started_at=now(),heartbeat_at=now()
      `, [slotWorkerId, process.pid, os.hostname()]);
      await runWorkerSlot({ slot, workerId, context, handlers, shouldStop: () => stopping });
    } catch (error) {
      logger.error({ err: error, slot }, 'worker slot stopped unexpectedly; restarting');
      if (!stopping) await delay(1_000);
    }
  }
}

logger.info({ workerId, concurrency: config.WORKER_CONCURRENCY }, 'worker started');
const loops = Array.from({ length: config.WORKER_CONCURRENCY }, (_, slot) => superviseSlot(slot));

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeatTimer);
  logger.info({ signal }, 'worker stopping');
  await Promise.allSettled(loops);
  await pool.query('delete from worker_heartbeats where worker_id=$1 or worker_id like $2', [workerId, `${workerId}:slot:%`]).catch(() => {});
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
