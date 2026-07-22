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

test('accepts URL-only UTF-8 CSV with the strict supported header set', () => {
  const csv = Buffer.from('\uFEFFurl,source_note\nhttps://instagram.com/url_only/,from url\n', 'utf8');
  const result = previewCsv(csv, config);
  assert.equal(result.valid[0].username, 'url_only');
  assert.equal(result.valid[0].sourceNote, 'from url');
});

test('rejects invalid UTF-8, missing identity header and unsupported columns', () => {
  assert.throws(() => previewCsv(Buffer.from([0xc3, 0x28]), config), /valid UTF-8/);
  assert.throws(() => previewCsv(Buffer.from('source_note\nonly note\n'), config), /requires a username or url header/);
  assert.throws(() => previewCsv(Buffer.from('username,email\nuser,x@example.com\n'), config), /Unsupported CSV headers: email/);
  assert.throws(() => previewCsv(Buffer.from('username,username\na,b\n'), config), /headers must be unique/);
});

test('rejects ragged records and flags conflicting username and URL values', () => {
  assert.throws(() => previewCsv(Buffer.from('username,source_note\nuser\n'), config), /Invalid CSV/);
  const result = previewCsv(Buffer.from('username,url\nfirst,https://instagram.com/second/\n'), config);
  assert.equal(result.valid.length, 0);
  assert.match(result.invalid[0].error, /different accounts/);
});
