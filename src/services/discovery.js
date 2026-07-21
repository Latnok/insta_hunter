import { withTransaction } from '../db/pool.js';
import { enqueueJob } from '../db/repositories/jobs.js';

export async function createDiscoveryRun(pool, config, { query, limit }) {
  const cleanQuery = String(query || '').trim();
  const cleanLimit = Number(limit || config.DISCOVERY_DEFAULT_LIMIT);
  if (cleanQuery.length < 2 || cleanQuery.length > 200) throw Object.assign(new Error('Search query must contain 2–200 characters'), { statusCode: 400 });
  if (!Number.isInteger(cleanLimit) || cleanLimit < 1 || cleanLimit > config.DISCOVERY_MAX_LIMIT) {
    throw Object.assign(new Error(`Limit must be between 1 and ${config.DISCOVERY_MAX_LIMIT}`), { statusCode: 400 });
  }
  return withTransaction(pool, async (client) => {
    const result = await client.query(`insert into discovery_runs(query, requested_limit) values ($1,$2) returning *`, [cleanQuery, cleanLimit]);
    const run = result.rows[0];
    await enqueueJob(client, {
      discoveryRunId: run.id,
      jobType: 'discover_accounts',
      payload: { query: cleanQuery, limit: cleanLimit },
      dedupeKey: `discovery:${run.id}`,
      maxAttempts: config.JOB_MAX_ATTEMPTS
    });
    return run;
  });
}
