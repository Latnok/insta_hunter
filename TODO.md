# Detailed TODO — Express/Node.js migration

Статусы чекбоксов фиксируют фактическое выполнение. Порядок фаз является порядком реализации; переход к следующей фазе допускается после выполнения acceptance gate текущей.

## Phase 0 — Зафиксировать исходники и правила репозитория

- [x] Добавить `.gitignore` для `.env`, `node_modules/`, coverage, logs, temp, backups и локальных PostgreSQL volumes.
- [x] Перенести содержимое `draft/` в `docs/legacy/`, сохранив имена файлов.
- [x] Добавить `docs/legacy/README.md` с пометкой, что Python-скрипты не являются runtime.
- [x] Проверить, что ни один legacy-файл не содержит API keys, session files или абсолютные пути, которые выглядят как секреты.
- [x] Зафиксировать Node.js 20 в `engines` и `.nvmrc`/эквиваленте.
- [x] Создать `package.json` с entrypoints `web`, `worker`, `db:init`, `seed`, `test`, `lint` и `password:hash`.
- [x] Выбрать npm и зафиксировать `package-lock.json`.
- [x] Добавить `.env.example` без реальных секретов и со всеми переменными из архитектуры.

Acceptance gate:

- [x] Новый разработчик видит документацию, устанавливает зависимости и получает понятную ошибку конфигурации без обращения к внешним API.

## Phase 1 — Каркас Node.js-приложения

- [x] Создать ES module структуру `src/` согласно `docs/architecture.md`.
- [x] Реализовать строгий loader/validator env с типами, ranges и production checks.
- [x] Создать Express app factory отдельно от `listen`, чтобы приложение тестировалось in-process.
- [x] Подключить request ID, structured logger, body limits и centralized error handler.
- [x] Подключить EJS и helpers для locale, dates, numbers, status labels и CSRF fields.
- [x] Подключить HTMX локальным asset, без CDN-зависимости production.
- [x] Добавить базовый Material-style CSS: typography, colors, buttons, chips, cards, grid, drawer, dialogs, forms и responsive breakpoints.
- [x] Добавить RU/EN dictionaries и middleware определения языка браузера/cookie.
- [x] Реализовать `/health/live`.

Acceptance gate:

- [x] Web стартует локально, отдаёт bilingual shell и responsive navigation без БД-запросов на liveness.

## Phase 2 — PostgreSQL, миграции и repositories

- [x] Реализовать connection pool, transaction helper и graceful pool shutdown.
- [x] Реализовать безопасный bootstrap полной схемы с advisory lock и отказом от изменения непустой БД.
- [x] Создать единую полную схему всех таблиц из `docs/architecture.md`.
- [x] Добавить check constraints для lifecycle/job/transcript/evaluation/criteria statuses.
- [x] Добавить unique index на normalized username.
- [x] Добавить partial unique index для единственной active criteria version.
- [x] Добавить индексы для account lists, reels ordering, queue reservation, failed jobs и audit lookup.
- [x] Реализовать repositories без динамической конкатенации пользовательского SQL.
- [x] Добавить seed первой criteria version из legacy markdown и текущих search queries.
- [x] Сделать seed идемпотентным и запретить перезапись уже изменённой active-версии.
- [x] Реализовать `/health/ready` с проверкой DB/schema.

Acceptance gate:

- [x] Чистая PostgreSQL-БД проходит schema bootstrap + seed без ошибок; seed идемпотентен по active-версии.
- [x] Все constraints и lifecycle transitions проверены integration tests.

## Phase 3 — Авторизация и безопасность

