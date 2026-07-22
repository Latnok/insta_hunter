import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { addManualAccount, approveAccount, archiveAccount, rejectAccount, restoreAccount } from '../services/accounts.js';
import { createDiscoveryRun } from '../services/discovery.js';
import { commitCsv, previewCsv } from '../services/imports.js';
import { startPipeline } from '../services/pipelines.js';
import { validateTranscriptRules } from '../domain/transcripts.js';
import { withTransaction } from '../db/pool.js';
import { enqueueJob } from '../db/repositories/jobs.js';
import { cancelJob, retryJob } from '../services/jobs.js';

function back(res, fallback = '/candidates') {
  res.set('HX-Redirect', fallback);
  return res.redirect(303, fallback);
}

function requestMeta(req) {
  return { ip: req.ip, userAgent: req.get('user-agent') };
}

const csvPreviewVersion = 1;
const csvPreviewTtlMs = 15 * 60 * 1000;
const csvPreviewLimit = 5;

function storeCsvPreview(req, preview) {
  const now = Date.now();
  const previews = req.session.csvPreviews && typeof req.session.csvPreviews === 'object'
    ? req.session.csvPreviews
    : {};
  for (const [id, entry] of Object.entries(previews)) {
    if (!entry?.createdAt || now - entry.createdAt > csvPreviewTtlMs) delete previews[id];
  }
  const previewId = crypto.randomUUID();
  previews[previewId] = { version: csvPreviewVersion, createdAt: now, preview };
  const ids = Object.keys(previews).sort((a, b) => previews[a].createdAt - previews[b].createdAt);
  while (ids.length > csvPreviewLimit) delete previews[ids.shift()];
  req.session.csvPreviews = previews;
  return previewId;
}

function csvUploadMiddleware(upload) {
  return (req, res, next) => upload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      error.statusCode = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      error.message = error.code === 'LIMIT_FILE_SIZE' ? 'CSV file is too large' : `Invalid CSV upload: ${error.code}`;
    } else {
      error.statusCode = 400;
      error.message = 'Invalid CSV upload';
    }
    return next(error);
  });
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

  router.post('/imports/csv/preview', csvUploadMiddleware(upload), async (req, res) => {
    if (!req.file) throw Object.assign(new Error('CSV file is required'), { statusCode: 400 });
    const preview = previewCsv(req.file.buffer, config);
    const previewId = storeCsvPreview(req, preview);
    return res.render('partials/csv-preview', { preview, previewId, previewVersion: csvPreviewVersion });
  });

  router.post('/imports/csv/commit', async (req, res) => {
    const previewId = String(req.body.previewId || '');
    const version = Number(req.body.previewVersion);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previewId) || version !== csvPreviewVersion) {
      throw Object.assign(new Error('Invalid CSV preview token'), { statusCode: 400 });
    }
    const entry = req.session.csvPreviews?.[previewId];
    if (!entry || entry.version !== version || Date.now() - entry.createdAt > csvPreviewTtlMs) {
      throw Object.assign(new Error('CSV preview expired or was already used'), { statusCode: 409 });
    }
    await commitCsv(pool, config, { previewId, version, preview: entry.preview });
    delete req.session.csvPreviews[previewId];
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
    await retryJob(pool, req.params.id);
    return back(res, '/queue');
  });

  router.post('/jobs/:id/cancel', async (req, res) => {
    await cancelJob(pool, req.params.id);
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
