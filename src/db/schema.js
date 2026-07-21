import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction } from './pool.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultSchemaFile = path.resolve(currentDir, '../../db/schema.sql');
const requiredTables = [
  'instagram_accounts', 'account_sources', 'account_profiles', 'reels',
  'criteria_versions', 'evaluations', 'jobs', 'job_attempts', 'audit_events'
];

export async function initializeSchema(pool, { schemaFile = defaultSchemaFile, logger } = {}) {
  const sql = await readFile(schemaFile, 'utf8');
  return withTransaction(pool, async (client) => {
    await client.query('select pg_advisory_xact_lock($1)', [8675309]);
    const existing = await client.query(`
      select tablename
      from pg_catalog.pg_tables
      where schemaname = 'public'
    `);
    const names = new Set(existing.rows.map((row) => row.tablename));
    if (names.has('instagram_accounts')) {
      const missing = requiredTables.filter((name) => !names.has(name));
      if (missing.length) throw new Error(`Existing database has an incomplete schema: ${missing.join(', ')}`);
      logger?.info('complete schema already present');
      return false;
    }
    if (names.size) throw new Error(`Database is not empty; refusing to apply full schema (${[...names].join(', ')})`);
    await client.query(sql);
    logger?.info({ schemaFile: path.basename(schemaFile) }, 'complete schema initialized');
    return true;
  });
}
