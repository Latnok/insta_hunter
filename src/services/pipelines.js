import { withTransaction } from '../db/pool.js';
import { enqueueJob } from '../db/repositories/jobs.js';

export async function startPipeline(pool, config, { accountId, runType, reelsLimit, forceRefresh = false }) {
  return withTransaction(pool, (client) => startPipelineInTransaction(client, config, {
    accountId, runType, reelsLimit, forceRefresh
  }));
}

export async function startPipelineInTransaction(client, config, { accountId, runType, reelsLimit, forceRefresh = false }) {
  const limit = Number(reelsLimit || config.REELS_DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > config.REELS_MAX_LIMIT) {
    throw Object.assign(new Error(`reelsLimit must be between 1 and ${config.REELS_MAX_LIMIT}`), { statusCode: 400 });
  }
  const accountResult = await client.query('select * from instagram_accounts where id=$1 for update', [accountId]);
  const account = accountResult.rows[0];
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  if (account.lifecycle_status === 'archived') throw Object.assign(new Error('Archived accounts cannot be processed'), { statusCode: 409 });
  if (runType === 'candidate_enrichment' && account.lifecycle_status !== 'candidate') {
    throw Object.assign(new Error('Only candidates can run candidate enrichment'), { statusCode: 409 });
  }
  if (runType === 'blogger_refresh' && account.lifecycle_status !== 'approved') {
    throw Object.assign(new Error('Only approved bloggers can be refreshed'), { statusCode: 409 });
  }
  const active = await client.query(`
    select * from pipeline_runs where account_id=$1 and run_type=$2 and status in ('pending','running') limit 1
  `, [accountId, runType]);
  if (active.rowCount) return { run: active.rows[0], existing: true };
  const runResult = await client.query(`
    insert into pipeline_runs(account_id, run_type, reels_limit, force_refresh)
    values ($1,$2,$3,$4) returning *
  `, [accountId, runType, limit, forceRefresh]);
  const run = runResult.rows[0];
  const suffix = forceRefresh ? ':force' : '';
  await enqueueJob(client, {
    pipelineRunId: run.id, accountId, jobType: 'fetch_profile',
    payload: { forceRefresh }, dedupeKey: `run:${run.id}:profile${suffix}`, maxAttempts: config.JOB_MAX_ATTEMPTS
  });
  await enqueueJob(client, {
    pipelineRunId: run.id, accountId, jobType: 'fetch_reels',
    payload: { forceRefresh, reelsLimit: limit }, dedupeKey: `run:${run.id}:reels${suffix}`, maxAttempts: config.JOB_MAX_ATTEMPTS
  });
  return { run, existing: false };
}
