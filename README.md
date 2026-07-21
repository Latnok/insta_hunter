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

Рабочий MVP реализован и развёрнут: миграции, закрытая админка, PostgreSQL-очередь, provider fallback, transcript/LLM pipeline и Docker Compose. Production-интеграции настроены и проверены; их значения хранятся только в защищённом серверном `.env`.

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
