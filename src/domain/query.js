export const jobStatuses = ['pending', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled'];
export const jobTypes = [
  'discover_accounts',
  'fetch_profile',
  'fetch_reels',
  'fetch_transcript',
  'classify_transcript',
  'evaluate_candidate',
  'propose_criteria'
];
export const transcriptQualities = ['useful', 'noise', 'low_value', 'empty'];

function badQuery(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function optionalString(value, name) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw badQuery(`${name} must be a single value`);
  return value;
}

export function parseOffset(value, max = 10_000) {
  const raw = optionalString(value, 'offset');
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) throw badQuery(`offset must be an integer between 0 and ${max}`);
  const offset = Number(raw);
  if (!Number.isSafeInteger(offset) || offset > max) {
    throw badQuery(`offset must be an integer between 0 and ${max}`);
  }
  return offset;
}

export function parseOptionalEnum(value, allowed, name) {
  const parsed = optionalString(value, name);
  if (parsed === undefined) return undefined;
  if (!allowed.includes(parsed)) throw badQuery(`${name} must be one of: ${allowed.join(', ')}`);
  return parsed;
}

export function parseListQuery(query, { statuses, qualities, types } = {}) {
  const search = optionalString(query.search, 'search');
  if (search && search.length > 100) throw badQuery('search must contain at most 100 characters');
  const parsed = { offset: parseOffset(query.offset) };
  const status = statuses ? parseOptionalEnum(query.status, statuses, 'status') : undefined;
  const quality = qualities ? parseOptionalEnum(query.quality, qualities, 'quality') : undefined;
  const jobType = types ? parseOptionalEnum(query.jobType, types, 'jobType') : undefined;
  if (search !== undefined) parsed.search = search;
  if (status !== undefined) parsed.status = status;
  if (quality !== undefined) parsed.quality = quality;
  if (jobType !== undefined) parsed.jobType = jobType;
  return parsed;
}
