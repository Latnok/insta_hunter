import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CRITERIA_AUTOMATION,
  resolveCriteriaAutomation,
  uniqueSearchQueries,
  validateCriteriaAutomation,
  withCriteriaAutomation
} from '../src/domain/criteria-automation.js';

test('uses safe automation defaults for existing criteria', () => {
  assert.deepEqual(resolveCriteriaAutomation({}), DEFAULT_CRITERIA_AUTOMATION);
});

test('validates and embeds criteria automation settings', () => {
  const settings = validateCriteriaAutomation({
    criteriaEnabled: true, decisionThreshold: 12, refreshHours: 48,
    discoveryEnabled: false, processingEnabled: false, dailyDiscoveryLimit: 30, perQueryLimit: 6,
    reelsPerCandidate: 8
  });
  assert.deepEqual(withCriteriaAutomation({ minWords: 3 }, settings).criteriaAutomation, settings);
  assert.throws(() => validateCriteriaAutomation({ ...settings, decisionThreshold: 0 }));
  assert.throws(() => validateCriteriaAutomation({ ...settings, reelsPerCandidate: 21 }));
  assert.throws(() => validateCriteriaAutomation({ ...settings, discoveryEnabled: 'yes' }));
  assert.throws(() => validateCriteriaAutomation({ ...settings, processingEnabled: 'yes' }));
  assert.equal(validateCriteriaAutomation({ ...settings, processingEnabled: undefined }).processingEnabled, true);
});

test('normalizes and deduplicates automatic search queries', () => {
  assert.deepEqual(uniqueSearchQueries([' Fashion Moscow ', 'fashion moscow', '', 'Обзоры одежды']), [
    'Fashion Moscow', 'Обзоры одежды'
  ]);
});
