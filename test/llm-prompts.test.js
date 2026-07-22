import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_LLM_PROMPTS,
  resolveLlmPrompts,
  validateLlmPrompts,
  withLlmPrompts
} from '../src/domain/llm-prompts.js';

test('uses safe default LLM prompts for existing criteria versions', () => {
  assert.deepEqual(resolveLlmPrompts({}), DEFAULT_LLM_PROMPTS);
});

test('validates, trims and embeds editable LLM prompts', () => {
  const prompts = validateLlmPrompts({
    candidateEvaluation: '  custom analysis  ',
    outreachProposal: ' custom outreach '
  });
  assert.deepEqual(prompts, {
    candidateEvaluation: 'custom analysis',
    outreachProposal: 'custom outreach'
  });
  assert.deepEqual(withLlmPrompts({ minWords: 3 }, prompts).llmPrompts, prompts);
  assert.throws(() => validateLlmPrompts({ candidateEvaluation: '', outreachProposal: 'ok' }));
  assert.throws(() => validateLlmPrompts({ candidateEvaluation: 'ok', outreachProposal: 'x'.repeat(12_001) }));
});
