#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: restore-check.sh BACKUP_FILE TARGET_DATABASE_URL" >&2
  exit 2
fi

backup_file="$1"
target_url="$2"
pg_restore --clean --if-exists --no-owner --dbname="$target_url" "$backup_file"
psql "$target_url" -v ON_ERROR_STOP=1 -c "select to_regclass('public.instagram_accounts') as schema_root"
psql "$target_url" -v ON_ERROR_STOP=1 -c "select lifecycle_status, count(*) from instagram_accounts group by lifecycle_status order by lifecycle_status"
