import { withTransaction } from '../db/pool.js';
import { upsertAccount } from '../db/repositories/accounts.js';
import { enqueueJob } from '../db/repositories/jobs.js';
import { isStale } from '../domain/accounts.js';
import { classifyTranscript, validateTranscriptRules } from '../domain/transcripts.js';
import { transcribeWithGroq } from '../providers/groq.js';
import { cancelPipelineWork } from '../services/jobs.js';
import { createCriteriaDraft } from '../services/criteria.js';

async function logProvider(pool, { provider, operation, job, meta, outcome, error }) {
  await pool.query(`
    insert into provider_call_logs(provider,operation,account_id,reel_id,job_id,http_status,provider_request_id,duration_ms,outcome,error_payload)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [provider, operation, job.account_id, job.reel_id, job.id, meta?.status || error?.statusCode || null,
    meta?.requestId || error?.requestMeta?.requestId || null, meta?.durationMs || error?.durationMs || null,
    outcome, error ? { message: error.message, providers: error.fallbackErrors, response: error.responseData } : null]);
}

async function assertActivePipeline(client, job) {
  if (!job.pipeline_run_id) return;
  const account = (await client.query(
    'select lifecycle_status from instagram_accounts where id=$1 for update',
    [job.account_id]
  )).rows[0];
  const run = (await client.query(
    'select status,run_type from pipeline_runs where id=$1 and account_id=$2 for update',
    [job.pipeline_run_id, job.account_id]
  )).rows[0];
  const expectedLifecycle = run?.run_type === 'candidate_enrichment' ? 'candidate' : 'approved';
  if (!account || !run || !['pending', 'running'].includes(run.status) || account.lifecycle_status !== expectedLifecycle) {
    throw new Error('Pipeline is no longer active for this account lifecycle');
  }
}

async function handleDiscovery(context, job) {
  const { pool, instagram } = context;
  const { query, limit } = job.payload;
  await pool.query(`
    update discovery_runs set status='running', error_summary=null, finished_at=null,
      started_at=coalesce(started_at,now()) where id=$1
  `, [job.discovery_run_id]);
  try {
    const result = await instagram.search(query, limit, { signal: context.signal });
    await logProvider(pool, { provider: result.provider, operation: 'search', job, meta: result.requestMeta, outcome: 'succeeded' });
    const counts = { found: result.items.length, created: 0, existing: 0, invalid: 0 };
    await withTransaction(pool, async (client) => {
      for (const item of result.items.slice(0, limit)) {
        try {
          const account = await upsertAccount(client, {
            input: item.username, sourceType: 'discovery', discoveryRunId: job.discovery_run_id, searchQuery: query
          });
          account.inserted ? counts.created++ : counts.existing++;
        } catch { counts.invalid++; }
      }
      await client.query(`
        update discovery_runs set status='succeeded', found_count=$2, created_count=$3,
          existing_count=$4, invalid_count=$5, error_summary=null, finished_at=now() where id=$1
      `, [job.discovery_run_id, counts.found, counts.created, counts.existing, counts.invalid]);
    });
    return counts;
  } catch (error) {
    await logProvider(pool, { provider: 'instagram-fallback', operation: 'search', job, outcome: 'failed', error });
    await pool.query(`update discovery_runs set status='failed', error_summary=$2, finished_at=now() where id=$1`, [job.discovery_run_id, error.message]);
    throw error;
  }
}

async function handleProfile(context, job) {
  const { pool, instagram, config } = context;
  const accountResult = await pool.query(`
    select a.*, p.fetched_at from instagram_accounts a left join account_profiles p on p.account_id=a.id where a.id=$1
  `, [job.account_id]);
  const account = accountResult.rows[0];
  if (!account) throw new Error('Account not found');
  if (!job.payload.forceRefresh && account.fetched_at && !isStale(account.fetched_at, config.freshnessMs)) return { cached: true };
  try {
    const result = await instagram.profile(account.username, { signal: context.signal });
    await logProvider(pool, { provider: result.provider, operation: 'profile', job, meta: result.requestMeta, outcome: 'succeeded' });
    const p = result.profile;
    await withTransaction(pool, async (client) => {
      await assertActivePipeline(client, job);
      await client.query(`
        insert into account_profiles(
          account_id,instagram_id,username,display_name,bio,avatar_url,external_url,followers,following,posts_count,
          verified,is_private,engagement_rate,language,content_category,profile_status,provider,raw_payload,fetched_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'available',$16,$17,now())
        on conflict(account_id) do update set instagram_id=excluded.instagram_id,username=excluded.username,
          display_name=excluded.display_name,bio=excluded.bio,avatar_url=excluded.avatar_url,external_url=excluded.external_url,
          followers=excluded.followers,following=excluded.following,posts_count=excluded.posts_count,verified=excluded.verified,
          is_private=excluded.is_private,engagement_rate=excluded.engagement_rate,language=excluded.language,
          content_category=excluded.content_category,profile_status='available',provider=excluded.provider,
          unavailable_reason=null,raw_payload=excluded.raw_payload,fetched_at=now(),updated_at=now()
      `, [job.account_id,p.instagramId,p.username,p.displayName,p.bio,p.avatarUrl,p.externalUrl,p.followers,p.following,p.postsCount,p.verified,p.isPrivate,p.engagementRate,p.language,p.contentCategory,result.provider,result.rawPayload]);
    });
    return { provider: result.provider };
  } catch (error) {
    await logProvider(pool, { provider: 'instagram-fallback', operation: 'profile', job, outcome: 'failed', error });
    throw error;
  }
}

async function upsertReel(client, accountId, item) {
  const existing = await client.query(`
    select * from reels where (instagram_media_id is not null and instagram_media_id=$1)
       or (shortcode is not null and shortcode=$2) limit 1
  `, [item.instagramMediaId, item.shortcode]);
  if (existing.rowCount) {
    const result = await client.query(`
      update reels set account_id=$2,reel_url=$3,caption=$4,published_at=$5,play_count=$6,like_count=$7,
        comment_count=$8,thumbnail_url=$9,media_url=$10,provider=$11,raw_payload=$12,fetched_at=now(),updated_at=now()
      where id=$1 returning *
    `, [existing.rows[0].id,accountId,item.reelUrl,item.caption,item.publishedAt,item.playCount,item.likeCount,item.commentCount,item.thumbnailUrl,item.mediaUrl,item.provider,item.rawPayload]);
    return result.rows[0];
  }
  const result = await client.query(`
    insert into reels(account_id,instagram_media_id,shortcode,reel_url,caption,published_at,play_count,like_count,
      comment_count,thumbnail_url,media_url,provider,raw_payload,fetched_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()) returning *
  `, [accountId,item.instagramMediaId,item.shortcode,item.reelUrl,item.caption,item.publishedAt,item.playCount,item.likeCount,item.commentCount,item.thumbnailUrl,item.mediaUrl,item.provider,item.rawPayload]);
  return result.rows[0];
}

async function handleReels(context, job) {
  const { pool, instagram, config } = context;
  const account = (await pool.query('select * from instagram_accounts where id=$1', [job.account_id])).rows[0];
  if (!account) throw new Error('Account not found');
  if (!job.payload.forceRefresh) {
    const latest = await pool.query('select max(fetched_at) as fetched_at from reels where account_id=$1', [job.account_id]);
    if (latest.rows[0].fetched_at && !isStale(latest.rows[0].fetched_at, config.freshnessMs)) return { cached: true };
  }
  try {
    const result = await instagram.reels(account.username, job.payload.reelsLimit, { signal: context.signal });
    await logProvider(pool, { provider: result.provider, operation: 'reels', job, meta: result.requestMeta, outcome: 'succeeded' });
    const saved = await withTransaction(pool, async (client) => {
      await assertActivePipeline(client, job);
      const rows = [];
      for (const item of result.items.slice(0, job.payload.reelsLimit)) {
        const reel = await upsertReel(client, job.account_id, item);
        rows.push(reel);
        const needsTranscript = job.payload.forceRefresh || !['available'].includes(reel.transcript_status);
        if (needsTranscript) await enqueueJob(client, {
          pipelineRunId: job.pipeline_run_id, accountId: job.account_id, reelId: reel.id,
          jobType: 'fetch_transcript', payload: { forceRefresh: job.payload.forceRefresh },
          dedupeKey: `run:${job.pipeline_run_id}:reel:${reel.id}:transcript${job.payload.forceRefresh ? ':force' : ''}`,
          maxAttempts: config.JOB_MAX_ATTEMPTS
        });
      }
      return rows;
    });
    return { provider: result.provider, saved: saved.length };
  } catch (error) {
    await logProvider(pool, { provider: 'instagram-fallback', operation: 'reels', job, outcome: 'failed', error });
    throw error;
  }
}

async function handleTranscript(context, job) {
  const { pool, instagram, config } = context;
  const reel = (await pool.query('select * from reels where id=$1', [job.reel_id])).rows[0];
  if (!reel) throw new Error('Reel not found');
  let result;
  try {
    result = await instagram.transcript(reel.reel_url, { signal: context.signal });
    await logProvider(pool, { provider: result.provider, operation: 'transcript', job, meta: result.requestMeta, outcome: 'succeeded' });
  } catch (providerError) {
    if (!reel.media_url) {
      await logProvider(pool, { provider: 'instagram-fallback', operation: 'transcript', job, outcome: 'failed', error: providerError });
      throw new Error(`Transcript providers failed and reel has no media URL: ${providerError.message}`);
    }
    result = await transcribeWithGroq(config, reel.media_url, { signal: context.signal });
    result.provider = 'groq-whisper';
    await logProvider(pool, { provider: result.provider, operation: 'transcript', job, meta: result.requestMeta, outcome: 'succeeded' });
  }
  await withTransaction(pool, async (client) => {
    await assertActivePipeline(client, job);
    await client.query(`
      update reels set transcript_status=$2,transcript_text=$3,transcript_source=$4,transcript_checked_at=now(),
        transcript_http_status=$5,transcript_error=null,updated_at=now() where id=$1
    `, [reel.id, result.text ? 'available' : 'empty', result.text, result.provider, result.requestMeta?.status || null]);
    await enqueueJob(client, {
      pipelineRunId: job.pipeline_run_id, accountId: job.account_id, reelId: reel.id,
      jobType: 'classify_transcript', payload: {}, dedupeKey: `run:${job.pipeline_run_id}:reel:${reel.id}:classify`,
      maxAttempts: config.JOB_MAX_ATTEMPTS
    });
  });
  return { source: result.provider, available: Boolean(result.text) };
}

async function handleClassify(context, job) {
  const { pool } = context;
  const result = await pool.query(`
    select r.transcript_text, c.transcript_rules from reels r
    cross join lateral (select transcript_rules from criteria_versions where status='active' limit 1) c
    where r.id=$1
  `, [job.reel_id]);
  if (!result.rowCount) throw new Error('Reel or active criteria not found');
  const classification = classifyTranscript(result.rows[0].transcript_text, result.rows[0].transcript_rules);
  await withTransaction(pool, async (client) => {
    await assertActivePipeline(client, job);
    await client.query(`update reels set transcript_quality=$2,transcript_quality_reason=$3,updated_at=now() where id=$1`, [job.reel_id, classification.quality, classification.reason]);
  });
  return classification;
}

async function saveFailedLlmLog(context, { purpose, jobId, accountId, criteria, messages, error, started }) {
  await context.pool.query(`
    insert into llm_logs(purpose,job_id,account_id,criteria_version_id,base_url,model,request_messages,status,error_detail,latency_ms)
    values ($1,$2,$3,$4,$5,$6,$7,'failed',$8,$9)
  `, [purpose, jobId || null, accountId || null, criteria?.id || null, context.config.LLM_BASE_URL, context.config.LLM_MODEL || 'not-configured', JSON.stringify(messages), error.message, Date.now() - started]);
}

async function handleEvaluation(context, job) {
  const { pool, llm, config } = context;
  const completed = await pool.query(`
    select l.parsed_response from evaluations e
    join llm_logs l on l.id=e.llm_log_id
    where e.job_id=$1 limit 1
  `, [job.id]);
  if (completed.rowCount) return completed.rows[0].parsed_response;
  const criteria = (await pool.query(`select * from criteria_versions where status='active' limit 1`)).rows[0];
  const account = (await pool.query(`
    select a.*, row_to_json(p.*) as profile from instagram_accounts a join account_profiles p on p.account_id=a.id
    where a.id=$1 and p.profile_status='available'
  `, [job.account_id])).rows[0];
  const reels = (await pool.query(`select * from reels where account_id=$1 and transcript_quality='useful' order by published_at desc nulls last limit 20`, [job.account_id])).rows;
  if (!criteria || !account || !reels.length) throw new Error('Candidate is not ready for evaluation');
  const messages = [
    { role: 'system', content: 'You evaluate Instagram clothing blogger candidates. Return only JSON matching the requested schema. Never make the final human decision.' },
    { role: 'user', content: JSON.stringify({ criteria: criteria.checklist_markdown, account: { username: account.username, profile: account.profile }, reels: reels.map((r) => ({ caption: r.caption, transcript: r.transcript_text, metrics: { plays: r.play_count, likes: r.like_count, comments: r.comment_count } })), output: { recommendation: 'recommended_approve | recommended_reject | needs_manual_review', confidence: 'integer 0..100', positive_signals: ['string'], negative_signals: ['string'], explanation: 'string' } }) }
  ];
  const started = Date.now();
  try {
    const result = await llm.evaluate(messages, { signal: context.signal });
    await withTransaction(pool, async (client) => {
      await assertActivePipeline(client, job);
      const log = await client.query(`
        insert into llm_logs(purpose,job_id,account_id,criteria_version_id,base_url,model,request_messages,raw_response,parsed_response,
          prompt_tokens,completion_tokens,latency_ms,status)
        values ('candidate_evaluation',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'succeeded') returning id
      `, [job.id,job.account_id,criteria.id,config.LLM_BASE_URL,config.LLM_MODEL,JSON.stringify(messages),result.rawResponse,result.parsed,result.usage.prompt_tokens || null,result.usage.completion_tokens || null,result.meta.durationMs]);
      await client.query(`
        insert into evaluations(account_id,criteria_version_id,recommendation,confidence,positive_signals,negative_signals,explanation,llm_log_id,job_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [job.account_id,criteria.id,result.parsed.recommendation,result.parsed.confidence,JSON.stringify(result.parsed.positive_signals),JSON.stringify(result.parsed.negative_signals),result.parsed.explanation,log.rows[0].id,job.id]);
    });
    return result.parsed;
  } catch (error) {
    await saveFailedLlmLog(context, { purpose: 'candidate_evaluation', jobId: job.id, accountId: job.account_id, criteria, messages, error, started });
    throw error;
  }
}

