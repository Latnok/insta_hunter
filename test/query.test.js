import assert from 'node:assert/strict';
import test from 'node:test';

import { jobStatuses, jobTypes, parseListQuery, parseOffset, transcriptQualities } from '../src/domain/query.js';

test('list query accepts supported filters and bounded offsets', () => {
  assert.deepEqual(parseListQuery({
    search: 'fashion', status: 'failed', quality: 'useful', jobType: 'fetch_reels', offset: '10000'
  }, { statuses: jobStatuses, qualities: transcriptQualities, types: jobTypes }), {
    search: 'fashion', status: 'failed', quality: 'useful', jobType: 'fetch_reels', offset: 10000
  });
  assert.equal(parseOffset(undefined), 0);
  assert.equal(parseOffset('0'), 0);
});

test('list query rejects malformed, negative and excessive offsets', () => {
  for (const value of ['-1', 'NaN', '1.5', '10001', '9007199254740992', ['0', '1']]) {
    assert.throws(() => parseOffset(value), /offset/);
  }
});

test('list query rejects unknown and repeated filter values', () => {
  assert.throws(() => parseListQuery({ status: 'unknown' }, { statuses: jobStatuses }), /status/);
  assert.throws(() => parseListQuery({ quality: 'excellent' }, { qualities: transcriptQualities }), /quality/);
  assert.throws(() => parseListQuery({ jobType: 'drop_table' }, { types: jobTypes }), /jobType/);
  assert.throws(() => parseListQuery({ search: ['one', 'two'] }), /search/);
  assert.throws(() => parseListQuery({ search: 'x'.repeat(101) }), /search/);
});
