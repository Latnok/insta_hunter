import test from 'node:test';
import assert from 'node:assert/strict';
import { criteriaSchema, createLlmClient, evaluationSchema } from '../src/providers/llm.js';

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('validates candidate evaluation schema', () => {
  const result = evaluationSchema.parse({ recommendation: 'recommended_approve', confidence: 88, positive_signals: ['useful'], negative_signals: [], explanation: 'Fits criteria' });
  assert.equal(result.confidence, 88);
  assert.throws(() => evaluationSchema.parse({ recommendation: 'approve', confidence: 101, positive_signals: [], negative_signals: [], explanation: '' }));
});

test('validates criteria proposal schema', () => {
  assert.doesNotThrow(() => criteriaSchema.parse({ checklist_markdown: '# Criteria', search_queries: ['fashion'], transcript_rules: { noisePatterns: [], lowValuePatterns: [], minCharacters: 12, minWords: 3 }, diff_summary: 'Updated' }));
});

test('parses OpenAI-compatible JSON response', async () => {
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'model');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal('temperature' in body, false);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ recommendation: 'needs_manual_review', confidence: 50, positive_signals: [], negative_signals: ['unclear'], explanation: 'Unclear' }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createLlmClient({ LLM_BASE_URL: 'https://llm.example/v1', LLM_API_KEY: 'key', LLM_MODEL: 'model' });
  const result = await client.evaluate([{ role: 'user', content: 'test' }]);
  assert.equal(result.parsed.recommendation, 'needs_manual_review');
  assert.equal(result.usage.prompt_tokens, 10);
});