async function handleCriteriaProposal(context, job) {
  const { pool, llm, config } = context;
  const completed = await pool.query('select id from criteria_versions where source_job_id=$1 limit 1', [job.id]);
  if (completed.rowCount) return { proposed: true, criteriaVersionId: completed.rows[0].id, cached: true };
  const criteria = (await pool.query(`select * from criteria_versions where status='active' limit 1`)).rows[0];
  if (!criteria) throw new Error('Active criteria not found');
  const samples = (await pool.query(`
    select a.id,a.username,a.lifecycle_status,a.rejection_reason,row_to_json(p.*) as profile,
      coalesce(json_agg(json_build_object('caption',r.caption,'transcript',r.transcript_text)) filter (where r.id is not null),'[]') as reels
    from instagram_accounts a join account_profiles p on p.account_id=a.id and p.profile_status='available'
    join reels r on r.account_id=a.id and r.transcript_quality='useful'
    where a.lifecycle_status in ('approved','rejected') group by a.id,p.id order by a.updated_at desc limit 100
  `)).rows;
  if (!samples.length) throw new Error('No decided information-complete accounts available');
  const messages = [
    { role: 'system', content: 'Compare approved and rejected Instagram clothing bloggers and propose an improved criteria version. Return only JSON.' },
    { role: 'user', content: JSON.stringify({ current: { checklist_markdown: criteria.checklist_markdown, search_queries: criteria.search_queries, transcript_rules: criteria.transcript_rules }, samples, output: { checklist_markdown: 'string', search_queries: ['string'], transcript_rules: { noisePatterns: ['regex'], lowValuePatterns: ['regex'], minCharacters: 12, minWords: 3 }, diff_summary: 'string' } }) }
  ];
  const started = Date.now();
  try {
    const result = await llm.proposeCriteria(messages, { signal: context.signal });
    validateTranscriptRules(result.parsed.transcript_rules);
    await withTransaction(pool, async (client) => {
      const log = await client.query(`
        insert into llm_logs(purpose,job_id,criteria_version_id,base_url,model,request_messages,raw_response,parsed_response,
          prompt_tokens,completion_tokens,latency_ms,status)
        values ('criteria_proposal',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'succeeded') returning id
      `, [job.id,criteria.id,config.LLM_BASE_URL,config.LLM_MODEL,JSON.stringify(messages),result.rawResponse,result.parsed,result.usage.prompt_tokens || null,result.usage.completion_tokens || null,result.meta.durationMs]);
      await createCriteriaDraft(client, {
        checklistMarkdown: result.parsed.checklist_markdown,
        searchQueries: result.parsed.search_queries,
        transcriptRules: result.parsed.transcript_rules,
        source: 'llm',
        parentVersionId: criteria.id,
        diffSummary: `${result.parsed.diff_summary} (LLM log ${log.rows[0].id})`,
        sourceJobId: job.id
      });
    });
    return { proposed: true };
  } catch (error) {
    await saveFailedLlmLog(context, { purpose: 'criteria_proposal', jobId: job.id, criteria, messages, error, started });
    throw error;
  }
}

