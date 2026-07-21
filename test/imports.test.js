import test from 'node:test';
import assert from 'node:assert/strict';
import { previewCsv } from '../src/services/imports.js';

const config = { CSV_MAX_ROWS: 10 };

test('previews header-based CSV and identifies duplicates and errors', () => {
  const csv = Buffer.from('username,source_note\n@Good.User,manual\ngood.user,duplicate\nbad username,invalid\n');
  const result = previewCsv(csv, config);
  assert.equal(result.valid.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.valid[0].username, 'good.user');
});

test('rejects CSV row overflow', () => {
  const csv = Buffer.from('username\na\nb\n');
  assert.throws(() => previewCsv(csv, { CSV_MAX_ROWS: 1 }), /exceeds/);
});
