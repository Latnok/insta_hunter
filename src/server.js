import { loadConfig } from './config/index.js';
import { createPool } from './db/pool.js';
import { createLogger } from './lib/logger.js';
import { createApp } from './app.js';

const config = loadConfig();
const logger = createLogger('web');
const pool = createPool(config);
const app = createApp({ config, pool, logger });
const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'web listening'));

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
