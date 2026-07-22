# Production status

Last verified: 2026-07-22.

## Deployment

- Public URL: `https://insta.podedu.ru`
- Server directory: `/opt/instagram-hunter`
- Compose project: `insta_hunter`
- Application image: `instagram-hunter:0.1.10`
- Active database: `instagram_hunter_v1`, complete schema version `1`.
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

## Next operational action

The OpenAI key was shared in chat. Rotate it in the OpenAI dashboard, update only `LLM_API_KEY` in `/opt/instagram-hunter/.env`, and recreate `web` and `worker`. Do not change the provider keys or other projects during that rotation.
