import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePipelineReelsLimit, startPipelineInTransaction } from '../src/services/pipelines.js';

const config = { REELS_DEFAULT_LIMIT: 3, REELS_MAX_LIMIT: 20 };

test('uses the active materials-per-candidate setting when a run has no override', async () => {
  const client = {
    async query() {
      return {
        rows: [{
          transcript_rules: {
            criteriaAutomation: {
              criteriaEnabled: true,
              decisionThreshold: 10,
              refreshHours: 24,
              discoveryEnabled: true,
              processingEnabled: true,
              dailyDiscoveryLimit: 20,
              perQueryLimit: 5,
              reelsPerCandidate: 8
            }
          }
        }]
      };
    }
  };

  assert.equal(await resolvePipelineReelsLimit(client, config), 8);
});

test('keeps a valid per-run override and rejects an invalid one', async () => {
  const client = { query: async () => { throw new Error('settings query should not run'); } };

  assert.equal(await resolvePipelineReelsLimit(client, config, 6), 6);
  await assert.rejects(resolvePipelineReelsLimit(client, config, 21), /between 1 and 20/);
});

test('skips automatic processing when the header toggle is off', async () => {
  let queryCount = 0;
  const client = {
    async query() {
      queryCount += 1;
      return {
        rows: [{
          transcript_rules: {
            criteriaAutomation: {
              criteriaEnabled: true, decisionThreshold: 10, refreshHours: 24,
              discoveryEnabled: true, processingEnabled: false,
              dailyDiscoveryLimit: 20, perQueryLimit: 5, reelsPerCandidate: 8
            }
          }
        }]
      };
    }
  };

  const result = await startPipelineInTransaction(client, config, {
    accountId: 42, runType: 'candidate_enrichment', automatic: true
  });
  assert.deepEqual(result, {
    run: null, existing: false, skipped: 'automatic_processing_disabled'
  });
  assert.equal(queryCount, 1);
});
