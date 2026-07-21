import test from 'node:test';
import assert from 'node:assert/strict';
import { hashSync } from 'bcryptjs';
import { loadConfig } from '../src/config/index.js';

function baseEnv() {
  return {
    NODE_ENV: 'test', DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: hashSync('long-test-password', 4),
    SESSION_SECRET: '12345678901234567890123456789012', APP_DOMAIN: 'localhost'
  };
}

test('loads defaults and derived values', () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.REELS_DEFAULT_LIMIT, 3);
  assert.equal(config.DISCOVERY_DEFAULT_LIMIT, 5);
  assert.equal(config.sessionTtlMs, 7 * 86400000);
});

test('rejects unsafe or inconsistent configuration', () => {
  assert.throws(() => loadConfig({ ...baseEnv(), SESSION_SECRET: 'short' }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ ...baseEnv(), REELS_DEFAULT_LIMIT: '21', REELS_MAX_LIMIT: '20' }), /must not exceed/);
});
