import { parse } from 'csv-parse/sync';
import { normalizeInstagramUsername } from '../domain/accounts.js';
import { withTransaction } from '../db/pool.js';
import { upsertAccount } from '../db/repositories/accounts.js';
import { startPipeline } from './pipelines.js';

export function previewCsv(buffer, config) {
  const rows = parse(buffer, { columns: true, bom: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  if (rows.length > config.CSV_MAX_ROWS) throw new Error(`CSV exceeds ${config.CSV_MAX_ROWS} rows`);
  const seen = new Set();
  const preview = { valid: [], invalid: [], duplicates: [] };
  rows.forEach((row, index) => {
    const input = row.username || row.url;
    try {
      const username = normalizeInstagramUsername(input);
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

export async function commitCsv(pool, config, preview) {
  const results = [];
  for (const row of preview.valid || []) {
    const account = await withTransaction(pool, (client) => upsertAccount(client, {
      input: row.username, sourceType: 'csv', sourceNote: row.sourceNote
    }));
    let pipeline = null;
    if (account.inserted) pipeline = await startPipeline(pool, config, {
      accountId: account.id, runType: 'candidate_enrichment', reelsLimit: config.REELS_DEFAULT_LIMIT
    });
    results.push({ account, pipeline });
  }
  return results;
}
