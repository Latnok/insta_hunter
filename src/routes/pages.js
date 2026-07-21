import { Router } from 'express';
import { getAccount, listAccountReels, listAccounts, listReels } from '../db/repositories/accounts.js';
import { listJobs } from '../db/repositories/jobs.js';

const pageSize = 24;

export function createPageRouter({ pool, config }) {
  const router = Router();

  router.get('/', (_req, res) => res.redirect('/candidates'));
  router.get('/candidates', async (req, res) => {
    const statuses = req.query.status === 'rejected' ? ['rejected'] : ['candidate'];
    const accounts = await listAccounts(pool, { statuses, search: req.query.search, limit: pageSize, offset: Number(req.query.offset || 0) });
    accounts.forEach((account) => { account.is_stale = !account.profile_fetched_at || Date.now() - new Date(account.profile_fetched_at).getTime() >= config.freshnessMs; });
    const discovery = await pool.query('select * from discovery_runs order by created_at desc limit 5');
    res.render('accounts', { title: req.t('candidates'), active: 'candidates', accounts, discoveryRuns: discovery.rows, mode: 'candidates', query: req.query, config });
  });

  router.get('/bloggers', async (req, res) => {
    const statuses = req.query.status === 'archived' ? ['archived'] : ['approved'];
    const accounts = await listAccounts(pool, { statuses, search: req.query.search, limit: pageSize, offset: Number(req.query.offset || 0) });
    accounts.forEach((account) => { account.is_stale = !account.profile_fetched_at || Date.now() - new Date(account.profile_fetched_at).getTime() >= config.freshnessMs; });
    res.render('accounts', { title: req.t('bloggers'), active: 'bloggers', accounts, discoveryRuns: [], mode: 'bloggers', query: req.query, config });
  });

  router.get('/reels', async (req, res) => {
    const reels = await listReels(pool, { search: req.query.search, quality: req.query.quality, limit: pageSize, offset: Number(req.query.offset || 0) });
    res.render('reels', { title: req.t('reels'), active: 'reels', reels, query: req.query });
  });

  router.get('/queue', async (req, res) => {
    const jobs = await listJobs(pool, { status: req.query.status, jobType: req.query.jobType, limit: 50, offset: Number(req.query.offset || 0) });
    res.render('queue', { title: req.t('queue'), active: 'queue', jobs, query: req.query });
  });

  router.get('/settings', async (req, res) => {
    const result = await pool.query('select * from criteria_versions order by version_number desc');
    const logs = await pool.query('select * from llm_logs order by created_at desc limit 30');
    res.render('settings', { title: req.t('settings'), active: 'settings', criteria: result.rows, llmLogs: logs.rows });
  });

  router.get('/ui/discovery-runs', async (req, res) => {
    const result = await pool.query('select * from discovery_runs order by created_at desc limit 10');
    return res.render('partials/discovery-runs', { discoveryRuns: result.rows });
  });

  router.get('/ui/accounts/:id', async (req, res) => {
    const account = await getAccount(pool, req.params.id);
    if (!account) return res.status(404).send('Not found');
    const reels = await listAccountReels(pool, account.id, 20);
    const audit = await pool.query(`select * from audit_events where entity_type='instagram_account' and entity_id=$1 order by created_at desc limit 20`, [account.id]);
    const jobs = await pool.query('select * from jobs where account_id=$1 order by created_at desc limit 20', [account.id]);
    return res.render('partials/account-drawer', { account, reels, audit: audit.rows, jobs: jobs.rows, config });
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
