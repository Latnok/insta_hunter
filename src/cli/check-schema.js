import { loadConfig } from '../config/index.js';
import { createPool } from '../db/pool.js';
import { getSchemaStatus } from '../db/schema.js';
import { createLogger } from '../lib/logger.js';

const config = loadConfig();
const logger = createLogger('schema-check');
const pool = createPool(config);

try {
  const status = await getSchemaStatus(pool);
  if (!status.compatible) {
    logger.error(status, 'database schema is incompatible');
    process.exitCode = 1;
  } else {
    logger.info(status, 'database schema is compatible');
  }
} finally {
  await pool.end();
}
