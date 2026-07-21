# Instagram candidate-to-blogger pipeline plan

> План фиксирует целевой рабочий процесс: поиск, отбор, очередь обработки, сбор критериев, апрув кандидатов и периодический пересмотр критериев.

**Goal:** Построить управляемый pipeline, в котором найденные Instagram-аккаунты проходят путь от кандидата до одобренного блогера через очередь обогащения профиля и reels, после чего система обновляет критерии отбора и предлагает апрув подходящих кандидатов.

**Architecture:** Разделить данные на три слоя: `candidates` как входящий поток discovery, `bloggers` как одобренный реестр, `profiles/reels/transcripts` как внешний слой обогащения. Все новые кандидаты сначала попадают в очередь заданий на исследование, затем результаты анализа используются ИИ для фиксации и уточнения критериев. После этого можно либо добавлять новых кандидатов вручную, либо запускать поиск похожих по уже зафиксированным сигналам.

**Tech Stack:** Postgres, Instagram search APIs, SocialCrawl/ScrapeCreators, Python batch scripts, Hermes plans/docs.

---

## 1. Целевые сущности

### 1.1 Candidates
Хранит найденные аккаунты до апрува.

Минимальные поля:
- `id`
- `username`
- `url`
- `search_query`
- `matched_from`
- `candidate_label` (`candidate`)
- `review_status` (`new`, `processing`, `reviewed`, `approved`, `rejected`, `merged`)
- `profile_signal`
- `caption_signal`
- `reels_found`
- `created_at`
- `updated_at`

### 1.2 Bloggers
Хранит только одобренных блогеров.

Минимальные поля:
- `id`
- `url`
- `rating`
- `created_at`
- `updated_at`

### 1.3 Profile / Reels / Transcripts
Внешний слой enrichment:
- `blogger_profiles`
- `blogger_reels`
- transcript/audio/quality fields

### 1.4 Processing queue
Очередь заданий на исследование аккаунтов.

Минимальные поля:
- `id`
- `entity_type` (`candidate` / `blogger`)
- `entity_id`
- `job_type` (`fetch_profile`, `fetch_reels`, `transcribe_audio`, `classify_transcript`, `evaluate_candidate`)
- `status` (`pending`, `running`, `done`, `error`)
- `priority`
- `attempts`
- `last_error`
- `created_at`
- `updated_at`

---

## 2. Основной workflow

### Шаг 1. Получаем список отобранных блогеров
Источники:
- ручное добавление
- Instagram search
- похожие аккаунты по критериям

Результат:
- найденные аккаунты сохраняются как `candidates`
- каждому кандидату ставится `review_status='new'`

### Шаг 2. После добавления кандидатов создаём очередь обработки
Для каждого нового кандидата автоматически создаются задания:
1. `fetch_profile`
2. `fetch_reels`
3. `transcribe_audio` (если нужен transcript fallback)
4. `classify_transcript`
5. `evaluate_candidate`

Важно:
- профиль и reels — отдельные задания
- это позволяет перезапускать этапы независимо
- ошибки одного этапа не блокируют всю сущность навсегда

### Шаг 3. Собираем профиль и reels
Worker / batch-процесс берёт задачи из очереди и:
- тянет профиль
- сохраняет статус доступности
- тянет последние reels
- получает transcript или извлекает audio
- классифицирует transcript quality

Результат:
- у кандидата появляется достаточно данных для оценки

### Шаг 4. ИИ фиксирует критерии
После накопления данных по нескольким релевантным аккаунтам ИИ:
- анализирует профили, reels и transcripts
- выделяет повторяющиеся полезные сигналы
- обновляет markdown-файлы критериев
- при необходимости уточняет regex/keywords для поиска похожих

Результат:
- появляются актуальные критерии для повторного discovery

### Шаг 5. ИИ оценивает кандидата
На основе:
- profile signals
- captions / transcripts
- наличия reels
- качества transcripts
- типа аккаунта (блогер vs магазин)

ИИ выставляет рекомендацию:
- `recommended_approve`
- `recommended_reject`
- `needs_manual_review`

### Шаг 6. Если кандидат подходит — предлагаем апрувить
При достаточных сигналах система не апрувит автоматически, а предлагает:
- одобрить кандидата в блогеры
- отклонить
- слить с существующим блогером как дубль

