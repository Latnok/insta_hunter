import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTranscript, DEFAULT_TRANSCRIPT_RULES, validateTranscriptRules } from '../src/domain/transcripts.js';

test('classifies empty, noise, low-value and useful transcripts', () => {
  assert.equal(classifyTranscript('').quality, 'empty');
  assert.equal(classifyTranscript('Субтитры сделал DimaTorzok').quality, 'noise');
  assert.equal(classifyTranscript('Музыка').quality, 'low_value');
  assert.equal(classifyTranscript('Это жакет из плотной ткани, показываю посадку и сочетания.').quality, 'useful');
});

test('validates configurable regex rules', () => {
  assert.equal(validateTranscriptRules(DEFAULT_TRANSCRIPT_RULES), DEFAULT_TRANSCRIPT_RULES);
  assert.throws(() => validateTranscriptRules({ ...DEFAULT_TRANSCRIPT_RULES, noisePatterns: ['['] }));
  assert.throws(() => validateTranscriptRules({ ...DEFAULT_TRANSCRIPT_RULES, minWords: 0 }));
});
