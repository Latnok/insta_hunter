# Production status

Last verified: 2026-07-22.

## Deployment

- Public URL: `https://insta.podedu.ru`
- Server directory: `/opt/instagram-hunter`
- Compose project: `insta_hunter`
- Application image: `instagram-hunter:0.2.2`
- Active database: `instagram_hunter_v2`, complete schema version `2`.
- Web binding: `127.0.0.1:13002`; public traffic terminates at the system Nginx.
- TLS certificate is managed by Certbot and is valid through 2026-10-19.
- PostgreSQL is reachable only inside the Compose network.
- The `.env` file is owned by `root:root` with mode `0600`.

The shared-server constraints are intentional: `checkit` must remain running, while `million-items-postgres` must remain stopped. Updating Instagram Hunter must use the explicit project name and both Compose files so that unrelated projects are not recreated:

```bash
cd /opt/instagram-hunter
docker compose -p insta_hunter -f compose.yaml -f compose.server.yaml up -d --no-build
```

## Configured integrations

Provider credentials for ScrapCreators, SocialCrawl and Groq were copied server-side from the existing Hermes environment without printing their values. OpenAI is configured via `LLM_API_KEY`; the selected model is `gpt-5.6-terra`. Never commit or paste the production `.env` contents into logs or documentation.

## Live verification

- Discovery query `обзор одежды wildberries`, limit 1: one account found and created.
- Profile fetch: succeeded.
- Reels fetch: succeeded after supporting nested `video_versions[0].url` payloads.
- Groq Whisper: succeeded for three real reels.
- Classifier: succeeded for all three transcripts; all were noise, therefore the pipeline correctly finished as `insufficient_data`.
- OpenAI structured-JSON smoke: succeeded with `gpt-5.6-terra`.
- Automated test stage: 19/19 default tests passed; 47 JavaScript files and 14 EJS templates were checked.
- PostgreSQL integration/security/queue/idempotency stage: 17/17 tests passed against a disposable PostgreSQL 16 instance.
- Latest verification: 32/32 integration tests and 54/54 default tests pass without live API calls; syntax checks cover 59 JavaScript files and 14 EJS templates.
- Required GitHub Actions CI now runs syntax, default, PostgreSQL integration and high-severity production dependency audit gates on pushes to `master` and pull requests.

No real candidate recommendation was produced from the sampled account because its reels contained no useful spoken review. This is a content limitation, not an integration failure.

## Production fixes included through 0.1.8

1. Treat provider-level “not found” responses as failures even when the upstream HTTP status is 200.
2. Normalize nested reel video/image URLs and provider-specific play-count fields.
3. Omit `temperature: 0`, which is unsupported by GPT-5.6 Terra.
4. Clear `jobs.error_summary` after a retry succeeds. One pre-existing successful row with a stale error was cleaned during deployment.
5. Send only the SQL parameters actually referenced by approve/archive/restore lifecycle updates; integration tests caught the previous PostgreSQL bind error.
6. Apply login throttling independently to the client IP and normalized username; verify CSRF, session rotation and production cookie flags automatically.
7. When a worker lease expires, atomically close the abandoned attempt as failed before returning its job to `retry_wait`.
8. Bind successful LLM results, evaluations and criteria drafts to their originating job so a worker restart reuses the committed result.
9. Deduplicate discovery sources and classify jobs, and explicitly serialize JavaScript arrays stored in JSONB columns.

The Git first-release baseline contains one complete `db/schema.sql` and no migration chain. Release `0.1.9` moved production through the approved blue/green DBA process to a new database initialized from that complete schema. Bootstrap and readiness now require all schema tables plus exact `schema_metadata.schema_version` compatibility.

## Deployment 0.1.9

- Source release: commit `4f4aff6`; GitHub Actions for the schema-contract commit passed before rollout.
- A pre-cutover backup and a final backup after stopping web/worker were created successfully.
- Data was transferred from the historical database without `schema_migrations`; all 15 shared tables had exact source/target row counts after writers stopped.
- Rehearsal web and production web returned `200` from `/health/ready`; public `/login` returned `200` over HTTPS.
- The first full backup of `instagram_hunter_v1` was restored into an isolated temporary database and verified at schema version `1` with four accounts.
- `BACKUP_DATABASE=instagram_hunter_v1` makes the backup service follow the active blue/green database instead of the original PostgreSQL database name.
- The old database, pre-cutover `.env` and image `0.1.8` are retained for the rollback window. Temporary transfer archives, rehearsal dumps and the historical stopped migrate container were removed.
- After rollout, web and worker are healthy; `checkit` remains healthy and `million-items-postgres` remains stopped.
- Root filesystem usage is approximately 95%, with about 2.1 GB free. Avoid server-side image builds and perform a separately approved Docker storage cleanup before the next large release.