- [x] Реализовать CLI генерации bcrypt-хэша со скрытым интерактивным вводом.
- [x] Подключить `express-session` с PostgreSQL store.
- [x] Реализовать login/logout и ротацию session ID после login.
- [x] Установить TTL семь дней и rolling expiration.
- [x] Настроить `HttpOnly`, `Secure` production и `SameSite=Lax` cookies.
- [x] Добавить middleware обязательной авторизации для всех страниц/actions, кроме login и health.
- [x] Добавить rate limit login по IP и username.
- [x] Добавить CSRF-защиту для всех POST-действий и HTMX requests.
- [x] Настроить Helmet/CSP для локальных JS/CSS/images и Instagram thumbnails.
- [x] Реализовать audit metadata без записи password/cookie/secret headers.

Acceptance gate:

- [x] Неавторизованный пользователь не читает данные и не выполняет actions.
- [x] CSRF, session fixation, login throttling и cookie flags покрыты security tests.

## Phase 4 — Accounts и импорт

- [x] Реализовать нормализацию username и canonical Instagram URL.
- [x] Отклонять не-Instagram URL, служебные paths, пустые/некорректные usernames.
- [x] Реализовать idempotent account upsert без изменения lifecycle существующего аккаунта.
- [x] Реализовать `account_sources` для повторных источников.
- [x] Реализовать ручное добавление URL/username.
- [x] После нового manual account создавать candidate enrichment run.
- [x] Реализовать CSV parser только для UTF-8 header-based формата.
- [x] Поддержать `url`, `username`, опциональный `source_note`.
- [x] Реализовать file size/row count limits; upload хранится только в памяти запроса.
- [x] Реализовать CSV preview: valid, invalid и duplicate-in-file.
- [x] Реализовать защищённый commit preview через server-side session без доверия скрытым данным клиента.
- [x] Для новых CSV accounts создавать независимые pipeline runs.
- [x] После импорта возвращать пользователя к карточкам кандидатов.

Acceptance gate:

- [x] Повторный URL/CSV не создаёт аккаунт-дубль и не оживляет rejected/archived.
- [x] Некорректный CSV ничего не записывает и показывает ошибки строк.

## Phase 5 — PostgreSQL job queue

- [x] Реализовать enqueue с `dedupe_key` и transaction boundary.
- [x] Реализовать reservation через `FOR UPDATE SKIP LOCKED`.
- [x] Реализовать statuses, attempt records, available time и priorities.
- [x] Реализовать heartbeat/lease для долгих jobs.
- [x] Реализовать recovery только просроченных running jobs.
- [x] Реализовать три попытки и delays 30s/2m/10m.
- [x] Реализовать graceful worker shutdown.
- [x] Реализовать aggregate status `pipeline_runs`.
- [x] Запретить второй active run того же типа для аккаунта.
- [x] Реализовать ручной retry failed job с сохранением истории.
- [x] Реализовать cancel только pending/retry_wait.
- [x] При archive/reject отменять ещё не начатые jobs аккаунта.
- [x] Добавить configurable concurrency и per-provider concurrency guards.

Acceptance gate:

- [x] Два worker процесса не исполняют одну job одновременно.
- [x] Crash/restart после сохранения результата handler не теряет job и не дублирует его DB side effects; внешний read-only API остаётся at-least-once.

## Phase 6 — Provider adapters

- [x] Создать общий HTTP client с timeout, request ID и безопасной обработкой JSON/error.
- [x] Реализовать SocialCrawl profile adapter.
- [x] Реализовать SocialCrawl reels/search/transcript adapters для fallback.
- [x] Реализовать ScrapeCreators search/reels adapters.
- [x] Реализовать ScrapeCreators profile/transcript adapters для fallback.
- [x] Преобразовать ответы обоих providers в единые Profile/Reels/Transcript DTO.
- [x] Реализовать fallback для timeout/network/429/5xx/invalid result/empty result.
- [x] Для 404/unavailable проверять второй provider без бесконечного fallback loop.
- [x] Сохранять request metadata и полный error payload с redaction.
- [x] Сохранять только последний успешный raw profile/reel payload.
- [x] Создать contract fixtures из обезличенных/очищенных примеров.

Acceptance gate:

- [x] Business services и job handlers не знают provider-specific field names.
- [x] Все fallback branches проверяются без live API.

