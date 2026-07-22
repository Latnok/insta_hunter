# Архитектура и SQL-модель

## 1. Технологический стек

- Node.js 20, JavaScript с ES modules.
- Express для HTTP.
- EJS для server-side rendering.
- HTMX для partial updates, форм и боковых панелей.
- PostgreSQL и пакет `pg`; ORM и query builder не используются.
- Одна полная схема `db/schema.sql`; bootstrap применяет её только к пустой БД и не меняет существующую.
- Отдельные процессы `web` и `worker` из общей кодовой базы.
- PostgreSQL-backed очередь без Redis.
- Caddy как TLS reverse proxy.
- Docker Compose как единственный production-вариант развёртывания MVP.

## 2. Предлагаемая структура проекта

```text
src/
  app.js                 Express composition
  server.js              web entrypoint
  worker.js              worker entrypoint
  config/                env validation and constants
  db/                    pool, transactions, repositories
  routes/                page and action routes
  services/              business use cases
  jobs/                  job handlers and orchestration
  providers/             SocialCrawl, ScrapeCreators, Groq, LLM
  views/                 EJS pages and partials
  public/                CSS, browser JS, icons
  i18n/                  ru/en dictionaries
db/schema.sql            complete first-release PostgreSQL schema
docs/legacy/             archived Python scripts and original plans
tests/                    unit, integration, contract and e2e
```

Границы модулей обязательны: routes не выполняют SQL и не вызывают внешние API напрямую; job handlers используют services; provider adapters возвращают нормализованные DTO.

## 3. Конфигурация

Обязательные production variables:

```text
NODE_ENV=production
DATABASE_URL=
ADMIN_USERNAME=
ADMIN_PASSWORD_HASH=
SESSION_SECRET=
APP_DOMAIN=
SCRAPECREATORS_API_KEY=
SOCIALCRAWL_API_KEY=
GROQ_API_KEY=
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
```

Настраиваемые defaults:

```text
PORT=3000
SESSION_TTL_DAYS=7
PROFILE_FRESHNESS_DAYS=3
DISCOVERY_DEFAULT_LIMIT=5
DISCOVERY_MAX_LIMIT=100
REELS_DEFAULT_LIMIT=3
REELS_MAX_LIMIT=20
GROQ_WHISPER_MODEL=whisper-large-v3-turbo
GROQ_WHISPER_LANGUAGE=ru
JOB_MAX_ATTEMPTS=3
WORKER_CONCURRENCY=4
UPLOAD_MAX_MB=2
CSV_MAX_ROWS=500
BACKUP_RETENTION_DAYS=7
```

Приложение должно завершаться с понятной ошибкой до старта HTTP/worker, если обязательная переменная отсутствует или имеет неверный формат. Секреты запрещено выводить в логи или сохранять в audit/provider payload.

## 4. SQL-схема

### 4.1 `instagram_accounts`

Единая сущность кандидата/блогера.

Основные поля:

- `id bigint generated always as identity primary key`
- `username text not null`
- `instagram_url text not null`
- `lifecycle_status text not null`
- `source_type text not null`
- `source_note text null`
- `approved_at`, `rejected_at`, `archived_at`
- `rejection_reason text null`
- `created_at`, `updated_at`

Ограничения:

- username сохраняется lowercase без `@`;
- unique index на уже нормализованный `username`;
- `lifecycle_status in ('candidate','approved','rejected','archived')`;
- `source_type in ('discovery','manual','csv','seed')`.

### 4.2 `account_sources`

История происхождения аккаунта без дублирования самой сущности:

- `account_id`
- `source_type`
- `discovery_run_id null`
- `search_query null`
- `source_note null`
- `created_at`

Повторное обнаружение добавляет source row, но не меняет lifecycle.

### 4.3 `account_profiles`

Текущий снимок 1:1:

- `account_id unique references instagram_accounts(id)`
- Instagram ID, username, display name, bio, avatar/external URL
- followers, following, posts count
- verified, private
- engagement rate, language, content category
- `profile_status in ('available','unavailable','error')`
- provider, unavailable/error reason
- `raw_payload jsonb`
- `fetched_at`, `created_at`, `updated_at`

