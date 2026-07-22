import { z } from 'zod';
import { requestJson } from './http.js';

export const evaluationSchema = z.object({
  recommendation: z.enum(['recommended_approve', 'recommended_reject', 'needs_manual_review']),
  confidence: z.number().int().min(0).max(100),
  positive_signals: z.array(z.string().min(1)).max(20),
  negative_signals: z.array(z.string().min(1)).max(20),
  explanation: z.string().min(1).max(4000)
});

export const criteriaSchema = z.object({
  checklist_markdown: z.string().min(1),
  search_queries: z.array(z.string().min(1)).max(100),
  transcript_rules: z.object({
    noisePatterns: z.array(z.string()), lowValuePatterns: z.array(z.string()),
    minCharacters: z.number().int().min(1), minWords: z.number().int().min(1)
  }),
  diff_summary: z.string().min(1).max(4000)
});

export const outreachSchema = z.object({
  message_text: z.string().min(1).max(5000),
  personalization_reason: z.string().min(1).max(5000)
});

function extractContent(data) {
  const content = data?.choices?.[0]?.message?.content ?? data?.output_text;
  if (typeof content !== 'string') throw new Error('LLM response has no text content');
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(stripped);
}

export function createLlmClient(config) {
  async function complete({ purpose, messages, schema, signal }) {
    if (!config.LLM_API_KEY || !config.LLM_MODEL) throw new Error('LLM is not configured');
    const endpoint = `${config.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`;
    const response = await requestJson(endpoint, {
      method: 'POST', timeoutMs: 180_000, signal,
      headers: { authorization: `Bearer ${config.LLM_API_KEY}`, 'content-type': 'application/json' },
      body: { model: config.LLM_MODEL, response_format: { type: 'json_object' }, messages }
    });
    const raw = extractContent(response.data);
    return { purpose, parsed: schema.parse(raw), rawResponse: response.data, meta: response.meta, usage: response.data.usage || {} };
  }
  return {
    evaluate: (messages, options = {}) => complete({ purpose: 'candidate_evaluation', messages, schema: evaluationSchema, signal: options.signal }),
    proposeCriteria: (messages, options = {}) => complete({ purpose: 'criteria_proposal', messages, schema: criteriaSchema, signal: options.signal }),
    draftOutreach: (messages, options = {}) => complete({ purpose: 'outreach_proposal', messages, schema: outreachSchema, signal: options.signal })
  };
}
