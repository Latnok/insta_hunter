import { parse } from 'csv-parse/sync';
import { normalizeInstagramUsername } from '../domain/accounts.js';
import { withTransaction } from '../db/pool.js';
import { upsertAccount } from '../db/repositories/accounts.js';
import { startPipelineInTransaction } from './pipelines.js';

const allowedHeaders = new Set(['username', 'url', 'source_note']);

function badCsv(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function previewCsv(buffer, config) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw badCsv('CSV must be valid UTF-8');
  }
  if (text.includes('\0')) throw badCsv('CSV must not contain NUL bytes');
  let headers;
  let rows;
  try {
    rows = parse(text, {
      columns: (values) => {
        headers = values.map((value) => value.trim().replace(/^\uFEFF/, ''));
        if (new Set(headers).size !== headers.length) throw badCsv('CSV headers must be unique');
        const unexpected = headers.filter((header) => !allowedHeaders.has(header));
        if (unexpected.length) throw badCsv(`Unsupported CSV headers: ${unexpected.join(', ')}`);
        if (!headers.includes('username') && !headers.includes('url')) {
          throw badCsv('CSV requires a username or url header');
        }
        return headers;
      },
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false
    });
  } catch (error) {
    if (error.statusCode) throw error;
    throw badCsv(`Invalid CSV: ${error.message}`);
  }
  if (!headers) throw badCsv('CSV header row is required');
  if (rows.length > config.CSV_MAX_ROWS) throw badCsv(`CSV exceeds ${config.CSV_MAX_ROWS} rows`);
  const seen = new Set();
  const preview = { valid: [], invalid: [], duplicates: [] };
  rows.forEach((row, index) => {
    const input = row.username || row.url;
    try {
      const username = normalizeInstagramUsername(input);
      if (row.username && row.url && normalizeInstagramUsername(row.url) !== username) {
        throw new Error('username and url refer to different accounts');
      }
      if (seen.has(username)) preview.duplicates.push({ row: index + 2, username });
      else {
        seen.add(username);
        preview.valid.push({ row: index + 2, username, sourceNote: row.source_note || null });
      }
    } catch (error) {
      preview.invalid.push({ row: index + 2, value: input || '', error: error.message });
    }
  });
  return preview;
}

export async function commitCsv(pool, config, { previewId, version, preview }) {
  if (version !== 1) throw Object.assign(new Error('Unsupported CSV preview version'), { statusCode: 409 });
  return withTransaction(pool, async (client) => {
    const claimed = await client.query(`
      insert into csv_import_batches(id,preview_version,row_count)
      values ($1,$2,$3) on conflict(id) do nothing returning id
    `, [previewId, version, preview.valid?.length || 0]);
    if (!claimed.rowCount) throw Object.assign(new Error('CSV preview was already committed'), { statusCode: 409 });
    const results = [];
    for (const row of preview.valid || []) {
      const account = await upsertAccount(client, {
        input: row.username, sourceType: 'csv', sourceNote: row.sourceNote
      });
      let pipeline = null;
      if (account.inserted) pipeline = await startPipelineInTransaction(client, config, {
        accountId: account.id, runType: 'candidate_enrichment', reelsLimit: config.REELS_DEFAULT_LIMIT
      });
      results.push({ account, pipeline });
    }
    return results;
  });
}
