# Эксплуатация и развёртывание

## 1. Docker Compose

Production stack:

| Service | Назначение | Persistent data |
|---|---|---|
| `caddy` | HTTPS и reverse proxy | certificates/config volume |
| `web` | Express + EJS/HTMX | нет |
| `worker` | jobs и providers | нет |
| `postgres` | основная БД и sessions | PostgreSQL volume |
| `backup` | ежедневный `pg_dump` и rotation | backup volume |

`web` и `worker` собираются из одного image, но запускаются разными entrypoints. В image worker устанавливается ffmpeg.

Никакой постоянный volume для media/audio не создаётся. Temp storage должен быть ограничен и очищаться при рестарте контейнера.

## 2. Первый запуск

1. Создать production `.env` вне Git.
2. Сгенерировать bcrypt-хэш пароля предоставленной CLI-командой проекта.
3. Указать домен и настроить DNS на VPS.
4. Запустить PostgreSQL.
5. Выполнить SQL-миграции отдельной one-shot командой.
6. Выполнить seed начальной criteria version.
7. Запустить web, worker, backup и Caddy.
8. Проверить readiness и login.
9. Выполнить тестовый импорт одного URL с малыми лимитами.

Миграции не должны автоматически выполняться одновременно несколькими web/worker replicas. Production deploy запускает их отдельным шагом.

## 3. Health checks

### `/health/live`

Возвращает 200, если процесс Node.js работает. Не обращается к внешним API.

### `/health/ready`

Возвращает 200 только если:

- PostgreSQL отвечает;
- schema version соответствует приложению;
- обязательная конфигурация загружена.

Недоступность ScrapeCreators/SocialCrawl/Groq/LLM не делает web unready: она отображается через jobs и provider logs.

Worker health сообщает время последнего heartbeat и успешного reserve loop.

## 4. Логирование

- Structured JSON в stdout/stderr.
- Общие поля: timestamp, level, service, request/job ID, account ID, provider, duration.
- Web присваивает request ID и возвращает его в response header.
- Worker использует job ID как correlation ID.
- Секреты, password, cookies, Authorization и `x-api-key` редактируются до логирования.
- Полный успешный Instagram payload хранится только в профильной/рилс-записи, не в stdout.
- Полный LLM request/response хранится в `llm_logs`, но ключ и authorization headers не сохраняются.

## 5. Backup и restore

- `backup` выполняет ежедневный compressed custom-format `pg_dump`.
- Имя содержит UTC timestamp.
- Хранятся последние семь успешных файлов; временный незавершённый dump не считается backup.
- Ошибка backup логируется с ненулевым exit code.
- Backup volume не публикуется через Caddy или Express.

Ручной backup запускается той же версией PostgreSQL client:

```powershell
docker compose run --rm --entrypoint sh backup /usr/local/bin/backup-once.sh
```

Документированная проверка restore:

1. Создать отдельную пустую PostgreSQL-БД.
2. Восстановить последний dump через `pg_restore`.
3. Запустить проверку наличия корневой таблицы схемы.
4. Сверить counts accounts/reels/jobs/audit/criteria.
5. Выполнить login и read-only smoke test на восстановленной БД.

Restore drill выполняется перед первым production запуском и после изменения backup image/script.

## 6. Deployment

- Image собирается один раз и используется web/worker.
- До переключения версии выполняются автоматические тесты и развёртывание полной схемы на временной пустой БД.
- Deploy sequence: backup → pull/build image → schema check/bootstrap → seed → restart worker/web → readiness checks.
- Bootstrap никогда не меняет непустую БД. Любое будущее изменение production-схемы требует отдельного проверенного DBA-плана и свежего backup.
- При провале readiness новая версия останавливается; откат приложения не должен требовать изменения данных.

## 7. Caddy и сеть

- Наружу публикуются только 80/443 Caddy.
- Express и PostgreSQL доступны только во внутренней Compose network.
- Caddy перенаправляет HTTP на HTTPS.
- Secure cookies включаются в production.
- Upload body limit применяется и в Caddy, и в Express.

## 8. Наблюдаемость в MVP

Отдельный Prometheus/Grafana stack не требуется. Достаточно:

- health endpoints;
- structured logs;
- Queue UI;
- counts pending/running/failed;
- время последнего worker heartbeat;
- последний успешный backup timestamp;
- provider error metadata;
- LLM usage и latency в настройках/деталях run.

## 9. Ручные operational процедуры

Нужно документировать и проверить команды для:

