-- Complete first-release schema. This file is applied only to an empty database.
create table schema_metadata (
  singleton boolean primary key default true check (singleton),
  schema_version integer not null check (schema_version > 0),
  installed_at timestamptz not null default now()
);
insert into schema_metadata(singleton, schema_version) values (true, 2);

create table instagram_accounts (
  id bigint generated always as identity primary key,
  username text not null unique,
  instagram_url text not null,
  lifecycle_status text not null default 'candidate',
  source_type text not null,
  source_note text,
  approved_at timestamptz,
  rejected_at timestamptz,
  archived_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounts_username_normalized check (username = lower(username) and username !~ '^@'),
  constraint accounts_lifecycle_check check (lifecycle_status in ('candidate','approved','rejected','archived')),
  constraint accounts_source_check check (source_type in ('discovery','manual','csv','seed'))
);
create index accounts_lifecycle_updated_idx on instagram_accounts(lifecycle_status, updated_at desc);

create table discovery_runs (
  id bigint generated always as identity primary key,
  query text not null,
  requested_limit integer not null check (requested_limit between 1 and 100),
  status text not null default 'pending' check (status in ('pending','running','succeeded','failed','cancelled')),
  found_count integer not null default 0,
  created_count integer not null default 0,
  existing_count integer not null default 0,
  invalid_count integer not null default 0,
  error_summary text,
  created_by text not null default 'admin',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table account_sources (
  id bigint generated always as identity primary key,
  account_id bigint not null references instagram_accounts(id) on delete cascade,
  source_type text not null check (source_type in ('discovery','manual','csv','seed')),
  discovery_run_id bigint references discovery_runs(id) on delete set null,
  search_query text,
  source_note text,
  created_at timestamptz not null default now()
);
create index account_sources_account_idx on account_sources(account_id, created_at desc);
create unique index account_sources_discovery_uidx
  on account_sources(account_id, discovery_run_id, search_query)
  where discovery_run_id is not null;

create table account_profiles (
  id bigint generated always as identity primary key,
  account_id bigint not null unique references instagram_accounts(id) on delete cascade,
  instagram_id text,
  username text,
  display_name text,
  bio text,
  avatar_url text,
  external_url text,
  followers bigint,
  following bigint,
  posts_count bigint,
  verified boolean,
  is_private boolean,
  engagement_rate double precision,
  language text,
  content_category text,
  profile_status text not null check (profile_status in ('available','unavailable','error')),
  provider text,
  unavailable_reason text,
  raw_payload jsonb,
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table reels (
  id bigint generated always as identity primary key,
  account_id bigint not null references instagram_accounts(id) on delete cascade,
  instagram_media_id text,
  shortcode text,
  reel_url text not null,
  caption text,
  published_at timestamptz,
  play_count bigint,
  like_count bigint,
  comment_count bigint,
  thumbnail_url text,
  media_url text,
  provider text,
  raw_payload jsonb,
  transcript_status text not null default 'pending' check (transcript_status in ('pending','available','empty','unavailable','error')),
  transcript_text text,
  transcript_source text,
  transcript_checked_at timestamptz,
  transcript_http_status integer,
  transcript_error text,
  transcript_quality text check (transcript_quality in ('useful','noise','low_value','empty')),
  transcript_quality_reason text,
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reels_identity_check check (instagram_media_id is not null or shortcode is not null)
);
create unique index reels_media_uidx on reels(instagram_media_id) where instagram_media_id is not null;
create unique index reels_shortcode_uidx on reels(shortcode) where shortcode is not null;
create index reels_account_published_idx on reels(account_id, published_at desc nulls last);
create index reels_transcript_idx on reels(transcript_status, transcript_quality);

create table criteria_versions (
  id bigint generated always as identity primary key,
  version_number integer not null unique,
  checklist_markdown text not null,
  search_queries jsonb not null default '[]'::jsonb,
  transcript_rules jsonb not null default '{}'::jsonb,
  status text not null check (status in ('draft','active','rejected','superseded')),
  source text not null check (source in ('seed','manual','llm')),
  parent_version_id bigint references criteria_versions(id) on delete set null,
  diff_summary text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  rejected_at timestamptz
);
create unique index criteria_one_active_idx on criteria_versions((status)) where status = 'active';

create table pipeline_runs (
  id bigint generated always as identity primary key,
  account_id bigint not null references instagram_accounts(id) on delete cascade,
  run_type text not null check (run_type in ('candidate_enrichment','blogger_refresh')),
  reels_limit integer not null check (reels_limit between 1 and 20),
  force_refresh boolean not null default false,
  status text not null default 'pending' check (status in ('pending','running','succeeded','failed','cancelled','insufficient_data')),
  error_summary text,
  created_by text not null default 'admin',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create unique index pipeline_one_active_idx on pipeline_runs(account_id, run_type) where status in ('pending','running');

create table jobs (
  id bigint generated always as identity primary key,
  pipeline_run_id bigint references pipeline_runs(id) on delete cascade,
  discovery_run_id bigint references discovery_runs(id) on delete cascade,
  account_id bigint references instagram_accounts(id) on delete cascade,
  reel_id bigint references reels(id) on delete cascade,
  job_type text not null check (job_type in ('discover_accounts','fetch_profile','fetch_reels','fetch_transcript','classify_transcript','evaluate_candidate','propose_criteria','draft_outreach')),
  status text not null default 'pending' check (status in ('pending','running','retry_wait','succeeded','failed','cancelled')),
  priority integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  dedupe_key text not null unique,
  attempts integer not null default 0,
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  available_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  heartbeat_at timestamptz,
  error_summary text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index jobs_reserve_idx on jobs(status, available_at, priority desc, created_at) where status in ('pending','retry_wait');
create index jobs_account_idx on jobs(account_id, created_at desc);
create index jobs_failed_idx on jobs(finished_at desc) where status = 'failed';

create table job_attempts (
  id bigint generated always as identity primary key,
  job_id bigint not null references jobs(id) on delete cascade,
  attempt_number integer not null,
  provider text,
  outcome text not null check (outcome in ('running','succeeded','failed')),
  http_status integer,
  provider_request_id text,
  error_detail text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(job_id, attempt_number)
);

alter table jobs
  add column current_attempt_id bigint references job_attempts(id) on delete set null;

create table llm_logs (
  id bigint generated always as identity primary key,
  purpose text not null check (purpose in ('candidate_evaluation','criteria_proposal','outreach_proposal')),
  job_id bigint references jobs(id) on delete set null,
  account_id bigint references instagram_accounts(id) on delete set null,
  criteria_version_id bigint references criteria_versions(id) on delete set null,
  base_url text not null,
  model text not null,
  request_messages jsonb not null,
  raw_response jsonb,
  parsed_response jsonb,
  prompt_tokens integer,
  completion_tokens integer,
  latency_ms integer,
  status text not null check (status in ('succeeded','failed')),
  error_detail text,
  created_at timestamptz not null default now()
);
create unique index llm_logs_success_job_uidx
  on llm_logs(job_id, purpose)
  where job_id is not null and status = 'succeeded';

create table evaluations (
  id bigint generated always as identity primary key,
  job_id bigint references jobs(id) on delete set null,
  account_id bigint not null references instagram_accounts(id) on delete cascade,
  criteria_version_id bigint not null references criteria_versions(id),
  recommendation text not null check (recommendation in ('recommended_approve','recommended_reject','needs_manual_review')),
  confidence smallint not null check (confidence between 0 and 100),
  positive_signals jsonb not null default '[]'::jsonb,
  negative_signals jsonb not null default '[]'::jsonb,
  explanation text not null,
  llm_log_id bigint not null references llm_logs(id),
  created_at timestamptz not null default now()
);
create index evaluations_account_idx on evaluations(account_id, created_at desc);
create unique index evaluations_job_uidx on evaluations(job_id) where job_id is not null;

create table outreach_proposals (
  id bigint generated always as identity primary key,
  account_id bigint not null references instagram_accounts(id) on delete cascade,
  job_id bigint references jobs(id) on delete set null,
  llm_log_id bigint references llm_logs(id) on delete set null,
  message_text text not null check (char_length(message_text) between 1 and 5000),
  personalization_reason text not null check (char_length(personalization_reason) between 1 and 5000),
  status text not null default 'draft' check (status in ('draft','approved','rejected','superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  rejected_at timestamptz
);
create unique index outreach_proposals_job_uidx on outreach_proposals(job_id) where job_id is not null;
create index outreach_proposals_account_idx on outreach_proposals(account_id, created_at desc);

alter table criteria_versions
  add column source_job_id bigint references jobs(id) on delete set null;
create unique index criteria_versions_source_job_uidx
  on criteria_versions(source_job_id)
  where source_job_id is not null;

create table audit_events (
  id bigint generated always as identity primary key,
  actor text not null default 'admin',
  action text not null,
  entity_type text not null,
  entity_id bigint,
  old_values jsonb,
  new_values jsonb,
  reason text,
  request_ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index audit_entity_idx on audit_events(entity_type, entity_id, created_at desc);

create table provider_call_logs (
  id bigint generated always as identity primary key,
  provider text not null,
  operation text not null,
  account_id bigint references instagram_accounts(id) on delete set null,
  reel_id bigint references reels(id) on delete set null,
  job_id bigint references jobs(id) on delete set null,
  http_status integer,
  provider_request_id text,
  duration_ms integer,
  outcome text not null check (outcome in ('succeeded','failed')),
  error_payload jsonb,
  created_at timestamptz not null default now()
);
create index provider_logs_job_idx on provider_call_logs(job_id, created_at desc);

create table csv_import_batches (
  id uuid primary key,
  preview_version integer not null check (preview_version = 1),
  row_count integer not null check (row_count >= 0),
  committed_at timestamptz not null default now()
);

create table user_sessions (
  sid varchar not null primary key,
  sess json not null,
  expire timestamp(6) not null
);
create index user_sessions_expire_idx on user_sessions(expire);

create table worker_heartbeats (
  worker_id text primary key,
  process_id integer not null,
  hostname text not null,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now()
);
