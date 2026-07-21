# Pipeline и правила обработки

## 1. Общие принципы

- Любой внешний вызов выполняется worker, а не Express request handler.
- Все действия идемпотентны и допускают безопасный retry.
- Успешные свежие данные переиспользуются; force refresh явно игнорирует freshness.
- Никаких cron/scheduled refresh в MVP нет.
- Наличие ошибки одного рилса не должно блокировать сохранение других рилсов.
- Финальное approve/reject всегда выполняет человек.

## 2. Provider strategy

Порядок primary/fallback:

| Операция | Primary | Fallback | Последний fallback |
|---|---|---|---|
| Search profiles | ScrapeCreators | SocialCrawl | — |
| Profile | SocialCrawl | ScrapeCreators | — |
| Reels | ScrapeCreators | SocialCrawl | — |
| Transcript | SocialCrawl | ScrapeCreators | Groq Whisper |

Fallback выполняется при timeout, network error, 429, 5xx, invalid schema или отсутствии полезного результата. Для 404/unavailable второй провайдер используется как проверка. Нормальная ошибка второго провайдера сохраняется отдельно от первой.

Defaults:

- Groq model: `whisper-large-v3-turbo`;
- language: `ru`;
- response format: `verbose_json`;
- temperature: `0`.

Groq сначала получает media URL. Если URL-вариант недоступен или файл требует преобразования, worker скачивает медиа во временную директорию, извлекает 16 kHz mono audio через ffmpeg и отправляет файл. Временный input/output удаляется в `finally`; путь не записывается в БД.

## 3. Discovery flow

1. Администратор вводит query и limit.
2. Express валидирует диапазон и создаёт `discovery_runs` + `discover_accounts` job.
3. Worker вызывает primary search и fallback при необходимости.
4. Username нормализуется: удаляются `@`, пробелы, query/fragment и приводится lowercase.
5. Каждый уникальный результат upsert-ится в `instagram_accounts` как `candidate`, если аккаунта ещё нет.
6. Для каждого результата добавляется `account_sources`.
7. Lifecycle существующего аккаунта не меняется.
8. Discovery run фиксирует counts и завершается.
9. Никакие enrichment jobs автоматически не создаются.

## 4. Manual URL и CSV

1. Вход нормализуется до username и canonical URL `https://www.instagram.com/{username}/`.
2. Некорректные домены, служебные Instagram paths и пустые usernames отклоняются.
3. Новый аккаунт создаётся как candidate.
4. Для нового аккаунта создаётся `candidate_enrichment` run.
5. Существующий аккаунт не дублируется и не меняет lifecycle; UI показывает его текущий статус и ссылку.

CSV проходит preview до записи:

- проверка UTF-8, размера и максимального числа строк;
- наличие `url` или `username`;
- нормализация;
- статистика valid/invalid/duplicate/existing;
- commit использует подписанный server-side import token, чтобы клиент не мог подменить preview.

## 5. Candidate enrichment

### 5.1 Старт

- Из плитки запускается обычный run или force refresh из боковой панели.
- Default reels limit: 3; диапазон 1–20.
- Если active run уже существует, новый run не создаётся.
- Для archived запуск запрещён.

### 5.2 Профиль и рилсы

`fetch_profile` и `fetch_reels` создаются параллельно.

Обычный run переиспользует успешные данные моложе трёх дней. Force refresh всегда вызывает providers.

`fetch_reels`:

- upsert-ит рилсы по media ID/shortcode;
- обновляет метрики и URLs;
- создаёт `fetch_transcript` только для выбранных последних рилсов без usable transcript или при force refresh.

### 5.3 Transcript

1. Попытка получить transcript через SocialCrawl.
2. При отсутствии результата — ScrapeCreators.
3. При отсутствии готового текста — Groq Whisper.
4. Сохранение status/source/text/error.
5. Создание `classify_transcript` для любого terminal transcript result.

### 5.4 Дешёвая классификация

Результаты:

- `empty`: текста нет;
- `noise`: найден шумовой паттерн вроде `DimaTorzok` или мусорной подписи субтитров;
- `low_value`: только музыка/шум, менее 12 символов или не более двух слов;
- `useful`: остальные непустые тексты.

Regex и пороги берутся из активной criteria version, чтобы новая версия не требовала code deploy.

### 5.5 Readiness и LLM

Evaluation разрешена только если:

- профиль имеет `profile_status='available'`;
- существует минимум один рилс с `transcript_quality='useful'`.

Если условие не выполнено, pipeline завершается как `insufficient_data`, LLM не вызывается и approve остаётся заблокирован.

Если условие выполнено, `evaluate_candidate` передаёт LLM:

- активную criteria version;
- нормализованный профиль;
- выбранные рилсы, captions и useful transcripts;
- доступные метрики;
- предупреждения о provider/transcript errors.

Ответ валидируется строгой схемой. Полный request/response сохраняется в `llm_logs`. Невалидный JSON считается job failure и проходит общую retry policy.

## 6. Решение человека

### Approve

Preconditions:

- lifecycle `candidate`;
- существует валидная evaluation;
- нет active conflicting transaction.

В одной транзакции lifecycle меняется на `approved`, записывается timestamp и создаётся audit event.

### Reject

- Доступен для любого candidate, включая `insufficient_data`.
- Причина может быть выбрана из подготовленного списка или введена текстом.
- В одной транзакции lifecycle меняется на `rejected`, сохраняется причина и audit event.
- Pending/retry_wait jobs аккаунта отменяются; running jobs завершаются, но не меняют lifecycle.

## 7. Blogger refresh

1. Запускается только вручную из панели approved-блогера.
2. Создаёт `blogger_refresh` run.
3. Обновляет профиль, последние N рилсов и их transcripts.
4. Не создаёт candidate evaluation.
5. Не меняет статус блогера по результатам внешних API.

После трёх дней с последнего успешного fetch карточка показывает badge `Данные могли устареть`, но job автоматически не создаётся.

## 8. Archive и restore

Archive:

- работает только для approved;
- меняет lifecycle на `archived`;
- отменяет pending/retry_wait jobs;
- блокирует новые runs;
- сохраняет профиль, рилсы, transcript и audit history.

Restore возвращает lifecycle в `approved`; автоматический refresh после restore не запускается.

## 9. Criteria workflow

### Manual edit

1. Администратор редактирует checklist, queries или noise rules.
2. Создаётся новая draft-версия с parent и diff.
3. Отдельное подтверждение активирует draft и деактивирует предыдущую active-версию в одной транзакции.

### LLM proposal

1. Администратор вручную запускает `propose_criteria`.
2. Выбираются только decided accounts (`approved`/`rejected`) с доступным профилем и минимум одним useful transcript.
3. LLM получает положительные/отрицательные примеры и ручные причины.
4. Сохраняются полный LLM log и draft criteria version.
5. UI показывает diff; администратор активирует или отклоняет draft.

Новая active-версия применяется только к будущим evaluation/classification runs и не помечает старые оценки устаревшими.

## 10. Retry и recovery

- Максимум три попытки job.
- Рекомендуемые задержки: 30 секунд, 2 минуты, 10 минут.
- HTTP timeout задаётся отдельно для provider type.
- После последней ошибки job получает `failed`.
- Ручной retry создаёт новую попытку той же job и сохраняет предыдущую историю.
- Dedupe key предотвращает одновременное выполнение одного этапа для одного run/entity.
- Worker обновляет heartbeat для долгих jobs.
- Running job с просроченным lease возвращается в очередь recovery-процессом.
- Graceful shutdown прекращает резервирование новых jobs и освобождает/завершает текущие в пределах timeout.
