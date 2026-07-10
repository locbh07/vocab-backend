#!/usr/bin/env bash
# Backs up the Supabase Postgres database (from DATABASE_URL in .env) to a local file
# under backups/ (gitignored). Run this before any bulk AI-review/batch run so there's
# something to restore from if something goes wrong.
#
# Usage:
#   scripts/backup-database.sh            # custom-format dump (compressed, restore with pg_restore)
#   scripts/backup-database.sh --sql       # also write a plain-text .sql dump (bigger, human-diffable)

set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env file found" >&2
  exit 1
fi

DATABASE_URL="$(grep '^DATABASE_URL=' .env | head -1 | sed 's/^DATABASE_URL=//' | sed 's/^"//;s/"$//')"
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL not set in .env" >&2
  exit 1
fi

mkdir -p backups
STAMP="$(date +%Y%m%d_%H%M%S)"
DUMP_FILE="backups/backup_${STAMP}.dump"

# pg_dump must be >= the server's Postgres version. Supabase runs newer major versions than
# the default Windows PostgreSQL 16 install here, so prefer a newer pg_dump if present.
PG_DUMP=pg_dump
for candidate in \
  "/c/Program Files/PostgreSQL/18/bin/pg_dump" \
  "/c/Program Files/PostgreSQL/17/bin/pg_dump"; do
  if [ -x "$candidate" ]; then
    PG_DUMP="$candidate"
    break
  fi
done

echo "Using $("$PG_DUMP" --version)"
echo "Backing up database to ${DUMP_FILE} ..."
"$PG_DUMP" -d "$DATABASE_URL" -F c --no-owner --no-privileges -f "$DUMP_FILE"
echo "Done: ${DUMP_FILE} ($(du -h "$DUMP_FILE" | cut -f1))"

if [ "${1:-}" = "--sql" ]; then
  SQL_FILE="backups/backup_${STAMP}.sql"
  echo "Also writing plain SQL dump to ${SQL_FILE} ..."
  "$PG_DUMP" -d "$DATABASE_URL" -F p --no-owner --no-privileges -f "$SQL_FILE"
  echo "Done: ${SQL_FILE} ($(du -h "$SQL_FILE" | cut -f1))"
fi

echo ""
echo "Restore with:"
echo "  pg_restore --clean --if-exists --no-owner --no-privileges -d \"\$DATABASE_URL\" ${DUMP_FILE}"