## Phase 7 — Discovery

- [x] Реализовать форму query + limit с default 5 и range 1–100.
- [x] Создавать `discovery_runs` и `discover_accounts` job.
- [x] Показать running/progress/result через HTMX polling.
- [x] Нормализовать, deduplicate и upsert найденные accounts.
- [x] Добавлять source row для каждого query result.
- [x] Не менять lifecycle существующих accounts.
- [x] Не создавать enrichment pipeline после discovery.
- [x] Показывать counts created/existing/invalid/provider errors.

Acceptance gate:

- [x] Discovery создаёт плитки candidates, но очередь enrichment остаётся пустой до индивидуального запуска.

## Phase 8 — Profile и reels enrichment

- [x] Реализовать `fetch_profile` handler с freshness и force refresh.
- [x] Нормализовать available profile и сохранять provider failures в job/provider logs.
- [x] Реализовать profile upsert без истории успешных snapshots.
- [x] Реализовать `fetch_reels` handler с параметром 1–20, default 3.
- [x] Реализовать reel upsert по media ID с shortcode fallback.
- [x] Не стирать валидный transcript при обычном metrics refresh.
- [x] Создавать transcript jobs только для выбранных новых/неполных рилсов или при force refresh.
- [x] Запускать profile и reels jobs параллельно в рамках run.
- [x] Реализовать freshness badge после трёх дней без фонового запуска.

Acceptance gate:

- [x] Обычный повтор использует свежие данные, force refresh вызывает providers, а обновление рилса не создаёт дубль.

## Phase 9 — Transcript, ffmpeg и классификация

- [x] Реализовать transcript chain SocialCrawl → ScrapeCreators → Groq.
- [x] Реализовать Groq URL transcription с model/language из env.
- [x] Реализовать fallback на temp download + ffmpeg 16 kHz mono.
- [x] Установить ffmpeg только в worker image.
- [x] Ограничить download size, duration/timeouts и поддерживаемые content types.
- [x] Удалять temp files в `finally` для success/error/timeout случаев.
- [x] Сохранять transcript status/source/text/error metadata.
- [x] Перенести noise/low-value правила Python-скрипта.
- [x] Загружать regex/пороги из active criteria version.
- [x] Защититься от некорректного regex при активации criteria draft.
- [x] Реализовать quality `empty/noise/low_value/useful`.

Acceptance gate:

- [x] Минимум один useful transcript делает аккаунт потенциально готовым к LLM.
- [ ] После всех тестовых ошибок temp directory остаётся пустой.

## Phase 10 — LLM evaluation

- [x] Реализовать OpenAI-compatible client с base URL/key/model из env.
- [x] Сформировать стабильный prompt из criteria, profile, reels, captions, useful transcripts и ошибок.
- [x] Зафиксировать JSON schema recommendation/confidence/signals/explanation.
- [x] Валидировать output и диапазон confidence.
- [x] Сохранять полный request/raw response/parsed response/usage/latency/error.
- [x] Не логировать LLM API key или Authorization header.
- [x] Реализовать readiness gate: available profile + минимум один useful transcript.
- [x] При недостаточных данных завершать run как `insufficient_data` без LLM-вызова.
- [x] Невалидный LLM JSON считать job failure; не создавать usable evaluation.
- [x] Связывать evaluation с точной criteria version.

Acceptance gate:

- [x] Approve разблокируется только валидной сохранённой evaluation.
- [x] Все сырые и parsed LLM outputs доступны в служебной панели настроек.

## Phase 11 — Решения и lifecycle

- [x] Реализовать approve candidate в одной SQL-транзакции с audit event.
- [x] Повторно проверить lifecycle и evaluation внутри транзакции.
- [x] Реализовать reject прямо с плитки с confirm dialog и причиной.
- [x] Отменять pending/retry_wait jobs после reject.
- [x] Реализовать archive approved-блогера с audit event.
- [x] Реализовать restore archived в approved без автоматического refresh.
- [x] Запретить pipeline для archived.
- [x] Реализовать blogger refresh без candidate evaluation.
- [x] Не менять lifecycle при provider unavailable/error.

