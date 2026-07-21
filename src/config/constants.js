export const LIFECYCLE_STATUSES = ['candidate', 'approved', 'rejected', 'archived'];
export const JOB_STATUSES = ['pending', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled'];
export const JOB_TYPES = [
  'discover_accounts',
  'fetch_profile',
  'fetch_reels',
  'fetch_transcript',
  'classify_transcript',
  'evaluate_candidate',
  'propose_criteria'
];
export const RECOMMENDATIONS = ['recommended_approve', 'recommended_reject', 'needs_manual_review'];
