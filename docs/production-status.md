# Production status

Last verified: 2026-07-21.

## Deployment

- Public URL: `https://insta.podedu.ru`
- Server directory: `/opt/instagram-hunter`
- Compose project: `insta_hunter`
- Application image: `instagram-hunter:0.1.8`
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
- Latest verification: 29/29 integration tests and 50/50 default tests pass without live API calls.

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

The Git first-release baseline contains one complete `db/schema.sql` and no migration chain. The bootstrap only initializes an empty database or validates that the required tables already exist. Production's historical migration records remain untouched.

## Next operational action

The OpenAI key was shared in chat. Rotate it in the OpenAI dashboard, update only `LLM_API_KEY` in `/opt/instagram-hunter/.env`, and recreate `web` and `worker`. Do not change the provider keys or other projects during that rotation.
