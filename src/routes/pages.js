import { Router } from 'express';
import { getAccount, listAccountReels, listAccounts, listReels } from '../db/repositories/accounts.js';
import { listJobs } from '../db/repositories/jobs.js';
import { jobStatuses, jobTypes, parseListQuery, transcriptQualities } from '../domain/query.js';
import { resolveLlmPrompts } from '../domain/llm-prompts.js';
import { resolveCriteriaAutomation } from '../domain/criteria-automation.js';

const pageSize = 24;

export function createPageRouter({ pool, config }) {
  const router = Router();

  router.get('/', (_req, res) => res.redirect('/candidates'));
  router.get('/candidates', async (req, res) => {
    const query = parseListQuery(req.query, { statuses: ['candidate', 'rejected'] });
    const statuses = query.status === 'rejected' ? ['rejected'] : ['candidate'];
    const accounts = await listAccounts(pool, { statuses, search: query.search, prioritizeUncertain: true, limit: pageSize, offset: query.offset });
    accounts.forEach((account) => { account.is_stale = !account.profile_fetched_at || Date.now() - new Date(account.profile_fetched_at).getTime() >= config.freshnessMs; });
    const latestSuggestion = await pool.query(`
      select search_queries from criteria_versions
      where source='llm' and status in ('draft','active') and jsonb_array_length(search_queries) > 0
      order by version_number desc limit 1
    `);
    const aiSearchQueries = latestSuggestion.rows[0]?.search_queries || [];
    res.render('accounts', { title: req.t('candidates'), active: 'candidates', accounts, mode: 'candidates', query, config, aiSearchQueries });
  });

  router.get('/bloggers', async (req, res) => {
    const query = parseListQuery(req.query, { statuses: ['approved', 'archived'] });
    const statuses = query.status === 'archived' ? ['archived'] : ['approved'];
    const accounts = await listAccounts(pool, { statuses, search: query.search, limit: pageSize, offset: query.offset });
    accounts.forEach((account) => { account.is_stale = !account.profile_fetched_at || Date.now() - new Date(account.profile_fetched_at).getTime() >= config.freshnessMs; });
    res.render('accounts', { title: req.t('bloggers'), active: 'bloggers', accounts, mode: 'bloggers', query, config });
  });

  router.get('/reels', async (req, res) => {
    const query = parseListQuery(req.query, { qualities: transcriptQualities });
    const reels = await listReels(pool, { search: query.search, quality: query.quality, limit: pageSize, offset: query.offset });
    res.render('reels', { title: req.t('reels'), active: 'reels', reels, query });
  });

  router.get('/queue', async (req, res) => {
    const query = parseListQuery(req.query, { statuses: jobStatuses, types: jobTypes });
    const jobs = await listJobs(pool, { status: query.status, jobType: query.jobType, limit: 50, offset: query.offset });
    res.render('queue', { title: req.t('queue'), active: 'queue', jobs, query, jobTypes });
  });

  router.get('/settings', async (req, res) => {
    const result = await pool.query('select * from criteria_versions order by version_number desc');
    const logs = await pool.query('select * from llm_logs order by created_at desc limit 30');
    const activeCriteria = result.rows.find((item) => item.status === 'active');
    const llmPrompts = resolveLlmPrompts(activeCriteria?.transcript_rules);
    const criteriaAutomation = resolveCriteriaAutomation(activeCriteria?.transcript_rules);
    const automationStatus = (await pool.query(`
      select
        coalesce((select sum(requested_limit)::int from discovery_runs where created_by='automation' and created_at >= date_trunc('day',now())),0) as discovery_used_today,
        (select max(created_at) from discovery_runs where created_by='automation') as last_discovery_at,
        (select count(*)::int from jobs where job_type='propose_criteria' and payload->>'trigger' like 'automatic_%' and status in ('pending','running','retry_wait')) as pending_criteria_jobs
    `)).rows[0];
    res.render('settings', {
      title: req.t('settings'), active: 'settings', criteria: result.rows, llmLogs: logs.rows,
      llmPrompts, criteriaAutomation, automationStatus
    });
  });

  router.get('/ui/discovery-query-suggestions/:jobId', async (req, res) => {
    if (!/^\d+$/.test(req.params.jobId)) return res.status(400).send('Invalid job ID');
    const result = await pool.query(`
      select j.id,j.status,j.error_summary,c.search_queries
      from jobs j
      left join criteria_versions c on c.source_job_id=j.id
      where j.id=$1 and j.job_type='propose_criteria'
    `, [req.params.jobId]);
    if (!result.rowCount) return res.status(404).send('Suggestion job not found');
    const job = result.rows[0];
    const queries = Array.isArray(job.search_queries)
      ? job.search_queries.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (job.status === 'succeeded' && queries.length) res.set('HX-Refresh', 'true');
    return res.render('partials/discovery-query-suggestion', { job, queries });
  });

  router.get('/ui/accounts/:id', async (req, res) => {
    const account = await getAccount(pool, req.params.id);
    if (!account) return res.status(404).send('Not found');
    const reels = await listAccountReels(pool, account.id, 20);
    const audit = await pool.query(`select * from audit_events where entity_type='instagram_account' and entity_id=$1 order by created_at desc limit 20`, [account.id]);
    const jobs = await pool.query('select * from jobs where account_id=$1 order by created_at desc limit 20', [account.id]);
    const outreach = await pool.query(`
      select * from outreach_proposals where account_id=$1 order by created_at desc limit 10
    `, [account.id]);
    return res.render('partials/account-drawer', { account, reels, audit: audit.rows, jobs: jobs.rows, outreach: outreach.rows, config });
  });

  router.get('/ui/reels/:id', async (req, res) => {
    const result = await pool.query(`
      select r.*,a.username,a.instagram_url,p.avatar_url from reels r
      join instagram_accounts a on a.id=r.account_id
      left join account_profiles p on p.account_id=a.id where r.id=$1
    `, [req.params.id]);
    if (!result.rowCount) return res.status(404).send('Not found');
    return res.render('partials/reel-drawer', { reel: result.rows[0] });
  });

  return router;
}
