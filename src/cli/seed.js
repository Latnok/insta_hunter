import { loadConfig } from '../config/index.js';
import { createPool } from '../db/pool.js';
import { initializeSchema } from '../db/schema.js';
import { seed } from '../db/seed.js';
import { createLogger } from '../lib/logger.js';

const config = loadConfig();
const logger = createLogger('seed');
const pool = createPool(config);
try {
  await initializeSchema(pool, { logger });
  logger.info(await seed(pool), 'seed complete');
} finally {
  await pool.end();
}