Acceptance gate:

- [ ] Все разрешённые переходы работают, запрещённые возвращают 409 и не оставляют частичных изменений.

## Phase 12 — Criteria versions

- [x] Создать settings editor для checklist, search queries и transcript rules.
- [x] Любое manual save создавать как draft с parent/diff summary.
- [x] Валидировать queries и regex до сохранения/активации.
- [x] Реализовать transactional activation единственной версии.
- [x] Реализовать rejection draft без удаления.
- [x] Реализовать выборку только decided + information-complete accounts.
- [x] Реализовать `propose_criteria` job и отдельный LLM prompt.
- [x] Сохранять полный LLM log и новую draft-версию.
- [x] Показывать side-by-side active vs draft и diff summary.
- [x] Не ставить старые evaluations в очередь после activation.

Acceptance gate:

- [x] LLM не может активировать criteria самостоятельно.
- [x] В БД всегда ровно одна active-версия после seed/activation.

## Phase 13 — Полный UI

- [x] Реализовать login screen RU/EN.
- [x] Реализовать общий responsive layout и четыре вкладки.
- [x] Реализовать candidates grid, filters, search и 24-item `Показать ещё`.
- [x] Реализовать основные candidate card states через lifecycle/pipeline/recommendation chips.
- [x] Реализовать быстрые Process/Approve/Reject согласно preconditions.
- [x] Реализовать candidate detail drawer с profile/reels/evaluation/jobs/audit/force refresh.
- [x] Реализовать bloggers grid active/archive и archive/restore.
- [x] Реализовать blogger detail drawer и refresh.
- [x] Реализовать reels grid с thumbnail, metrics, caption/transcript и Instagram link.
- [x] Реализовать reel detail drawer без встроенного видео.
- [x] Реализовать queue filters, retry и cancel.
- [x] Реализовать settings criteria history/editor/proposal и diff summary.
- [x] Реализовать inline errors для HTMX и обычных запросов.
- [x] Не использовать unescaped HTML для внешнего/LLM content.
- [ ] Проверить keyboard navigation, focus trap drawer/dialog, labels и contrast.
- [x] Реализовать browser-local timestamps; visual overflow остаётся для ручного QA.

Acceptance gate:

- [ ] Все обязательные сценарии выполняются без прямого доступа к SQL или CLI.
- [ ] Интерфейс пригоден на desktop и mobile widths.

## Phase 14 — Docker, Caddy и backups

- [x] Создать multi-stage Dockerfile для web/worker.
- [x] Запускать контейнеры не от root.
- [x] Включить ffmpeg в worker runtime image.
- [x] Создать production Compose с internal network и healthchecks.
- [x] Добавить Caddyfile с automatic TLS и upload limits.
- [x] Не публиковать PostgreSQL наружу по умолчанию.
- [x] Создать persistent PostgreSQL/caddy/backup volumes.
- [x] Не создавать persistent media volume.
- [x] Реализовать daily compressed pg_dump и retention 7 copies.
- [x] Реализовать manual backup command.
- [ ] Документировать и проверить restore в отдельную БД.
- [x] Добавить deploy/runbook команды из `docs/operations.md` и README.

Acceptance gate:

- [ ] Чистый VPS с Docker Compose поднимает приложение, TLS, worker, БД и backup без ручного изменения image.

## Phase 15 — Тестирование

### Unit

- [x] URL/username normalization и invalid Instagram paths.
- [x] CSV headers/rows/deduplication.
- [x] Lifecycle state machine.
- [x] Freshness boundary rules.
- [x] Transcript classifier и invalid regex.
- [x] LLM JSON schema и OpenAI-compatible parsing.
- [x] Locale selection; browser date formatting проверяется UI smoke/ручным QA.

### Integration

