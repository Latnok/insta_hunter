import { withTransaction } from '../db/pool.js';

const activeJobStatuses = "('pending','running','retry_wait')";

async function cancelMatchingJobs(client, whereSql, parameters, reason) {
  const result = await client.query(`
    with targets as (
      select id, current_attempt_id from jobs
      where ${whereSql} and status in ${activeJobStatuses}
      for update
    ), closed_attempts as (
      update job_attempts set outcome='failed', error_detail=$${parameters.length + 1}, finished_at=now()
      where outcome='running' and id in (select current_attempt_id from targets)
    )
    update jobs set status='cancelled', error_summary=$${parameters.length + 1}, finished_at=now(),
      locked_by=null, locked_at=null, heartbeat_at=null, current_attempt_id=null, updated_at=now()
    where id in (select id from targets)
    returning id
  `, [...parameters, reason]);
  return result.rowCount;
}

export async function cancelAccountWork(client, accountId, reason) {
  const runs = await client.query(`
    update pipeline_runs set status='cancelled', error_summary=$2, finished_at=now()
    where account_id=$1 and status in ('pending','running')
    returning id
  `, [accountId, reason]);
  const jobs = await cancelMatchingJobs(client, 'account_id=$1', [accountId], reason);
  return { pipelines: runs.rowCount, jobs };
}

export async function cancelPipelineWork(client, pipelineRunId, reason) {
  const run = await client.query(`
    update pipeline_runs set status='cancelled', error_summary=$2, finished_at=now()
    where id=$1 and status in ('pending','running')
    returning id
  `, [pipelineRunId, reason]);
  const jobs = await cancelMatchingJobs(client, 'pipeline_run_id=$1', [pipelineRunId], reason);
  return { pipelines: run.rowCount, jobs };
}

async function lockJobContext(client, jobId) {
  const preview = (await client.query(
    'select account_id,pipeline_run_id,discovery_run_id from jobs where id=$1',
    [jobId]
  )).rows[0];
  if (!preview) throw Object.assign(new Error('Job not found'), { statusCode: 404 });
  if (preview.account_id) {
    await client.query('select id from instagram_accounts where id=$1 for update', [preview.account_id]);
  }
  if (preview.pipeline_run_id) {
    await client.query('select id from pipeline_runs where id=$1 for update', [preview.pipeline_run_id]);
  }
  if (preview.discovery_run_id) {
    await client.query('select id from discovery_runs where id=$1 for update', [preview.discovery_run_id]);
  }
  const selected = await client.query(`
    select j.*, p.status as pipeline_status, p.run_type, d.status as discovery_status, a.lifecycle_status
    from jobs j
    left join pipeline_runs p on p.id=j.pipeline_run_id
    left join discovery_runs d on d.id=j.discovery_run_id
    left join instagram_accounts a on a.id=j.account_id
    where j.id=$1
    for update of j
  `, [jobId]);
  return selected.rows[0];
}

export async function cancelJob(pool, jobId) {
  return withTransaction(pool, async (client) => {
    const job = await lockJobContext(client, jobId);
    if (!['pending', 'running', 'retry_wait'].includes(job.status)) {
      throw Object.assign(new Error('Only active jobs can be cancelled'), { statusCode: 409 });
    }
    if (job.pipeline_run_id) {
      await cancelPipelineWork(client, job.pipeline_run_id, 'cancelled manually');
    } else {
      await cancelMatchingJobs(client, 'id=$1', [job.id], 'cancelled manually');
    }
    return job;
  });
}

export async function retryJob(pool, jobId) {
  return withTransaction(pool, async (client) => {
    const job = await lockJobContext(client, jobId);
    if (job.status !== 'failed') throw Object.assign(new Error('Only failed jobs can be retried'), { statusCode: 409 });
    if (job.attempts >= 10) throw Object.assign(new Error('Manual retry budget is exhausted'), { statusCode: 409 });
    if (['rejected', 'archived'].includes(job.lifecycle_status)) {
      throw Object.assign(new Error('Jobs for rejected or archived accounts cannot be retried'), { statusCode: 409 });
    }
    if (job.pipeline_run_id) {
      if (job.pipeline_status === 'cancelled') {
        throw Object.assign(new Error('Cancelled pipelines cannot be retried'), { statusCode: 409 });
      }
      const expected = job.run_type === 'candidate_enrichment' ? 'candidate' : 'approved';
      if (job.lifecycle_status !== expected) {
        throw Object.assign(new Error('Account lifecycle no longer matches this pipeline'), { statusCode: 409 });
      }
      await client.query(`
        update pipeline_runs set status='running', error_summary=null, finished_at=null,
          started_at=coalesce(started_at,now()) where id=$1
      `, [job.pipeline_run_id]);
    }
    if (job.discovery_run_id) {
      if (job.discovery_status === 'cancelled') {
        throw Object.assign(new Error('Cancelled discovery runs cannot be retried'), { statusCode: 409 });
      }
      await client.query(`
        update discovery_runs set status='running', error_summary=null, finished_at=null,
          started_at=coalesce(started_at,now()) where id=$1
      `, [job.discovery_run_id]);
    }
    const retried = await client.query(`
      update jobs set status='retry_wait', available_at=now(),
        max_attempts=least(10, greatest(max_attempts, attempts+3)),
        error_summary=null, finished_at=null, updated_at=now()
      where id=$1 returning *
    `, [job.id]);
    return retried.rows[0];
  });
}
