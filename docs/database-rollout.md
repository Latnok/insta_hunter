# DBA-процесс изменения production-схемы

## 1. Политика

`db/schema.sql` — единственный источник полной схемы первого релиза. Проект не ведёт цепочку runtime-миграций и не выполняет `ALTER` существующей production-БД при старте.

- `npm run db:init` применяет полную схему только к пустой БД.
- Непустая БД считается совместимой только при наличии всех обязательных таблиц и точном совпадении `schema_metadata.schema_version` с версией приложения.
- `npm run db:check` выполняет только чтение и завершается с ненулевым кодом при пустой, неполной или несовместимой схеме.
- `/health/ready` возвращает `503`, если контракт схемы не совпадает.
- При любом изменении структуры увеличиваются одновременно `schema_metadata.schema_version` в `db/schema.sql` и `currentSchemaVersion` в `src/db/schema.js`. CI обязана развернуть полную схему в пустой PostgreSQL и обнаружить рассинхронизацию.

Изменение существующей БД «на месте» запрещено. Для schema-changing release создаётся новая БД из полной схемы, а данные переносятся отдельно проверенным release-specific способом. Старую БД сохраняют неизменной для rollback.

## 2. Ответственность и обязательное согласование

До начала работ назначаются три роли; один человек может совмещать роли только с явной записью об этом:

- release owner — фиксирует commit/image digest, окно работ и критерии приёмки;
- DBA executor — выполняет backup, restore rehearsal, перенос и сверку;
- reviewer/approver — проверяет команды, цели подключения, результаты rehearsal и решение о cutover.

Карточка изменения должна содержать:

- commit SHA и immutable image digest;
- старую и новую версии схемы;
- имена source/target БД и ожидаемый `DATABASE_URL` без пароля;
- оценку downtime и объёма данных;
- checksum полного dump и release-specific скрипта переноса;
- запросы сверки по каждой переносимой таблице;
- момент закрытия rollback без потери новых записей;
- ответственных, время approval и ссылку на журнал выполнения.

Без заполненной карточки, успешного rehearsal и свежего проверенного backup cutover запрещён.

## 3. Подготовка release

1. Изменить полную схему, увеличить её версию и обновить код одним commit.
2. Поднять пустую PostgreSQL 16, выполнить `npm run db:init`, `npm run db:check`, seed и все integration-тесты.
3. Подготовить одноразовый, идемпотентный перенос данных source → target. Он не является runtime-миграцией, не включается в startup и не должен изменять source. Для несовместимых колонок нужны явные mapping/default/reject rules.
4. Зафиксировать контрольные запросы: counts, min/max ID, ссылки без orphan rows, активные criteria, незавершённые pipeline/jobs, audit/provider/LLM logs и sequence values.
5. Проверить, что старая версия приложения работает со старой БД, а новая — только с новой. Mixed-version работа с одной БД не допускается.

## 4. Restore rehearsal

Rehearsal выполняется на отдельном PostgreSQL, не связанном с production network:

1. Создать свежий custom-format dump source и SHA-256 checksum.
2. Восстановить dump в отдельную rehearsal source-БД; проверить `pg_restore` exit code и checksum.
3. Создать пустую rehearsal target-БД и применить к ней `npm run db:init` из release image.
4. Запустить release-specific перенос из восстановленной source в target.
5. Выполнить все контрольные запросы, `npm run db:check`, seed, login и read-only smoke.
6. Проверить rollback: переключить test instance обратно на rehearsal source и повторить read-only smoke.
7. Записать длительность каждого шага, результаты сверки и фактический downtime budget.

Rehearsal считается неуспешным при любой необъяснённой разнице, warning/error `pg_restore`, ручной правке target или отсутствии воспроизводимого журнала команд.

## 5. Production cutover

Перед каждой командой DBA выводит и сверяет текущий host, database, user и обе явно заданные цели. Команды удаления БД в процедуру cutover не входят.

1. Проверить ресурсы VPS, состояние `checkit`, текущий Compose project и убедиться, что `million-items-postgres` не запускается.
2. Зафиксировать release commit/image digest. Запустить read-only `npm run db:check` на текущем release.
3. Сделать свежий полный backup, проверить ненулевой размер, exit code, SHA-256 и доступность файла вне контейнера.
4. Остановить сначала worker, затем web, оставив PostgreSQL и backup service работающими. С этого момента записи заморожены.
5. Сделать финальный backup после остановки writers и повторить checksum.
6. Создать новую пустую target-БД с новым уникальным именем. Применить полную схему release image и выполнить `npm run db:check` против target.
7. Выполнить утверждённый перенос только source → target. Source остаётся неизменной.
8. Выполнить контрольные запросы и сравнить результаты с финальным source snapshot. Любая необъяснённая разница означает stop и rollback.
9. Изменить только secret/config `DATABASE_URL` на target, запустить seed, web и worker нового image.
10. Проверить `/health/ready`, login, основные read-only страницы, очередь и worker heartbeat. После этого разрешить один контролируемый write smoke и записать его ID.
11. Если все критерии выполнены, открыть трафик и зафиксировать время cutover. Старую БД не переименовывать, не изменять и не удалять минимум семь дней.

## 6. Rollback

До первого пользовательского/worker write в target rollback без потери данных состоит из остановки нового worker/web, возврата `DATABASE_URL` к старой БД и запуска предыдущего immutable image. Затем обязательны readiness, login и worker heartbeat.

После появления новых записей в target автоматический rollback запрещён: простое переключение потеряет эти записи. Release owner выбирает один заранее согласованный вариант:

- остановить writers, выполнить проверенный обратный перенос новых записей и только затем переключиться;
- принять документированную потерю записей с письменным approval владельца данных;
- оставить сервис остановленным до подготовки безопасной reconciliation.

Rollback никогда не включает удаление target. Backup, обе БД, логи команд и checksums сохраняются до разбора инцидента.

## 7. Завершение и очистка

После семи дней стабильной работы и отдельной restore-проверки release owner может запросить удаление старой БД. Это отдельная destructive операция: DBA повторно сверяет точное имя, свежий backup и approval. Удаление PostgreSQL volume, соседних Compose projects, `checkit` или запуск `million-items-postgres` не относятся к этому процессу и запрещены.

Процесс пересматривается после каждого rollback, изменения backup/restore scripts или существенного изменения PostgreSQL topology.
