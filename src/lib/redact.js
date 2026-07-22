const sensitiveKey = /(?:authorization|cookie|password|secret|token|api[-_]?key|x-api-key)/i;
const credentialText = /(?:Bearer\s+)[^\s,;]+|sk-(?:proj-)?[A-Za-z0-9_-]{12,}/gi;

function redactString(value) {
  let redacted = value.replace(credentialText, '[REDACTED]');
  try {
    const url = new URL(redacted);
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveKey.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    redacted = url.toString();
  } catch {
    // Most strings are not URLs.
  }
  return redacted;
}

export function redactSensitive(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    sensitiveKey.test(key) ? '[REDACTED]' : redactSensitive(item, seen)
  ]));
}
