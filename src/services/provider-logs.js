import { redactSensitive } from '../lib/redact.js';

function fallbackAttempt({ result, error, provider }) {
  if (result) return [{ provider: result.provider || provider, outcome: 'succeeded', meta: result.requestMeta }];
  return [{
    provider,
    outcome: 'failed',
    meta: error?.requestMeta || { status: error?.statusCode, durationMs: error?.durationMs },
    error: error && { message: error.message, response: error.responseData }
  }];
}

export async function logProviderCalls(pool, { operation, job, result, error, provider = 'unknown' }) {
  const attempts = result?.providerAttempts || error?.providerAttempts || fallbackAttempt({ result, error, provider });
  for (const attempt of attempts) {
    const meta = attempt.meta || {};
    const attemptError = attempt.error;
    await pool.query(`
      insert into provider_call_logs(
        provider,operation,account_id,reel_id,job_id,http_status,
        provider_request_id,duration_ms,outcome,error_payload
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      attempt.provider || provider,
      operation,
      job.account_id || null,
      job.reel_id || null,
      job.id,
      meta.status ?? attemptError?.statusCode ?? null,
      meta.requestId || null,
      meta.durationMs == null ? null : Math.round(meta.durationMs),
      attempt.outcome,
      attemptError ? redactSensitive(attemptError) : null
    ]);
  }
}