- [x] Migrate/seed на чистой временной PostgreSQL-БД.
- [x] Repository queries и constraints.
- [x] Login/session/CSRF и rate-limit tests проходят через реальный Express + PostgreSQL.
- [x] Queue locking с несколькими workers.
- [x] Retry path проверен реальным worker без API-ключей; lease/dedupe/cancel требуют расширенного integration suite.
- [x] Atomic approve/reject/archive/restore.
- [ ] Criteria activation concurrency.

### Contract

- [x] SocialCrawl success/error/schema-change fixtures.
- [x] ScrapeCreators success/error/schema-change fixtures.
- [x] Primary search и profile fallback paths.
- [ ] Groq URL/file transcription mocks.
- [ ] OpenAI-compatible valid/invalid/timeout/429 outputs.

### End-to-end

- [x] Discovery сохраняет accounts без enrichment.
- [x] Manual URL автоматически запускает pipeline — проверено HTTP smoke-тестом.
- [x] CSV preview/commit автоматически запускает новые accounts; atomic integration-тест проверяет два pipeline и четыре стартовых jobs.
- [ ] Insufficient data блокирует approve.
- [ ] Useful transcript запускает LLM.
- [ ] Human approve/reject и audit.
- [ ] Blogger refresh без evaluation.
- [ ] Archive/restore и job cancellation.
- [ ] Manual criteria draft/activation.
- [ ] LLM criteria proposal остаётся draft.
- [ ] RU/EN, filters, drawer и `Показать ещё`.

### Security and operational

- [ ] XSS payloads в bio/caption/transcript/LLM.
- [x] Скан исходников не нашёл реальных API-ключей; logger/provider paths используют redaction.
- [ ] Upload size/content abuse.
- [ ] Temp file cleanup.
- [x] Production image собирается, runtime использует user `node`, PostgreSQL не публикуется production Compose.
- [ ] Backup creation and restore drill.
- [ ] Graceful restart во время running job.

Acceptance gate:

- [x] Default test suite не вызывает платные live API.
- [ ] Отдельный opt-in live smoke suite документирует ожидаемый расход кредитов.

## Phase 16 — Release readiness

- [ ] Заполнить production `.env` через безопасный канал.
- [ ] Настроить DNS и проверить Caddy certificate issuance.
- [ ] Создать первый backup до загрузки реальных данных.
- [ ] Выполнить schema bootstrap/seed и проверить единственную active criteria version.
- [ ] Проверить login/logout и session expiry.
- [ ] Выполнить один manual URL pipeline с лимитом 1–3 рилса.
- [ ] Проверить fallback путём контролируемого mock/staging failure.
- [ ] Проверить approve, reject, archive и restore.
- [ ] Проверить criteria proposal и ручную активацию draft.
- [ ] Выполнить restore последнего backup в отдельную БД.
- [x] Собрать локальный production image `instagram-hunter:test` и применить полную `db/schema.sql` на пустой БД.
- [x] Обновить README фактическими командами запуска и текущим статусом.

Definition of Done:

- [x] Node.js runtime и production image не зависят от Python или Instaloader.
- [ ] Все действия выполняются из закрытого RU/EN интерфейса.
- [x] Нет автоматических расписаний или автоматического approve.
- [x] Все ручные решения и LLM-вызовы сохраняются в audit/LLM logs.
- [x] Jobs имеют dedupe/retry, а временные медиа удаляются и не имеют persistent volume.
- [ ] Production deployment, backup и restore воспроизводимы по документации.
# Production deployment — 2026-07-21