История всех успешных снимков профиля не хранится.

### 4.4 `reels`

- `account_id references instagram_accounts(id)`
- `instagram_media_id`, `shortcode`, `reel_url`
- caption, published time
- play/like/comment counts
- thumbnail URL и временный media URL
- provider и `raw_payload jsonb`
- `transcript_status in ('pending','available','empty','unavailable','error')`
- transcript text, source, checked time, provider HTTP status/error
- `transcript_quality in ('useful','noise','low_value','empty')`
- quality reason
- fetched/created/updated timestamps

Уникальность определяется media ID; если он отсутствует — shortcode. Повторный fetch обновляет нормализованные поля и последний raw payload, но не стирает валидный transcript.

### 4.5 `discovery_runs`

- query/queries и requested limit
- status, найдено/создано/дубликатов
- timestamps и инициатор `admin`
- краткая ошибка

Discovery выполняется как background job, поэтому HTTP-запрос возвращает run ID сразу.

### 4.6 `pipeline_runs`

- `account_id`
- `run_type in ('candidate_enrichment','blogger_refresh')`
- requested reels limit
- `force_refresh boolean`
- aggregate status
- timestamps и ошибка

Один активный run одного типа на аккаунт; повторный клик возвращает существующий active run вместо создания дубля.

### 4.7 `jobs`

- `pipeline_run_id null`
- `job_type`
- `status in ('pending','running','retry_wait','succeeded','failed','cancelled')`
- `priority`, `payload jsonb`, `result jsonb`
- `dedupe_key text unique`
- `attempts`, `max_attempts`, `available_at`
- lease: `locked_by`, `locked_at`, `heartbeat_at`, `current_attempt_id`; heartbeat и terminal update принимаются только от текущего worker/attempt
- error summary и timestamps

Reject/archive и ручная отмена выполняются транзакционно: связанный активный pipeline и все его pending/running/retry jobs переходят в `cancelled`, текущий attempt закрывается, а поздний ответ worker отбрасывается fencing-проверкой. Перед записью provider/LLM результата handler повторно блокирует account и pipeline и проверяет соответствие lifecycle.

Типы: `discover_accounts`, `fetch_profile`, `fetch_reels`, `fetch_transcript`, `classify_transcript`, `evaluate_candidate`, `propose_criteria`.

Worker резервирует jobs через `FOR UPDATE SKIP LOCKED`. Просроченный lease возвращает job в `retry_wait` при старте/периодическом recovery.

Каждый concurrency slot работает под supervisor: временная ошибка резервирования получает ограниченный exponential backoff, а ошибки terminal update и пересчёта pipeline логируются без остановки slot. Процесс и каждый slot публикуют отдельные строки в `worker_heartbeats`; worker healthcheck требует не меньше `WORKER_CONCURRENCY` свежих slot heartbeat на текущем hostname.

Worker создаёт единый shutdown `AbortController`. При `SIGTERM`/`SIGINT` signal сначала отменяет ожидающие semaphore-операции и все in-flight HTTP/LLM/Groq запросы, DNS/media download и `ffmpeg`, затем worker дожидается terminal update jobs и закрывает pool. Shutdown-abort не считается основанием для fallback к следующему provider; запущенный `ffmpeg` принудительно завершается через `SIGKILL`.

Candidate pipeline различает отсутствие контента и технический сбой. Финальный failure обязательного profile/reels job, либо transcript/classify failure при отсутствии хотя бы одного полезного transcript, переводит run в `failed` с агрегированным `error_summary`. Только успешно обработанные, но пустые или шумовые данные дают `insufficient_data`.

CSV принимает только корректный UTF-8 с header row. Разрешены уникальные колонки `username`, `url`, `source_note`; обязательна хотя бы одна identity-колонка, а неполные и лишние колонки отклоняются. Preview получает UUID и version, хранится в ограниченном session map 15 минут и подтверждается один раз. Таблица `csv_import_batches` блокирует повторный/конкурентный commit, а весь batch — accounts, sources, pipelines и jobs — записывается одной транзакцией.

### 4.8 `job_attempts`

Каждая попытка отдельно хранит:

