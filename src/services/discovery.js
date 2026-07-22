import { withTransaction } from '../db/pool.js';
import { enqueueJob } from '../db/repositories/jobs.js';

export async function enqueueDiscoveryRun(client, config, { query, limit, createdBy = 'admin', priority = 0, dedupeKey }) {
  const cleanQuery = String(query || '').trim();
  const cleanLimit = Number(limit || config.DISCOVERY_DEFAULT_LIMIT);
  if (cleanQuery.length < 2 || cleanQuery.length > 200) throw Object.assign(new Error('Search query must contain 2–200 characters'), { statusCode: 400 });
  if (!Number.isInteger(cleanLimit) || cleanLimit < 1 || cleanLimit > config.DISCOVERY_MAX_LIMIT) {
    throw Object.assign(new Error(`Limit must be between 1 and ${config.DISCOVERY_MAX_LIMIT}`), { statusCode: 400 });
  }
  const result = await client.query(`
    insert into discovery_runs(query, requested_limit, created_by) values ($1,$2,$3) returning *
  `, [cleanQuery, cleanLimit, createdBy]);
  const run = result.rows[0];
  await enqueueJob(client, {
    discoveryRunId: run.id,
    jobType: 'discover_accounts',
    priority,
    payload: { query: cleanQuery, limit: cleanLimit, trigger: createdBy },
    dedupeKey: dedupeKey || `discovery:${run.id}`,
    maxAttempts: config.JOB_MAX_ATTEMPTS
  });
  return run;
}

export async function createDiscoveryRun(pool, config, options) {
  return withTransaction(pool, (client) => enqueueDiscoveryRun(client, config, options));
}
