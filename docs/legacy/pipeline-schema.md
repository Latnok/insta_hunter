# Схема pipeline: candidates → bloggers → enrichment

## 1. `instagram_search_candidates`
Найденные аккаунты до апрува.

Поля:
- `id` PK
- `username` UNIQUE
- `url`
- `full_name`
- `bio`
- `search_query`
- `matched_from`
- `followers_search`
- `followers_profile`
- `reels_found`
- `profile_signal`
- `caption_signal`
- `candidate_label` (`candidate`)
- `review_status` (`new|processing|reviewed|approved|rejected|merged`)
- `review_recommendation` (`recommended_approve|recommended_reject|needs_manual_review`)
- `blogger_id` FK -> `bloggers.id` NULL
- `sample_captions` JSONB
- `created_at`
- `updated_at`

Назначение:
- хранить discovery-поток
- не смешивать сырых кандидатов с approved блогерами
- фиксировать результат review и связь с blogger при approve/merge

---

## 2. `bloggers`
Основной реестр одобренных блогеров.

Поля:
- `id` PK
- `url` UNIQUE
- `rating`
- `created_at`
- `updated_at`

Опционально можно добавить:
- `source_type`
- `status` (`active|inactive|unavailable`)

Назначение:
- только approved сущности
- база для постоянного мониторинга и enrichment

---

## 3. `blogger_profiles`
Актуальный снимок профиля Instagram.

Поля:
- `id` PK
- `blogger_id` FK -> `bloggers.id`
- `instagram_id`
- `username`
- `display_name`
- `bio`
- `followers`
- `following`
- `posts_count`
- `verified`
- `private`
- `profile_status` (`available|unavailable|error`)
- `unavailable_reason`
- `last_checked_at`
- `raw_json` JSONB
- `created_at`
- `updated_at`

Назначение:
- внешний слой profile enrichment
- обновляется независимо от candidates/bloggers

---

## 4. `blogger_reels`
Последние reels и их обогащение.

Поля:
- `id` PK
- `blogger_id` FK -> `bloggers.id`
- `instagram_media_id` UNIQUE
- `shortcode`
- `reel_url`
- `caption`
- `taken_at`
- `play_count`
- `like_count`
- `comment_count`
- `thumbnail_url`
- `media_url`
- `owner_username`
- `transcript_text`
- `transcript_status`
- `transcript_source`
- `transcript_checked_at`
- `transcript_error_message`
- `transcript_http_status`
- `transcript_attempts`
- `transcript_quality`
- `transcript_quality_reason`
- `audio_path`
- `audio_status`
- `audio_extracted_at`
- `raw_json` JSONB
- `created_at`
- `updated_at`

Назначение:
- reels ingestion
- transcript/audio fallback
- quality classification

---

## 5. `processing_queue`
Очередь заданий на обработку.

Поля:
- `id` PK
- `entity_type` (`candidate|blogger`)
- `entity_id`
- `job_type` (`fetch_profile|fetch_reels|transcribe_audio|classify_transcript|evaluate_candidate`)
- `status` (`pending|running|done|error`)
- `priority`
- `attempts`
- `last_error`
- `payload` JSONB
- `created_at`
- `updated_at`
- `started_at`
- `finished_at`

Назначение:
- оркестрация pipeline
- независимый перезапуск этапов
- прозрачный статус обработки

---

## Связи
- `instagram_search_candidates.blogger_id -> bloggers.id`
- `blogger_profiles.blogger_id -> bloggers.id`
- `blogger_reels.blogger_id -> bloggers.id`
- `processing_queue.entity_id` ссылается на `instagram_search_candidates.id` или `bloggers.id` в зависимости от `entity_type`

---

## Логика перехода кандидата в блогера
1. Кандидат создаётся в `instagram_search_candidates`
2. По нему создаются job'ы в `processing_queue`
3. После enrichment ИИ/пользователь принимает решение
4. Если кандидат одобрен:
   - создаётся запись в `bloggers` или выбирается существующая
   - в `instagram_search_candidates.blogger_id` пишется ссылка
   - `review_status = approved` или `merged`
5. Дальнейшее profile/reels enrichment уже живёт вокруг `bloggers`

---

## Минимальный workflow
1. Search/discovery
2. Save to `instagram_search_candidates`
3. Enqueue jobs in `processing_queue`
4. Fetch profile/reels/transcripts
5. Evaluate candidate
6. Approve / reject / merge
7. Approved candidate becomes `blogger`
8. Refresh criteria and search similar again
