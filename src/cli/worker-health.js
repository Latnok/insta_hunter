import os from 'node:os';
import { loadConfig } from '../config/index.js';
import { createPool } from '../db/pool.js';

const config = loadConfig();
const pool = createPool(config);
try {
  const result = await pool.query(`
    select count(*)::int as active_slots from worker_heartbeats
    where hostname=$1 and worker_id like '%:slot:%'
      and heartbeat_at > now() - interval '45 seconds'
  `, [os.hostname()]);
  process.exitCode = result.rows[0].active_slots >= config.WORKER_CONCURRENCY ? 0 : 1;
} finally {
  await pool.end();
}
