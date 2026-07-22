import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction } from './pool.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultSchemaFile = path.resolve(currentDir, '../../db/schema.sql');
const requiredTables = [
  'schema_metadata', 'instagram_accounts', 'discovery_runs', 'account_sources',
  'account_profiles', 'reels', 'criteria_versions', 'pipeline_runs', 'jobs',
  'job_attempts', 'llm_logs', 'evaluations', 'audit_events', 'provider_call_logs',
  'csv_import_batches', 'user_sessions', 'worker_heartbeats'
];

export const currentSchemaVersion = 1;

export async function getSchemaStatus(queryable) {
  const existing = await queryable.query(`
    select tablename
    from pg_catalog.pg_tables
    where schemaname = 'public'
  `);
  const names = new Set(existing.rows.map((row) => row.tablename));
  if (!names.size) {
    return { state: 'empty', compatible: false, expectedVersion: currentSchemaVersion };
  }

  const missingTables = requiredTables.filter((name) => !names.has(name));
  if (missingTables.length) {
    return {
      state: 'incompatible', compatible: false, expectedVersion: currentSchemaVersion,
      actualVersion: null, missingTables
    };
  }

  const metadata = await queryable.query(`
    select schema_version
    from schema_metadata
    where singleton = true
  `);
  const actualVersion = metadata.rows[0]?.schema_version ?? null;
  return {
    state: actualVersion === currentSchemaVersion ? 'compatible' : 'incompatible',
    compatible: actualVersion === currentSchemaVersion,
    expectedVersion: currentSchemaVersion,
    actualVersion,
    missingTables: []
  };
}

function incompatibleSchemaError(status) {
  const details = status.missingTables?.length
    ? `missing tables: ${status.missingTables.join(', ')}`
    : `schema version ${status.actualVersion ?? 'missing'}, expected ${status.expectedVersion}`;
  return new Error(`Existing database has an incompatible schema (${details}); refusing to modify it`);
}

export async function initializeSchema(pool, { schemaFile = defaultSchemaFile, logger } = {}) {
  const sql = await readFile(schemaFile, 'utf8');
  return withTransaction(pool, async (client) => {
    await client.query('select pg_advisory_xact_lock($1)', [8675309]);
    const status = await getSchemaStatus(client);
    if (status.compatible) {
      logger?.info({ schemaVersion: currentSchemaVersion }, 'compatible schema already present');
      return false;
    }
    if (status.state !== 'empty') throw incompatibleSchemaError(status);
    await client.query(sql);
    const initialized = await getSchemaStatus(client);
    if (!initialized.compatible) throw incompatibleSchemaError(initialized);
    logger?.info({
      schemaFile: path.basename(schemaFile), schemaVersion: currentSchemaVersion
    }, 'complete schema initialized');
    return true;
  });
}
