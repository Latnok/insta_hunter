import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TRANSCRIPT_RULES } from '../domain/transcripts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function seed(pool) {
  const active = await pool.query(`select id from criteria_versions where status='active' limit 1`);
  if (active.rowCount) return { seeded: false, id: active.rows[0].id };
  const checklist = await readFile(path.join(root, 'docs/legacy/clothing-seller-blogger-criteria.md'), 'utf8');
  const queriesText = await readFile(path.join(root, 'docs/legacy/clothing-blogger-search-queries.md'), 'utf8');
  const queries = [...queriesText.matchAll(/^- (.+)$/gm)].map((match) => match[1].trim()).filter(Boolean);
  const result = await pool.query(`
    insert into criteria_versions(
      version_number, checklist_markdown, search_queries, transcript_rules,
      status, source, diff_summary, activated_at
    ) values (1,$1,$2,$3,'active','seed','Initial criteria imported from legacy documents',now())
    returning id
  `, [checklist, JSON.stringify(queries), JSON.stringify(DEFAULT_TRANSCRIPT_RULES)]);
  return { seeded: true, id: result.rows[0].id };
}
