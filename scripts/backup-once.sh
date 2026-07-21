#!/bin/sh
set -eu

backup_directory="${BACKUP_DIRECTORY:-/backups}"
mkdir -p "$backup_directory"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary="$backup_directory/.instagram_hunter_${timestamp}.dump.tmp"
destination="$backup_directory/instagram_hunter_${timestamp}.dump"
pg_dump --format=custom --compress=9 --file="$temporary"
mv "$temporary" "$destination"
echo "$destination"
