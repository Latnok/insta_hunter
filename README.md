# Instagram Hunter

Закрытая однопользовательская админка для поиска и ручного отбора Instagram-блогеров в нише одежды.

Целевая реализация: Node.js 20, Express, EJS + HTMX, PostgreSQL и отдельный фоновый worker. Исходные Python-эксперименты перенесены в `docs/legacy/` и остаются только справочным материалом.

## Документация

- [Продуктовая спецификация](docs/product-spec.md)
- [Архитектура и SQL-модель](docs/architecture.md)
- [Pipeline и правила обработки](docs/pipeline.md)
- [Эксплуатация и развёртывание](docs/operations.md)
- [Текущее состояние production](docs/production-status.md)
- [Подробный план работ](TODO.md)

## Статус

Рабочий MVP реализован и развёрнут: полная SQL-схема, закрытая админка, PostgreSQL-очередь, provider fallback, transcript/LLM pipeline и Docker Compose. Production-интеграции настроены и проверены; их значения хранятся только в защищённом серверном `.env`.

## Локальный запуск

1. Установить Node.js 20 и зависимости:

   ```powershell
   npm install
   ```

2. Скопировать `.env.example` в `.env`, задать PostgreSQL URL, API-ключи и секрет сессии.
3. Сгенерировать bcrypt-хэш интерактивно:

   ```powershell
   npm run password:hash
   ```

4. Применить схему и начальные критерии:

   ```powershell
   npm run db:init
   npm run seed
   ```

5. Запустить web и worker в двух терминалах:

   ```powershell
   npm run start:web
   npm run start:worker
   ```

## Обязательные секреты и API-токены

Приложение запускается без внешних API-токенов, но live-поиск, загрузка Instagram-данных, транскрибация и LLM-оценка работать не будут. Для полного pipeline заполните следующие переменные в локальном `.env` или в защищённом secret store окружения.

| Переменная | Обязательность | Где получить | Назначение |
| --- | --- | --- | --- |
| `SCRAPECREATORS_API_KEY` | Нужен хотя бы один Instagram-провайдер | Зарегистрироваться в [ScrapeCreators](https://app.scrapecreators.com/) и скопировать API key из кабинета | Поиск профилей, профили, рилсы и транскрипты |
| `SOCIALCRAWL_API_KEY` | Нужен хотя бы один Instagram-провайдер | Зарегистрироваться в [SocialCrawl](https://www.socialcrawl.dev/), затем открыть Dashboard → API Keys; инструкция — [Authentication](https://www.socialcrawl.dev/docs/authentication) | Основной/fallback-доступ к профилям, рилсам и транскриптам |
| `LLM_API_KEY` | Обязателен для оценки кандидатов и генерации критериев | Создать project API key на странице [OpenAI API keys](https://platform.openai.com/api-keys) | Вызовы OpenAI-compatible LLM |
| `LLM_MODEL` | Обязателен вместе с `LLM_API_KEY` | Выбрать доступную модель в [каталоге моделей OpenAI](https://platform.openai.com/docs/models) | ID модели, передаваемый в API |
| `GROQ_API_KEY` | Условно обязателен: нужен для аудио-fallback, если провайдер не вернул готовый транскрипт | Создать ключ в [GroqCloud API Keys](https://console.groq.com/keys) | Транскрибация аудио через Whisper |

Для устойчивой работы рекомендуется настроить оба Instagram-провайдера: приложение использует fallback при пустом ответе, временной ошибке или изменении схемы одного из API. OpenAI API оплачивается отдельно от подписки ChatGPT; у проекта API должны быть активны billing и доступ к выбранной модели.

Кроме внешних токенов для запуска обязательны внутренние секреты:

- `POSTGRES_PASSWORD` и согласованный с ним `DATABASE_URL`;
- `ADMIN_PASSWORD_HASH` — создать командой `npm run password:hash`; значение с символами `$` хранить в одинарных кавычках, как в `.env.example`;
- `SESSION_SECRET` длиной не менее 32 символов;
- `APP_DOMAIN` — домен приложения без протокола.

Случайные значения для пароля PostgreSQL и session secret можно создать локально:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Правила безопасности:

- копируйте `.env.example` в `.env`, но никогда не добавляйте `.env` в Git;
- не вставляйте реальные ключи в README, issue, логи, команды shell history или клиентский JavaScript;
- используйте отдельные ключи для development и production и выдавайте только необходимые права;
- при утечке немедленно отзывайте ключ у провайдера и создавайте новый;
- на Linux ограничьте доступ к production-файлу командой `chmod 600 .env`.

## Production

Текущий production развёрнут на `https://insta.podedu.ru` в `/opt/instagram-hunter`.
На общем сервере используется системный Nginx, поэтому Caddy из базового Compose не запускается. Web опубликован только на `127.0.0.1:13002` через `compose.server.yaml`, PostgreSQL остаётся во внутренней сети Compose.

```bash
cd /opt/instagram-hunter
docker compose -p insta_hunter -f compose.yaml -f compose.server.yaml \
  up -d --no-build postgres schema seed web worker backup
```

Инструкции по backup/restore, HTTPS и безопасному обновлению находятся в [эксплуатационной документации](docs/operations.md).

## Проверка

```powershell
npm run check
npm test
docker compose config --quiet
docker build -t instagram-hunter:test .
```

Интеграционные проверки PostgreSQL запускаются в отдельном временном Compose-проекте:

```powershell
docker compose -p insta_hunter_integration -f compose.integration.yaml up --build --abort-on-container-exit --exit-code-from test
docker compose -p insta_hunter_integration -f compose.integration.yaml down
```

GitHub Actions запускает тот же обязательный набор при каждом push в `master` и в pull request: syntax-check, default tests, отдельные PostgreSQL integration/security/queue/idempotency suites на PostgreSQL 16 и `npm audit --omit=dev --audit-level=high`. Integration-команда получает `TEST_DATABASE_URL`, поэтому suites не могут тихо завершиться как skipped.