- [x] Прогнать syntax/EJS check в Docker test-stage.
- [x] Прогнать 17 automated tests без ошибок.
- [x] Собрать единый production image `instagram-hunter:0.1.0` вне VPS.
- [x] Развернуть проект изолированно в `/opt/instagram-hunter`.
- [x] Использовать отдельный Compose project `insta_hunter`, network и volumes.
- [x] Опубликовать web только на `127.0.0.1:13002`.
- [x] Не запускать Caddy на общем сервере.
- [x] Создать production `.env` с mode `600` и уникальными секретами.
- [x] Применить историческую production-схему и seed отдельными one-shot контейнерами.
- [x] Поднять PostgreSQL, web, worker и backup с memory limits.
- [x] Добавить отдельный Nginx-vhost `insta.podedu.ru` без изменения существующих vhost.
- [x] Выпустить Let's Encrypt certificate и включить auto-renew.
- [x] Проверить HTTP→HTTPS redirect, readiness и login form.
- [x] Проверить реальный CSRF/login/session flow.
- [x] Выполнить и проверить первый PostgreSQL backup.
- [x] Восстановить и проверить `checkit` после reboot.
- [x] Оставить `million-items-postgres` остановленным по указанию владельца.
- [ ] Заполнить production provider API keys.
- [ ] Заполнить production LLM API key и model.
- [ ] Выполнить live smoke test discovery на одном username с малыми лимитами.
- [ ] Выполнить live profile/reels/transcript smoke test на одном кандидате.
- [ ] Выполнить live LLM evaluation и criteria proposal smoke test.
- [ ] Провести restore drill последнего production backup в отдельную временную БД.
- [ ] Освободить место на VPS: root filesystem сейчас около 93%.
- [ ] Решить вопрос со swap либо документировать внешнее ограничение на тяжёлые операции.
## Production update — 2026-07-21

- [x] Configure ScrapCreators, SocialCrawl and Groq credentials from the existing Hermes server environment without exposing their values.
- [x] Configure OpenAI through `LLM_API_KEY` with model `gpt-5.6-terra`.
- [x] Verify live discovery: one account was found and added for the query `обзор одежды wildberries`.
- [x] Verify live profile and reels retrieval through the configured providers.
- [x] Verify Groq Whisper transcription and classifier execution on three real reels.
- [x] Verify a minimal OpenAI structured-JSON request against `gpt-5.6-terra`.
- [x] Reject provider-level `not found` payloads returned with HTTP 200.
- [x] Normalize nested reel media URLs and play-count fields returned by providers.
- [x] Remove unsupported `temperature: 0` for GPT-5.6 Terra.
- [x] Clear stale `error_summary` when a retried job succeeds; clean the one historical affected row.
- [x] Deploy production image `instagram-hunter:0.1.4` to web and worker.
- [x] Pass the full Docker test stage: 19/19 tests, 43 JavaScript files and 14 EJS templates checked.
- [ ] Run an end-to-end candidate evaluation on a reel with a useful spoken clothing review. The three sampled reels contained only noise, so the correct result was `insufficient_data`.

## Plan execution — 2026-07-22

