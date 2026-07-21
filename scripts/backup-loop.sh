#!/bin/sh
set -eu

mkdir -p /backups

while true; do
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  temporary="/backups/.instagram_hunter_${timestamp}.dump.tmp"
  destination="/backups/instagram_hunter_${timestamp}.dump"
  pg_dump --format=custom --compress=9 --file="$temporary"
  mv "$temporary" "$destination"
  find /backups -type f -name 'instagram_hunter_*.dump' -mtime "+${BACKUP_RETENTION_DAYS:-7}" -delete
  sleep 86400
done
