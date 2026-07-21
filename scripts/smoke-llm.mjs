import { createLlmClient } from '../src/providers/llm.js';

const client = createLlmClient(process.env);
const result = await client.evaluate([
  {
    role: 'system',
    content: 'Return only a JSON object matching the requested schema.'
  },
  {
    role: 'user',
    content: JSON.stringify({
      task: 'Production connectivity smoke test. Do not evaluate a real person.',
      output: {
        recommendation: 'needs_manual_review',
        confidence: 0,
        positive_signals: ['connectivity_ok'],
        negative_signals: [],
        explanation: 'Connectivity smoke test only.'
      }
    })
  }
]);

console.log(JSON.stringify({
  status: 'ok',
  model: process.env.LLM_MODEL,
  recommendation: result.parsed.recommendation,
  promptTokens: result.usage.prompt_tokens ?? null,
  completionTokens: result.usage.completion_tokens ?? null,
  latencyMs: result.meta.durationMs
}));
