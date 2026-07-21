import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTransition, canonicalInstagramUrl, isStale, normalizeInstagramUsername } from '../src/domain/accounts.js';

test('normalizes Instagram usernames and URLs', () => {
  assert.equal(normalizeInstagramUsername('@Some.User'), 'some.user');
  assert.equal(normalizeInstagramUsername('https://www.instagram.com/Some.User/?utm_source=x'), 'some.user');
  assert.equal(normalizeInstagramUsername('instagram.com/some_user/profilecard'), 'some_user');
  assert.equal(canonicalInstagramUrl('@Some.User'), 'https://www.instagram.com/some.user/');
});

test('rejects unsupported and reserved URLs', () => {
  assert.throws(() => normalizeInstagramUsername('https://example.com/foo'), /instagram.com/);
  assert.throws(() => normalizeInstagramUsername('https://instagram.com/reel/abc'), /Invalid/);
  assert.throws(() => normalizeInstagramUsername('bad username'), /Invalid/);
});

test('enforces lifecycle transitions', () => {
  assert.doesNotThrow(() => assertTransition('candidate', 'approved'));
  assert.doesNotThrow(() => assertTransition('approved', 'archived'));
  assert.doesNotThrow(() => assertTransition('archived', 'approved'));
  assert.throws(() => assertTransition('rejected', 'approved'), /not allowed/);
  assert.throws(() => assertTransition('candidate', 'archived'), /not allowed/);
});

test('marks data stale at the configured boundary', () => {
  const now = Date.parse('2026-07-21T00:00:00Z');
  assert.equal(isStale('2026-07-19T00:00:01Z', 2 * 86400000, now), false);
  assert.equal(isStale('2026-07-19T00:00:00Z', 2 * 86400000, now), true);
  assert.equal(isStale(null, 2 * 86400000, now), true);
});
