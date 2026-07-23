export const DEFAULT_CRITERIA_AUTOMATION = Object.freeze({
  criteriaEnabled: true,
  decisionThreshold: 10,
  refreshHours: 24,
  discoveryEnabled: true,
  dailyDiscoveryLimit: 20,
  perQueryLimit: 5,
  reelsPerCandidate: 3
});

function integer(value, key, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function validateCriteriaAutomation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid criteria automation settings');
  }
  if (typeof value.criteriaEnabled !== 'boolean' || typeof value.discoveryEnabled !== 'boolean') {
    throw new Error('Automation switches must be boolean');
  }
  return {
    criteriaEnabled: value.criteriaEnabled,
    decisionThreshold: integer(value.decisionThreshold, 'decisionThreshold', 1, 100),
    refreshHours: integer(value.refreshHours, 'refreshHours', 1, 168),
    discoveryEnabled: value.discoveryEnabled,
    dailyDiscoveryLimit: integer(value.dailyDiscoveryLimit, 'dailyDiscoveryLimit', 1, 100),
    perQueryLimit: integer(value.perQueryLimit, 'perQueryLimit', 1, 100),
    reelsPerCandidate: integer(
      value.reelsPerCandidate ?? DEFAULT_CRITERIA_AUTOMATION.reelsPerCandidate,
      'reelsPerCandidate',
      1,
      20
    )
  };
}

export function resolveCriteriaAutomation(transcriptRules = {}) {
  const stored = transcriptRules?.criteriaAutomation;
  return stored ? validateCriteriaAutomation(stored) : { ...DEFAULT_CRITERIA_AUTOMATION };
}

export function withCriteriaAutomation(transcriptRules, settings) {
  return { ...transcriptRules, criteriaAutomation: validateCriteriaAutomation(settings) };
}

export function uniqueSearchQueries(queries) {
  const seen = new Set();
  return (Array.isArray(queries) ? queries : []).map((value) => String(value).trim()).filter((value) => {
    const key = value.toLocaleLowerCase('ru-RU');
    if (value.length < 2 || value.length > 200 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
