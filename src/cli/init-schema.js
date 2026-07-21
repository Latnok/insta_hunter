import { loadConfig } from '../config/index.js';
import { createPool } from '../db/pool.js';
import { initializeSchema } from '../db/schema.js';
import { createLogger } from '../lib/logger.js';

const config = loadConfig();
const logger = createLogger('schema');
const pool = createPool(config);

try {
  await initializeSchema(pool, { logger });
  logger.info('schema ready');
} finally {
  await pool.end();
}