- [x] Add a disposable PostgreSQL integration environment in `compose.integration.yaml` using `tmpfs`.
- [x] Add repository and database-constraint integration coverage.
- [x] Verify account upsert idempotency and preservation of rejected lifecycle state.
- [x] Verify normalized account, discovery-limit, pipeline-limit, active-run, reel-identity, job-dedupe, attempts and single-active-criteria constraints.
- [x] Verify reject atomically cancels pending jobs and records an audit event.
- [x] Verify approve requires an evaluation and approve/archive/restore records all transitions.
- [x] Fix lifecycle SQL parameter binding exposed by the new integration suite.
- [x] Pass 5/5 PostgreSQL integration tests and the default 19-test suite.
- [x] Deploy the lifecycle fix as `instagram-hunter:0.1.5`.
- [x] Add security integration tests for CSRF, session rotation, production cookie flags and login throttling.
- [x] Enforce login throttling independently by IP and normalized username.
- [x] Pass 9/9 PostgreSQL integration/security tests and the default 19-test suite.
- [x] Prepare production image `instagram-hunter:0.1.6` with the username throttling fix.
- [x] Add concurrent queue tests for enqueue dedupe and `FOR UPDATE SKIP LOCKED` reservation.
- [x] Add lease-expiry recovery and max-attempt retry integration tests.
- [x] Close an expired running attempt as failed before scheduling its replacement.
- [x] Pass 13/13 PostgreSQL integration/security/queue tests and the default 19-test suite.
- [ ] Prove idempotency of every external side effect across a crash after the provider call but before `completeJob`; queue-level recovery alone provides at-least-once execution.
- [x] Prepare production image `instagram-hunter:0.1.7` with atomic stale-attempt recovery.
- [x] Add job-bound LLM/evaluation/proposal results to the complete first-release `db/schema.sql`.
- [x] Deduplicate repeated discovery sources and transcript classifier jobs.
- [x] Reuse persisted evaluation and criteria-proposal results after worker restart without another LLM call.
- [x] Fix JSONB serialization for LLM messages, signal arrays and search-query arrays.
- [x] Pass 17/17 PostgreSQL integration/security/queue/idempotency tests and the default 19-test suite.
- [x] Prepare production image `instagram-hunter:0.1.8` and migration rollout.
- [x] Add sanitized SocialCrawl and ScrapeCreators success/error/schema-change fixtures.
- [x] Cover network, 404, 408, 429, 5xx, invalid JSON, empty result and non-retryable 400 branches without live API.
- [x] Prove discovery creates candidate/source rows without enrichment jobs.
- [x] Prove fresh profile/reels use cache while force refresh calls providers and upserts the existing reel.
- [x] Pass 30/30 PostgreSQL integration tests and 50/50 default tests.

## Debug-аудит — 2026-07-22

Проверено локально:

- `npm run check`: успешно, 55 JavaScript-файлов и 14 EJS-шаблонов.
- `npm test`: 50 default-тестов успешно; отдельный PostgreSQL-прогон — 31/31.
- `npm audit --omit=dev`: 0 известных уязвимостей.
- Docker integration suite выполнен на одноразовой PostgreSQL 16; контейнеры, сеть, volume и тестовые образы удалены.
- Состав первого Git-коммита проверен на секреты и временные артефакты.

### P0 — корректность и безопасность

- [x] Зафиксировать воспроизводимый Git baseline: проверить отсутствие секретов и создать первый commit. Tag и push выполняются отдельно после решения о публикации.
- [x] Реализовать настоящий heartbeat долгих jobs: worker обновляет lease текущего attempt каждые 30 секунд; integration-тест доказывает, что живой job не выдаётся второму worker.
- [x] Добавить fencing по `locked_by` и `current_attempt_id` во все `heartbeatJob`/`completeJob`/`failJob`; результат старого worker после recovery отбрасывается.
- [x] Исправить recovery на границе попыток: stale job с `attempts >= max_attempts` становится `failed`; crash на последней разрешённой попытке покрыт тестом.
- [x] Сделать cancel/reject/archive согласованными с pipeline: активный run и jobs отменяются атомарно, running attempt закрывается и fencing отбрасывает поздний результат; handler повторно проверяет lifecycle перед записью и созданием downstream jobs.
- [x] Сделать manual cancel/retry согласованными с terminal state: cancel завершает весь связанный pipeline, а разрешённый retry атомарно возвращает failed pipeline в `running`.
- [x] Закрыть SSRF в Groq fallback download: валидировать protocol/host/IP `media_url`, запрещать loopback, private/link-local и metadata endpoints, учитывать DNS rebinding и редиректы.
- [x] Ограничивать media download потоково, прекращая чтение после 25 MB.
- [x] Добавить общий abort для in-flight provider/LLM операций при shutdown: единый `AbortSignal` проходит через semaphore, HTTP providers, LLM, Groq, DNS/media download и `ffmpeg`; shutdown не запускает provider fallback, а `ffmpeg` получает `SIGKILL`.
- [x] Вынести `/health/live` до PostgreSQL session/CSRF middleware, отключить пустые anonymous sessions и проверить отсутствие обращения liveness к БД.
- [x] Не раскрывать внутренние ошибки клиенту: HTMX 5xx и `/health/ready` возвращают безопасный ответ, детали остаются в structured log.