## Hermes test dataset import

On 2026-07-22, parsed test data was copied read-only from `hermes-stack-postgres` into the active `instagram_hunter_v1` database. The import was rehearsed twice against a restored production backup before execution and is idempotent by normalized username plus reel media ID/shortcode.

- Current totals: 41 accounts, 41 profiles and 58 reels.
- Imported source payload: 34 detailed blogger profiles, 55 reels and five search-only candidates; two usernames already existed in Instagram Hunter.
- Transcript totals: 31 useful, 26 noise and one low-value transcript. The noise total includes three reels that existed before the import.
- Existing account lifecycle was preserved. A newer existing profile was not overwritten by an older Hermes snapshot.
- The production transaction created one discovery-run provenance record and one audit event.
- Post-import backup `instagram_hunter_20260722T055517Z.dump` has SHA-256 `9bc6a0a0c9b739e592d7b9a4dd1b3658d5181bbd59cc40ed2a71e533de6c4cd3`; it was restored successfully into an isolated temporary database and verified at schema version `1` with 41 accounts and 58 reels.
- Temporary SQL/CSV files were removed from the host and both PostgreSQL containers. Hermes data and schema were not modified.

## Deployment 0.1.10

Release `0.1.10` simplifies candidate discovery without changing the database schema. The visible Discovery runs table and its polling endpoint were removed. The candidate page now labels the manual search query and result limit, separates direct account/CSV import, and can enqueue the existing `propose_criteria` LLM job to generate search phrases from decided information-complete accounts. The page polls that background job, fills the first returned query automatically, and offers the remaining queries as explicit alternatives. The generated criteria remains a draft until an administrator activates it.

Local syntax/unit/UI tests passed (59 tests, 56 passed and three integration suites skipped without a database). The isolated Docker integration run passed all 34 PostgreSQL-backed tests, including the authenticated CSRF-protected LLM suggestion route. The release tar SHA-256 was `355ffbf4019c0663cb0e64157bd9a880c85b41e1c67a05c0a9eee1825c3703a5`. Production web and worker run `instagram-hunter:0.1.10`, both are healthy, and `https://insta.podedu.ru/health/ready` returns `ready`. Pre-rollout backup: `instagram_hunter_20260722T064431Z.dump`.

## Deployment 0.1.11

The first live LLM search-query proposal exposed a provider-contract edge case: the model returned Python-style inline regex flags such as `(?i)`, while JavaScript applies case-insensitive Unicode flags externally. Release `0.1.11` explicitly requests JavaScript-compatible regex and normalizes leading `(?i)`, `(?u)` and `(?iu)` flags before validation, logging and draft persistence. The discovery UI now distinguishes an automatic retry from active generation and shows the retry reason. Local tests passed (60 tests, 57 passed); the isolated PostgreSQL integration run passed all 34 tests, including persistence of normalized LLM rules.

Release `0.1.12` restores the latest successful LLM search-query list whenever the candidate page opens. This makes completed suggestions persistent across refreshes, fills the first query without another LLM call, preserves all alternatives, and provides a separate explicit action to regenerate them.

Release `0.1.13` removes the ambiguous row of query buttons. The first LLM result is rendered directly into a larger search field, alternative phrases are exposed through the field's native suggestion list, and only the primary `Найти кандидатов` action starts discovery. A completed asynchronous LLM job refreshes the page automatically so the generated value appears without a second action.

## Deployment 0.2.0

Release commit `eb6a0940b2225dec668eacd562f5cc66c02a0afb` was pushed to `origin/master`. The release archive SHA-256 was `643a058d05d2061bdd86a2289dcb4c2b6d32afbdaf36a6b2d29c6ce3414aacc4`; the immutable local image ID is `sha256:e7fcccbc67a2a95b6960c48b34d1c25d44d414f06b54364708cf778dc84cd0ce`.

The release adds a personalized barter-outreach workflow. First approval of a candidate atomically enqueues `draft_outreach`; the LLM stores a message and a separate internal personalization reason. The administrator can edit and approve the current text in one action, reject it or request another draft. The drawer polls while generation is active. No external message is sent.

The schema-changing release used the approved blue/green process. A full rehearsal restored schema v1, initialized schema v2 from the complete `db/schema.sql`, copied all existing data and compared exact counts for 17 transferred tables. The release image accepted only v2 and the rollback image accepted only v1. The rehearsal web returned healthy liveness and readiness.

