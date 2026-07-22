const DEFAULT_NOISE_PATTERNS = [
  'dimatorzok',
  'субтитры сделал',
  'субтитры создавал',
  'субтитры подогнал'
];

const DEFAULT_LOW_VALUE_PATTERNS = [
  '^музыка[.!… ]*$',
  '^music[.!… ]*$',
  '^аплодисменты[.!… ]*$',
  '^смех[.!… ]*$',
  '^шум[.!… ]*$'
];

export const DEFAULT_TRANSCRIPT_RULES = Object.freeze({
  noisePatterns: DEFAULT_NOISE_PATTERNS,
  lowValuePatterns: DEFAULT_LOW_VALUE_PATTERNS,
  minCharacters: 12,
  minWords: 3
});

function normalizeRegexPattern(pattern) {
  return String(pattern).replace(/^\(\?[iu]+\)/i, '');
}

export function normalizeTranscriptRules(rules = DEFAULT_TRANSCRIPT_RULES) {
  return {
    ...rules,
    noisePatterns: (rules.noisePatterns || []).map(normalizeRegexPattern),
    lowValuePatterns: (rules.lowValuePatterns || []).map(normalizeRegexPattern)
  };
}

export function validateTranscriptRules(rules = DEFAULT_TRANSCRIPT_RULES) {
  for (const pattern of [...(rules.noisePatterns || []), ...(rules.lowValuePatterns || [])]) {
    new RegExp(pattern, 'iu');
  }
  if (!Number.isInteger(rules.minCharacters) || rules.minCharacters < 1) throw new Error('Invalid minCharacters');
  if (!Number.isInteger(rules.minWords) || rules.minWords < 1) throw new Error('Invalid minWords');
  return rules;
}

export function classifyTranscript(text, rules = DEFAULT_TRANSCRIPT_RULES) {
  validateTranscriptRules(rules);
  if (!text?.trim()) return { quality: 'empty', reason: 'empty transcript text' };
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const pattern of rules.noisePatterns || []) {
    if (new RegExp(pattern, 'iu').test(normalized)) return { quality: 'noise', reason: `matched noise pattern: ${pattern}` };
  }
  for (const pattern of rules.lowValuePatterns || []) {
    if (new RegExp(pattern, 'iu').test(normalized)) return { quality: 'low_value', reason: `matched low-value pattern: ${pattern}` };
  }
  if (normalized.length < rules.minCharacters) return { quality: 'low_value', reason: 'too short' };
  if (normalized.split(' ').length < rules.minWords) return { quality: 'low_value', reason: 'too few words' };
  return { quality: 'useful', reason: null };
}
