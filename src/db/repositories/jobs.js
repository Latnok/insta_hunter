export async function enqueueJob(client, job) {
  const result = await client.query(`
    insert into jobs(
      pipeline_run_id, discovery_run_id, account_id, reel_id, job_type,
      priority, payload, dedupe_key, max_attempts
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict (dedupe_key) do update set updated_at = jobs.updated_at
    returning *
  `, [
    job.pipelineRunId || null, job.discoveryRunId || null, job.accountId || null,
    job.reelId || null, job.jobType, job.priority || 0, job.payload || {},
    job.dedupeKey, job.maxAttempts || 3
  ]);
  return result.rows[0];
}

export async function reserveJob(pool, workerId) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query(`
      select * from jobs
      where status in ('pending','retry_wait') and available_at <= now()
      order by priority desc, created_at
      for update skip locked limit 1
    `);
    if (!result.rowCount) {
      await client.query('commit');
      return null;
    }
    const job = result.rows[0];
    const attempt = job.attempts + 1;
    const updated = await client.query(`
      update jobs set status='running', attempts=$2, locked_by=$3, locked_at=now(), heartbeat_at=now(),
                      started_at=coalesce(started_at, now()), updated_at=now()
      where id=$1 returning *
    `, [job.id, attempt, workerId]);
    await client.query(`
      insert into job_attempts(job_id, attempt_number, outcome) values ($1,$2,'running')
    `, [job.id, attempt]);
    await client.query('commit');
    return updated.rows[0];
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function completeJob(pool, jobId, result = {}) {
  await pool.query(`
    with updated_attempt as (
      update job_attempts set outcome='succeeded', finished_at=now()
      where job_id=$1 and outcome='running'
    )
    update jobs set status='succeeded', result=$2, error_summary=null, finished_at=now(), updated_at=now(),
                    locked_by=null, locked_at=null, heartbeat_at=null
    where id=$1
  `, [jobId, result]);
}

export async function failJob(pool, job, error) {
  const delays = [30, 120, 600];
  const final = job.attempts >= job.max_attempts;
  const delaySeconds = delays[Math.min(job.attempts - 1, delays.length - 1)];
  await pool.query(`
    with updated_attempt as (
      update job_attempts set outcome='failed', error_detail=$2, finished_at=now()
      where job_id=$1 and outcome='running'
    )
    update jobs set status=$3, error_summary=$2,
      available_at=case when $3='retry_wait' then now() + ($4 * interval '1 second') else available_at end,
      finished_at=case when $3='failed' then now() else null end,
      updated_at=now(), locked_by=null, locked_at=null, heartbeat_at=null
    where id=$1
  `, [job.id, String(error.message || error).slice(0, 2000), final ? 'failed' : 'retry_wait', delaySeconds]);
}

export async function heartbeatJob(pool, jobId, workerId) {
  await pool.query(`update jobs set heartbeat_at=now(), updated_at=now() where id=$1 and locked_by=$2 and status='running'`, [jobId, workerId]);
}

export async function recoverStaleJobs(pool, minutes = 10) {
  const result = await pool.query(`
    with stale_jobs as (
      update jobs set status='retry_wait', available_at=now(), locked_by=null, locked_at=null,
                      heartbeat_at=null, error_summary='worker lease expired', updated_at=now()
      where status='running' and coalesce(heartbeat_at, locked_at) < now() - ($1 * interval '1 minute')
      returning id
    ), closed_attempts as (
      update job_attempts set outcome='failed', error_detail='worker lease expired', finished_at=now()
      where outcome='running' and job_id in (select id from stale_jobs)
      returning job_id
    )
    select count(*)::int as recovered_count from stale_jobs
  `, [minutes]);
  return result.rows[0].recovered_count;
}

export async function listJobs(client, { status, jobType, limit = 50, offset = 0 }) {
  const params = [limit, offset];
  const where = [];
  if (status) { params.push(status); where.push(`j.status=$${params.length}`); }
  if (jobType) { params.push(jobType); where.push(`j.job_type=$${params.length}`); }
  const result = await client.query(`
    select j.*, a.username from jobs j
    left join instagram_accounts a on a.id=j.account_id
    ${where.length ? `where ${where.join(' and ')}` : ''}
    order by j.created_at desc limit $1 offset $2
  `, params);
  return result.rows;
}