Production writers were stopped at `2026-07-22T08:47:23Z` and restarted on v2 at `2026-07-22T08:47:37Z`. All transferred counts matched: 43 accounts, 42 profiles, 64 reels, 51 jobs, 68 job attempts, six LLM logs, one evaluation and one active criteria version. The new `outreach_proposals` table started empty. Public HTTPS readiness, web health and both worker heartbeats passed after cutover.

Rollback assets are retained under `/opt/instagram-hunter-rollbacks/0.2.0`: application `0.1.12`, its protected environment file and the unchanged `instagram_hunter_v1` database. Final v1 dump SHA-256: `5a78daaf018799b7691330f4c0d5620d38ffe3cff5aac460430f9faa57b2a0c6`. The pre-cutover dump SHA-256 is `187986d14b4b7b2630c8645aec24c2ea1a01492640f9c39bc31bc7bcb96d767e`. Temporary rehearsal databases, scripts, archives and images `0.1.1`–`0.1.11` were removed. `checkit` remained healthy and `million-items-postgres` remained stopped.

## Deployment 0.2.1

Release commit `fed2fac` adds editable, versioned prompts for candidate analysis and barter-offer generation. Commit `2fc64c3` includes the accompanying user README edit; both commits were pushed to `origin/master` before the release archive was created. The archive SHA-256 was `fade21accc90f5993abc5f9dddcc6ad8607906e7ce9cf3266fd7966b778e43f2`; the immutable image ID is `sha256:637f04c815f315885d9431ca27c44a8cbdeebd5ff3642bb5da29195cabfe7619`.

This is a schema-compatible release. Prompts are stored inside the existing `criteria_versions.transcript_rules` JSONB document. Existing active criteria use safe built-in defaults until an administrator saves and explicitly activates a prompt draft. The structured JSON response contract remains enforced in code.

Syntax and default/UI tests passed 64/64, the disposable PostgreSQL 16 suite passed 37/37 on clean schema v2, and `npm audit --omit=dev --audit-level=high` found no known vulnerabilities. The server build repeated the 64-test gate. Pre-deployment backup: `instagram_hunter_20260722T090256Z.dump`.

After rollout, schema check reports expected and actual version `2`; public and local readiness return `ready`; `/login` returns HTTP 200; web and worker are healthy on `instagram-hunter:0.2.1`. `checkit` remains healthy and `million-items-postgres` remains stopped. Temporary release archives and build directories were removed. Image `0.2.0` and the established `0.2.0` rollback assets remain available.

## Deployment 0.2.2

Release commit `7b523e64f57e0999c51c50acdf9cf66380b79b70` was pushed to `origin/master`. The release archive SHA-256 was `40aef19f8876c2cb6aecfd570c34512c69f79773bd298b3d51f9ef3fc890f49d`; the immutable image ID is `sha256:fa50f72fbe0b90e5b0bf40f39b124e941b536e7512f7cb97e26eccba64157e35`. Pre-deployment backup: `instagram_hunter_20260722T094006Z.dump`.

This schema-compatible release adds the five-minute scheduler, threshold/24-hour LLM criteria drafts, versioned automation settings, a global daily discovery budget, query/job deduplication and uncertainty-first candidate ordering. LLM criteria now include an explicit selection model, and immutable system instructions treat all social/profile/rejection text as untrusted data to reduce prompt-injection risk.

Syntax/default/UI tests passed 67/67 and the isolated PostgreSQL 16 suite passed 41/41 against clean schema v2. The server build repeated the 67-test gate; the production dependency audit found no known vulnerabilities.

The first production scheduler cycle correctly found no new decisions for a criteria draft and queued four low-priority discovery jobs for the configured daily budget of 20 accounts. All four queries succeeded; three required bounded retry after transient/no-result responses. SocialCrawl currently reports zero credits, so ScrapCreators is effectively the only working discovery provider until that external account is replenished.

Schema compatibility, local/public readiness, login and worker heartbeat passed. Web and worker are healthy on `instagram-hunter:0.2.2`; `checkit` remains healthy and `million-items-postgres` remains stopped. Temporary release files were removed.

## Deployment 0.2.3

This schema-compatible release makes discovery feed the existing candidate-processing pipeline automatically. Every discovered account that is still a candidate and has no prior pipeline gets profile and reels enrichment, transcript processing and, when useful content exists, an LLM evaluation. Rediscovery is idempotent: active and completed pipelines are not restarted, and non-candidate lifecycle states are preserved.

Syntax/default/UI tests passed 67/67, the isolated PostgreSQL 16 suite passed 41/41 against clean schema v2, and the production dependency audit found no known vulnerabilities.

## Next operational action

The OpenAI key was shared in chat. Rotate it in the OpenAI dashboard, update only `LLM_API_KEY` in `/opt/instagram-hunter/.env`, and recreate `web` and `worker`. Do not change the provider keys or other projects during that rotation.
