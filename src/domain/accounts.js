const USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/i;
const RESERVED_PATHS = new Set(['accounts', 'about', 'developer', 'direct', 'explore', 'p', 'reel', 'reels', 'stories']);

export function normalizeInstagramUsername(input) {
  if (typeof input !== 'string') throw new Error('Instagram username is required');
  let value = input.trim();
  if (!value) throw new Error('Instagram username is required');
  if (/^https?:\/\//i.test(value) || /instagram\.com/i.test(value)) {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'instagram.com') throw new Error('Only instagram.com URLs are supported');
    value = url.pathname.split('/').filter(Boolean)[0] || '';
  }
  value = value.replace(/^@/, '').trim().toLowerCase();
  if (!USERNAME_PATTERN.test(value) || RESERVED_PATHS.has(value)) {
    throw new Error('Invalid Instagram username');
  }
  return value;
}

export function canonicalInstagramUrl(username) {
  return `https://www.instagram.com/${normalizeInstagramUsername(username)}/`;
}

export function isStale(fetchedAt, freshnessMs, now = Date.now()) {
  if (!fetchedAt) return true;
  return now - new Date(fetchedAt).getTime() >= freshnessMs;
}

export function assertTransition(from, to) {
  const allowed = {
    candidate: new Set(['approved', 'rejected']),
    approved: new Set(['archived']),
    archived: new Set(['approved']),
    rejected: new Set()
  };
  if (!allowed[from]?.has(to)) throw new Error(`Lifecycle transition ${from} -> ${to} is not allowed`);
}
