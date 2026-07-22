import { withTransaction } from '../db/pool.js';
import { enqueueJob } from '../db/repositories/jobs.js';
import { resolveCriteriaAutomation, uniqueSearchQueries } from '../domain/criteria-automation.js';
import { enqueueDiscoveryRun } from './discovery.js';

const automationLockKey = 424243;

export async function enqueueCriteriaProposal(client, config, {
  criteriaVersionId,
  trigger = 'manual',
  decisionCount = 0,
  dedupeKey
}) {
  return enqueueJob(client, {
    jobType: 'propose_criteria',
    priority: trigger === 'manual' ? 0 : -5,
    payload: { criteriaVersionId, trigger, decisionCount },
    dedupeKey,
    maxAttempts: config.JOB_MAX_ATTEMPTS || 3
  });
}

export async function scheduleCriteriaProposalIfDue(client, config) {
  await client.query('select pg_advisory_xact_lock($1)', [automationLockKey]);
  const active = (await client.query(`select * from criteria_versions where status='active' limit 1`)).rows[0];
  if (!active) return { queued: false, reason: 'no_active_criteria' };
  const settings = resolveCriteriaAutomation(active.transcript_rules);
  if (!settings.criteriaEnabled) return { queued: false, reason: 'disabled' };

  const last = (await client.query(`
    select created_at from jobs
    where job_type='propose_criteria' and payload->>'criteriaVersionId'=$1
      and payload->>'trigger' like 'automatic_%'
    order by created_at desc limit 1
  `, [String(active.id)])).rows[0];
  const cutoff = last?.created_at || active.activated_at || active.created_at;
  const decisions = (await client.query(`
    select count(*)::int as count, max(id)::text as last_id
    from audit_events
    where entity_type='instagram_account'
      and action in ('approved','rejected')
      and old_values->>'lifecycle_status'='candidate'
      and created_at > $1
  `, [cutoff])).rows[0];
  if (!decisions.count) return { queued: false, reason: 'no_new_decisions' };

  const elapsedHours = (Date.now() - new Date(cutoff).getTime()) / 3_600_000;
  const thresholdDue = decisions.count >= settings.decisionThreshold;
  const refreshDue = elapsedHours >= settings.refreshHours;
  if (!thresholdDue && !refreshDue) {
    return { queued: false, reason: 'not_due', decisionCount: decisions.count };
  }
  const trigger = thresholdDue ? 'automatic_threshold' : 'automatic_refresh';
  const job = await enqueueCriteriaProposal(client, config, {
    criteriaVersionId: active.id,
    trigger,
    decisionCount: decisions.count,
    dedupeKey: `criteria-auto:${active.id}:${decisions.last_id}`
  });
  return { queued: true, jobId: job.id, trigger, decisionCount: decisions.count };
}

async function scheduleAutomaticDiscovery(client, config) {
  await client.query('select pg_advisory_xact_lock($1)', [automationLockKey]);
  const active = (await client.query(`select * from criteria_versions where status='active' limit 1`)).rows[0];
  if (!active) return { queued: 0, reason: 'no_active_criteria' };
  const settings = resolveCriteriaAutomation(active.transcript_rules);
  if (!settings.discoveryEnabled) return { queued: 0, reason: 'disabled' };
  const queries = uniqueSearchQueries(active.search_queries);
  if (!queries.length) return { queued: 0, reason: 'no_queries' };

  const usage = (await client.query(`
    select coalesce(sum(requested_limit),0)::int as used
    from discovery_runs
    where created_by='automation' and created_at >= date_trunc('day', now())
  `)).rows[0].used;
  let remaining = settings.dailyDiscoveryLimit - usage;
  if (remaining <= 0) return { queued: 0, reason: 'daily_limit' };

  const day = new Date().toISOString().slice(0, 10);
  let queued = 0;
  for (let index = 0; index < queries.length && remaining > 0; index += 1) {
    const limit = Math.min(settings.perQueryLimit, remaining, config.DISCOVERY_MAX_LIMIT);
    const dedupeKey = `auto-discovery:${day}:${active.id}:${index}`;
    const existing = await client.query('select 1 from jobs where dedupe_key=$1', [dedupeKey]);
    if (existing.rowCount) continue;
    await enqueueDiscoveryRun(client, config, {
      query: queries[index], limit, createdBy: 'automation', priority: -10, dedupeKey
    });
    queued += 1;
    remaining -= limit;
  }
  return { queued, remaining };
}

export async function runAutomationCycle(pool, config) {
  return withTransaction(pool, async (client) => ({
    criteria: await scheduleCriteriaProposalIfDue(client, config),
    discovery: await scheduleAutomaticDiscovery(client, config)
  }));
}
