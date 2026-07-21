import pg from 'pg';

const { Pool } = pg;

export function createPool(config) {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: config.NODE_ENV === 'test' ? 4 : 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: `instagram-hunter-${config.NODE_ENV}`,
    ssl: config.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined
  });
}

export async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await callback(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
