import { loadConfig } from '../config/index.js';
import { createPool } from '../db/pool.js';

const config = loadConfig();
const pool = createPool(config);
try {
  const result = await pool.query(`select 1 from worker_heartbeats where heartbeat_at > now() - interval '45 seconds' limit 1`);
  process.exitCode = result.rowCount ? 0 : 1;
} finally {
  await pool.end();
}