### P1 — надёжность и тестируемость

- [x] Не маскировать технический failure как `insufficient_data`: исчерпание обязательного profile/reels или всех transcript/classify jobs без полезного результата завершает pipeline как `failed` с агрегированным `error_summary`; `insufficient_data` остаётся для успешно обработанных пустых/шумовых данных.
- [x] Защитить worker slot от тихой остановки: `reserveJob`, terminal job update и `maybeAdvancePipeline` изолированы supervisor-ом с backoff; каждый slot публикует отдельный heartbeat, healthcheck проверяет ожидаемое число живых slots, временные DB failures покрыты тестами.
- [x] Ограничить manual retry значением DB constraint: бюджет увеличивается максимум до 10 попыток, а retry при `attempts >= 10` возвращает контролируемый конфликт.
- [x] Сделать CSV commit атомарным для всего preview: account sources, новые accounts, pipeline runs, jobs и batch marker записываются одной транзакцией; ошибка любой строки откатывает всё.
- [x] Ужесточить CSV contract: fatal UTF-8 decode, обязательный `username`/`url`, только `username,url,source_note`, уникальные headers и строгая длина строк; Multer/parser errors нормализованы в 400/413 и покрыты abuse-тестами.
- [x] Выдавать CSV preview одноразовый ID/version: сессия хранит до пяти независимых preview с TTL 15 минут, commit использует UUID/version, а `csv_import_batches` обеспечивает DB-level идемпотентность при повторных и конкурентных запросах.
- [ ] Логировать каждую provider attempt, а не только итогового победителя: сохранять failed fallback calls и ошибку Groq fallback с duration/status/request ID, применяя рекурсивную redaction к response payload перед записью в `provider_call_logs`.
- [x] При успешном retry очищать stale error state не только у `jobs`, но и у `discovery_runs`/`pipeline_runs`: manual retry атомарно переоткрывает связанный run, а переходы в `running`/`succeeded` очищают `error_summary` и несовместимый `finished_at`; regression-тесты покрывают оба типа run.
- [ ] Валидировать и ограничивать `offset`, `status`, `quality` и `jobType` query-параметры. Отрицательный/NaN/чрезмерный offset сейчас доходит до PostgreSQL и превращает пользовательскую ошибку в 500; предпочтительнее cursor pagination для меняющихся списков.
- [x] Сериализовать выделение `criteria_versions.version_number`: manual/LLM drafts используют общий transactional service и advisory lock, общий также с activation; 12 конкурентных транзакций получают последовательные версии без unique violation.
- [ ] До первого изменения production-схемы утвердить отдельный DBA-процесс upgrade/rollback; bootstrap полной схемы намеренно не модифицирует непустую БД.
- [ ] Вынести PostgreSQL suites в обязательную CI-команду. Обычный `npm test` сейчас зелёный при трёх пропущенных integration/security/queue suites; CI должна поднимать временную БД и падать при skip.
- [x] Добавить regression-тесты для running-job cancellation race и cancel→pipeline terminal state. Lease fencing, stale-job max attempts, liveness, безопасные 5xx и SSRF/media size limits также покрыты.

### P2 — качество эксплуатации и интерфейса

- [ ] Завершить RU/EN локализацию: settings, queue, CSV, ошибки и многие подписи шаблонов сейчас захардкожены на английском вне словарей `src/i18n/index.js`.
- [ ] Добавить operational telemetry: queue depth/age, retry/failure rate, lease recovery count, active worker slots, provider latency/fallback rate, pipeline duration и сигнал застрявших active runs.
- [ ] Добавить retention/cleanup policy для `user_sessions`, `provider_call_logs`, `llm_logs`, `audit_events`, `job_attempts`, завершённых jobs и raw provider/LLM payload, с оценкой объёма и требованиями к персональным данным.