### Шаг 7. После апрува кандидат переходит в bloggers
При апруве:
- создаётся запись в `bloggers` или используется существующая
- кандидат получает `review_status='approved'`
- у кандидата фиксируется связь с `blogger_id`
- дальше enrichment уже идёт как по approved blogger

### Шаг 8. После добавления новых кандидатов цикл повторяется
Любой новый кандидат:
- сохраняется в `candidates`
- автоматически ставится в очередь
- проходит тот же pipeline

---

## 3. Правила принятия решений

### Апрувить кандидата, если
- это реально блогер, а не магазин/витрина
- профиль релевантен одежде / style / WB / обзорам / UGC
- есть reels
- есть хотя бы один полезный content signal в caption/transcript
- нет дубля в approved bloggers

### Не апрувить автоматически, если
- аккаунт похож на бренд/магазин
- reels нет или они нерелевантны
- только шум / музыка / мусорные transcripts
- signals противоречивые
- неясно, человек это или storefront

### Отправлять на ручной review, если
- профиль сильный, но reels слабые
- reels есть, но caption/transcript ambiguous
- найден возможный дубль

---

## 4. Пересмотр критериев

Критерии не считаются постоянными.

Нужно предусмотреть регулярный review, потому что:
- поисковые запросы могут давать мусор
- хорошие кандидаты могут иметь другие сигналы
- текущие regex/keywords могут быть слишком узкими или слишком широкими
- полезные транскрипты могут показывать новые паттерны

Когда пересматривать критерии:
- после накопления новой пачки одобренных блогеров
- после серии ложноположительных кандидатов
- после появления новой ниши / сезонного спроса
- после ручной корректировки пользователем

Результат пересмотра:
- обновление `clothing-seller-blogger-criteria.md`
- обновление `clothing-blogger-search-queries.md`
- обновление scoring/rules для candidate evaluation

---

## 5. Очередь как центр orchestration

Очередь нужна, чтобы pipeline был управляемым.

Преимущества:
- можно обрабатывать кандидатов асинхронно
- можно перезапускать только упавшие этапы
- можно видеть, что именно ещё не собрано
- можно разделять тяжёлые этапы: profile, reels, transcript, evaluation
- можно добавлять новых кандидатов без ручного контроля каждого шага

Принцип:
- любой новый кандидат автоматически создаёт набор job’ов
- job’ы выполняются независимо по статусам
- после завершения enrichment создаётся финальный `evaluate_candidate`

---

## 6. Минимальный operational flow

1. Найти кандидатов
2. Сохранить в `candidates`
3. Создать queue jobs
4. Собрать profile + reels + transcript/audio
5. Оценить качество transcripts
6. ИИ обновляет/фиксирует критерии
7. ИИ помечает сильных кандидатов
8. Пользователю предлагается апрув
9. Approved candidate становится blogger
10. Добавляем новых кандидатов или ищем похожих
11. Повторяем цикл

---

## 7. Что должно быть зафиксировано в системе

### Документы
- `/workspace/clothing-seller-blogger-criteria.md`
- `/workspace/clothing-blogger-search-queries.md`
- `/workspace/plan.md`

### Скрипты / процессы
- ingestion candidates
- enqueue jobs
- fetch profile
- fetch reels
- transcript/audio processor
- transcript quality classifier
- candidate evaluator

### База данных
- candidates
- bloggers
- blogger_profiles
- blogger_reels
- processing_queue

---

## 8. Риски и trade-offs

- автоматический search часто находит магазины вместо блогеров
- captions могут быть сильнее/слабее реального reel speech
- transcript noise может искажать оценку кандидата
- критерии быстро устаревают без review
- полная авто-аппрув логика рискованна, лучше оставлять final approval пользователю

---

## 9. Следующий практический этап

Следующим этапом стоит сделать без усложнения:
1. зафиксировать отдельную очередь processing jobs
2. связать `candidate -> queue jobs`
3. ввести `review_status` и `blogger_id` у кандидатов
4. оформить процедуру approve / reject / merge
5. запускать evaluation только после завершения profile + reels enrichment