- запуска миграций и просмотра их статуса;
- генерации bcrypt-хэша;
- retry recovery зависших jobs;
- принудительного освобождения только просроченных leases;
- backup и restore;
- просмотра worker/web logs;
- ротации `SESSION_SECRET` с принудительным logout;
- замены provider/LLM keys без попадания значений в shell history документации.

## 10. Данные и retention

- Accounts, decisions, criteria, audit и LLM logs хранятся бессрочно в MVP.
- Последний raw профиль/рилс заменяется при успешном refresh.
- Ошибки provider calls остаются для диагностики.
- Временные медиа удаляются сразу после обработки.
- Автоматической очистки rejected/archived аккаунтов нет.

## 11. Фактическое production-развёртывание

Состояние на 2026-07-21:

| Параметр | Значение |
|---|---|
| URL | `https://insta.podedu.ru` |
| Каталог | `/opt/instagram-hunter` |
| Compose project | `insta_hunter` |
| Image | `instagram-hunter:0.1.0` |
| Backend | `127.0.0.1:13002` → container `3000` |
| Reverse proxy | системный Nginx |
| TLS | Certbot/Let's Encrypt, auto-renew |
| Сертификат | до 2026-10-19 |
| Secrets | `/opt/instagram-hunter/.env`, mode `600`, owner `root` |

На этом сервере **не запускать service `caddy`**: порты 80/443 уже принадлежат системному Nginx и обслуживают другие проекты. Использовать оба Compose-файла и явно перечислять сервисы:

```bash
cd /opt/instagram-hunter
docker compose -p insta_hunter -f compose.yaml -f compose.server.yaml \
  up -d --no-build postgres schema seed web worker backup
```

Проверка состояния:

```bash
docker compose -p insta_hunter -f compose.yaml -f compose.server.yaml ps -a
curl -fsS https://insta.podedu.ru/health/ready
```

Ручной backup:

```bash
docker exec insta_hunter-backup-1 sh /usr/local/bin/backup-once.sh
docker exec insta_hunter-backup-1 ls -lh /backups
```

Nginx vhost: `/etc/nginx/sites-available/insta.podedu.ru.conf`, symlink в `sites-enabled`. Перед reload всегда выполнять `nginx -t`.

Особенность `.env`: bcrypt-хэш содержит `$`. Поскольку тот же файл используется Compose для interpolation, доллары в `ADMIN_PASSWORD_HASH` на сервере экранированы как `$$`; внутри контейнера приложение получает обычный валидный `$2b$...` хэш.

### Ограничения сервера

- Root filesystem был заполнен на 93%, свободно около 2.9 ГБ.
- Swap отсутствует.
- Production image следует собирать и тестировать вне VPS, затем загружать готовым.
- Нельзя выполнять тяжёлый `docker build` или параллельный import при малом `available memory`.
- Перед обновлением проверять `free -h`, `df -h /`, `docker ps` и состояние соседних проектов.
- `million-items-postgres` оставлен остановленным по решению владельца сервера.

### Выполненная приёмка

- 17/17 automated tests прошли в Docker test-stage.
- Миграция и seed завершились с exit code `0`.
- Web, worker и PostgreSQL healthy.
- HTTP перенаправляется на HTTPS.
- HTTPS login form и readiness возвращают `200`.
- Реальный CSRF/login flow возвращает `302`, авторизованная `/candidates` — `200`.
- Создан и проверен custom-format PostgreSQL backup.
- Существующий `checkit` после reboot восстановлен и отвечает HTTP `200`.

Provider/LLM API-ключи пока пустые. Интерфейс работает, но live discovery/transcription/evaluation требуют заполнить `SCRAPECREATORS_API_KEY`, `SOCIALCRAWL_API_KEY`, `GROQ_API_KEY`, `LLM_API_KEY` и `LLM_MODEL`, после чего перезапустить web/worker.
## Актуальное состояние production (2026-07-21)

Production работает на образе `instagram-hunter:0.1.4`. Реальные ключи ScrapCreators, SocialCrawl, Groq и OpenAI настроены в `/opt/instagram-hunter/.env`; значения ключей нельзя выводить в логи. Модель OpenAI — `gpt-5.6-terra`.

Live-проверка подтвердила discovery, загрузку профиля и reels, Groq Whisper, классификацию и отдельный structured-JSON запрос OpenAI. Три проверенных reels оказались шумом, поэтому итог `insufficient_data` является ожидаемым. Подробности и безопасный следующий шаг описаны в [production-status.md](production-status.md).

При любом обновлении обязательно сохранять `checkit` работающим и не запускать `million-items-postgres`.