- job ID и attempt number;
- provider;
- started/finished timestamps;
- outcome;
- HTTP status/request ID;
- безопасную error detail без секретов.

### 4.9 `evaluations`

- account ID и criteria version ID
- `recommendation`
- `confidence smallint check 0..100`
- `positive_signals jsonb`
- `negative_signals jsonb`
- `explanation text`
- `llm_log_id`
- status/validation error и timestamps

Рекомендации: `recommended_approve`, `recommended_reject`, `needs_manual_review`.

### 4.10 `criteria_versions`

Создание manual и LLM drafts проходит через единый transactional service. Перед вычислением `max(version_number)+1` он берёт тот же PostgreSQL advisory lock, что и activation, поэтому параллельные writers получают уникальные последовательные номера и согласованный active parent.

- version number
- checklist markdown
- search queries JSONB array
- transcript noise rules JSONB
- `status in ('draft','active','rejected','superseded')`
- `source in ('seed','manual','llm')`
- parent version, diff summary
- created/activated/rejected timestamps

Partial unique index гарантирует не более одной active-версии.

### 4.11 `llm_logs`

- purpose: `candidate_evaluation` или `criteria_proposal`
- account/criteria references
- base URL без secret query, model
- request messages JSONB
- raw response JSONB/text
- parsed response JSONB
- token usage, latency, status и error
- timestamps

Невалидный JSON также сохраняется.

### 4.12 `audit_events`

- actor всегда `admin` в MVP;
- action;
- entity type/ID;
- old/new values JSONB;
- reason;
- request IP/user-agent;
- timestamp.

Audit events не изменяются и не удаляются через приложение.

### 4.13 Служебные таблицы

- `sessions` для `express-session` PostgreSQL store.
- `provider_call_logs`: metadata успешных запросов, полный error payload неуспешных.
- Состояние схемы проверяется по обязательным таблицам; служебная история миграций не создаётся.

## 5. Внутренние DTO

Provider adapters возвращают единые объекты:

```js
ProfileResult = {
  status, provider, profile, rawPayload, requestMeta, error
}

ReelsResult = {
  status, provider, items, rawPayload, requestMeta, error
}

TranscriptResult = {
  status, provider, text, rawPayload, requestMeta, error
}
```

LLM candidate response обязан соответствовать форме:

```json
{
  "recommendation": "recommended_approve | recommended_reject | needs_manual_review",
  "confidence": 0,
  "positive_signals": ["..."],
  "negative_signals": ["..."],
  "explanation": "..."
}
```

Невалидная форма не создаёт usable evaluation и не разблокирует approve.

## 6. HTTP-интерфейс

Страницы:

```text
GET  /login
GET  /candidates
GET  /bloggers
GET  /reels
GET  /queue
GET  /settings
GET  /health/live
GET  /health/ready
```

Основные действия:

```text
POST /auth/login
POST /auth/logout
POST /discovery-runs
POST /accounts
POST /imports/csv/preview
POST /imports/csv/commit
POST /accounts/:id/pipeline
POST /accounts/:id/approve
POST /accounts/:id/reject
POST /accounts/:id/archive
POST /accounts/:id/restore
POST /jobs/:id/retry
POST /jobs/:id/cancel
POST /criteria/drafts
POST /criteria/proposals
POST /criteria/:id/activate
POST /criteria/:id/reject
POST /preferences/language
```

HTMX partial routes могут использовать namespace `/ui/*`, но не являются публичным API. Они обязаны применять ту же авторизацию, CSRF и сервисный слой.

## 7. Безопасность

- `helmet` с CSP, совместимой с локальными assets и HTMX.
- CSRF token для всех state-changing форм.
- Login rate limit по IP и username.
- Cookie: `HttpOnly`, `Secure` в production, `SameSite=Lax`.
- Session ID ротируется после успешного login.
- Все EJS-значения по умолчанию escaped; raw HTML запрещён для bio/caption/transcript/LLM.
- CSV filename и contents не используются как filesystem path.
- Временные файлы создаются в отдельной temp-директории с непредсказуемым именем и удаляются независимо от результата.
- API keys никогда не передаются браузеру.
