import { Router } from 'express';
import multer from 'multer';
import { addManualAccount, approveAccount, archiveAccount, rejectAccount, restoreAccount } from '../services/accounts.js';
import { createDiscoveryRun } from '../services/discovery.js';
import { commitCsv, previewCsv } from '../services/imports.js';
import { startPipeline } from '../services/pipelines.js';
import { validateTranscriptRules } from '../domain/transcripts.js';
import { withTransaction } from '../db/pool.js';
import { enqueueJob } from '../db/repositories/jobs.js';

function back(res, fallback = '/candidates') {
  res.set('HX-Redirect', fallback);
  return res.redirect(303, fallback);
}

function requestMeta(req) {
  return { ip: req.ip, userAgent: req.get('user-agent') };
}

export function createActionRouter({ pool, config }) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.uploadMaxBytes, files: 1 } });

  router.post('/accounts', async (req, res) => {
    await addManualAccount(pool, config, req.body.account, req.body.sourceNote || null);
    return back(res);
  });

  router.post('/discovery-runs', async (req, res) => {
    await createDiscoveryRun(pool, config, { query: req.body.query, limit: req.body.limit });
    return back(res);
  });

  router.post('/imports/csv/preview', upload.single('file'), async (req, res) => {
    if (!req.file) throw Object.assign(new Error('CSV file is required'), { statusCode: 400 });
    const preview = previewCsv(req.file.buffer, config);
    req.session.csvPreview = preview;
    return res.render('partials/csv-preview', { preview });
  });

  router.post('/imports/csv/commit', async (req, res) => {
    if (!req.session.csvPreview) throw Object.assign(new Error('CSV preview expired'), { statusCode: 409 });
    await commitCsv(pool, config, req.session.csvPreview);
    delete req.session.csvPreview;
    return back(res);
  });

  router.post('/accounts/:id/pipeline', async (req, res) => {
    const account = await pool.query('select lifecycle_status from instagram_accounts where id=$1', [req.params.id]);
    if (!account.rowCount) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
    const runType = account.rows[0].lifecycle_status === 'approved' ? 'blogger_refresh' : 'candidate_enrichment';
    await startPipeline(pool, config, {
      accountId: req.params.id, runType, reelsLimit: req.body.reelsLimit,
      forceRefresh: req.body.forceRefresh === 'true' || req.body.forceRefresh === 'on'
    });
    return back(res, runType === 'blogger_refresh' ? '/bloggers' : '/candidates');
  });

  router.post('/accounts/:id/approve', async (req, res) => { await approveAccount(pool, req.params.id, requestMeta(req)); return back(res); });
  router.post('/accounts/:id/reject', async (req, res) => { await rejectAccount(pool, req.params.id, req.body.reason || null, requestMeta(req)); return back(res); });
  router.post('/accounts/:id/archive', async (req, res) => { await archiveAccount(pool, req.params.id, req.body.reason || null, requestMeta(req)); return back(res, '/bloggers'); });
  router.post('/accounts/:id/restore', async (req, res) => { await restoreAccount(pool, req.params.id, requestMeta(req)); return back(res, '/bloggers?status=archived'); });

  router.post('/jobs/:id/retry', async (req, res) => {
    const result = await pool.query(`
      update jobs set status='retry_wait', available_at=now(), max_attempts=attempts+3,
                      error_summary=null, finished_at=null, updated_at=now()
      where id=$1 and status='failed' returning id
    `, [req.params.id]);
    if (!result.rowCount) throw Object.assign(new Error('Only failed jobs can be retried'), { statusCode: 409 });
    return back(res, '/queue');
  });

  router.post('/jobs/:id/cancel', async (req, res) => {
    const result = await pool.query(`
      update jobs set status='cancelled', finished_at=now(), updated_at=now()
      where id=$1 and status in ('pending','retry_wait') returning id
    `, [req.params.id]);
    if (!result.rowCount) throw Object.assign(new Error('Only pending jobs can be cancelled'), { statusCode: 409 });
    return back(res, '/queue');
  });

  router.post('/criteria/drafts', async (req, res) => {
    let queries;
    let rules;
    try {
      queries = String(req.body.searchQueries || '').split('\n').map((value) => value.trim()).filter(Boolean);
      rules = JSON.parse(req.body.transcriptRules || '{}');
      validateTranscriptRules(rules);
    } catch (error) {
      throw Object.assign(new Error(`Invalid criteria: ${error.message}`), { statusCode: 400 });
    }
    await pool.query(`
      insert into criteria_versions(version_number, checklist_markdown, search_queries, transcript_rules, status, source, parent_version_id, diff_summary)
      select coalesce(max(version_number),0)+1, $1, $2, $3, 'draft', 'manual',
             (select id from criteria_versions where status='active' limit 1), 'Manual draft'
      from criteria_versions
    `, [req.body.checklistMarkdown || '', JSON.stringify(queries), JSON.stringify(rules)]);
    return back(res, '/settings');
  });

  router.post('/criteria/proposals', async (_req, res) => {
    await withTransaction(pool, async (client) => {
      const active = await client.query(`select id from criteria_versions where status='active' limit 1`);
      if (!active.rowCount) throw Object.assign(new Error('Active criteria not found'), { statusCode: 409 });
      await enqueueJob(client, {
        jobType: 'propose_criteria', payload: { criteriaVersionId: active.rows[0].id },
        dedupeKey: `criteria-proposal:${active.rows[0].id}:${Date.now()}`, maxAttempts: config.JOB_MAX_ATTEMPTS
      });
    });
    return back(res, '/settings');
  });

  router.post('/criteria/:id/activate', async (req, res) => {
    await withTransaction(pool, async (client) => {
      await client.query('select pg_advisory_xact_lock($1)', [424242]);
      const draft = await client.query(`select * from criteria_versions where id=$1 and status='draft' for update`, [req.params.id]);
      if (!draft.rowCount) throw Object.assign(new Error('Draft not found'), { statusCode: 409 });
      validateTranscriptRules(draft.rows[0].transcript_rules);
      await client.query(`update criteria_versions set status='superseded' where status='active'`);
      await client.query(`update criteria_versions set status='active', activated_at=now() where id=$1`, [req.params.id]);
      await client.query(`insert into audit_events(action,entity_type,entity_id,new_values) values ('criteria_activate','criteria_version',$1,$2)`, [req.params.id, draft.rows[0]]);
    });
    return back(res, '/settings');
  });

  router.post('/criteria/:id/reject', async (req, res) => {
    await pool.query(`update criteria_versions set status='rejected', rejected_at=now() where id=$1 and status='draft'`, [req.params.id]);
    return back(res, '/settings');
  });

  router.post('/preferences/language', (req, res) => {
    const locale = req.body.locale === 'ru' ? 'ru' : 'en';
    req.session.locale = locale;
    res.cookie('locale', locale, { maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax', secure: config.isProduction });
    return back(res, req.get('referer') || '/candidates');
  });

  return router;
}