export function createJobHandlers(context) {
  return {
    discover_accounts: (job) => handleDiscovery(context, job),
    fetch_profile: (job) => handleProfile(context, job),
    fetch_reels: (job) => handleReels(context, job),
    fetch_transcript: (job) => handleTranscript(context, job),
    classify_transcript: (job) => handleClassify(context, job),
    evaluate_candidate: (job) => handleEvaluation(context, job),
    propose_criteria: (job) => handleCriteriaProposal(context, job)
  };
}

export async function maybeAdvancePipeline(context, pipelineRunId) {
  if (!pipelineRunId) return;
  const { pool, config } = context;
  await withTransaction(pool, async (client) => {
    const preview = (await client.query('select account_id from pipeline_runs where id=$1', [pipelineRunId])).rows[0];
    if (!preview) return;
    const account = (await client.query('select lifecycle_status from instagram_accounts where id=$1 for update', [preview.account_id])).rows[0];
    const run = (await client.query('select * from pipeline_runs where id=$1 for update', [pipelineRunId])).rows[0];
    if (!run || !['pending','running'].includes(run.status)) return;
    const expectedLifecycle = run.run_type === 'candidate_enrichment' ? 'candidate' : 'approved';
    if (!account || account.lifecycle_status !== expectedLifecycle) {
      await cancelPipelineWork(client, run.id, 'account lifecycle changed');
      return;
    }
    await client.query(`
      update pipeline_runs set status='running',error_summary=null,finished_at=null,
        started_at=coalesce(started_at,now()) where id=$1
    `, [run.id]);
    const jobs = (await client.query('select job_type,status,error_summary from jobs where pipeline_run_id=$1', [run.id])).rows;
    if (jobs.some((item) => ['pending','running','retry_wait'].includes(item.status))) return;
    const evaluationJob = jobs.find((item) => item.job_type === 'evaluate_candidate');
    if (evaluationJob) {
      const status = evaluationJob.status === 'succeeded' ? 'succeeded' : 'failed';
      await client.query(`
        update pipeline_runs set status=$2,error_summary=$3,finished_at=now() where id=$1
      `, [run.id, status, status === 'failed' ? jobFailureSummary([evaluationJob]) : null]);
      return;
    }
    if (run.run_type === 'blogger_refresh') {
      const failures = jobs.filter((item) => item.status === 'failed');
      const status = failures.length ? 'failed' : 'succeeded';
      await client.query(`
        update pipeline_runs set status=$2,error_summary=$3,finished_at=now() where id=$1
      `, [run.id, status, failures.length ? jobFailureSummary(failures) : null]);
      return;
    }
    const ready = await client.query(`
      select exists(select 1 from account_profiles where account_id=$1 and profile_status='available') as profile,
             exists(select 1 from reels where account_id=$1 and transcript_quality='useful') as useful
    `, [run.account_id]);
    const mandatoryFailures = jobs.filter((item) =>
      item.status === 'failed' && ['fetch_profile', 'fetch_reels'].includes(item.job_type)
    );
    const contentFailures = ready.rows[0].useful ? [] : jobs.filter((item) =>
      item.status === 'failed' && ['fetch_transcript', 'classify_transcript'].includes(item.job_type)
    );
    const technicalFailures = [...mandatoryFailures, ...contentFailures];
    if (technicalFailures.length) {
      await client.query(`
        update pipeline_runs set status='failed',error_summary=$2,finished_at=now() where id=$1
      `, [run.id, jobFailureSummary(technicalFailures)]);
    } else if (ready.rows[0].profile && ready.rows[0].useful) {
      await enqueueJob(client, {
        pipelineRunId: run.id, accountId: run.account_id, jobType: 'evaluate_candidate', payload: {},
        dedupeKey: `run:${run.id}:evaluate`, maxAttempts: config.JOB_MAX_ATTEMPTS
      });
    } else {
      await client.query(`
        update pipeline_runs set status='insufficient_data',error_summary=null,finished_at=now() where id=$1
      `, [run.id]);
    }
  });
}

function jobFailureSummary(jobs) {
  return jobs
    .map((job) => `${job.job_type}: ${job.error_summary || 'failed without error detail'}`)
    .join('; ')
    .slice(0, 2000);
}
