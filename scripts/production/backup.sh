#!/usr/bin/env bash
#
# KAS — production backup (database + uploads + manifest).
#
#   ./scripts/production/backup.sh              # keep every backup
#   ./scripts/production/backup.sh --retain=7   # keep the newest 7
#
# Runs inside the app container so it uses the same DATABASE_URL and volume
# paths the application uses. The database snapshot is taken with SQLite's
# VACUUM INTO, which is consistent against a live, actively written database —
# plain `cp` of data.db is NOT, because of the write-ahead log.
#
# The archive is written to the kas-backups volume, which is separate from the
# container filesystem and survives image rebuilds and container recreation.
#
# Exit code 0 = success, non-zero = failure. Suitable for cron/systemd alerting.
#
set -Eeuo pipefail

COMPOSE_FILE="compose.production.yml"
ENV_FILE=".env.production"
RETAIN_ARG="${1:-}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mXX %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "$COMPOSE_FILE" ]] || die "Run this from the repository root."

log "Creating backup"
# shellcheck disable=SC2086
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T app \
  npm run --silent prod:backup -- ${RETAIN_ARG}

cat <<'NEXT'

Backup written to the kas-backups volume.

OFF-SERVER COPY (required — a backup on the same disk does not survive that
disk failing). From an admin workstation, for example:

  docker run --rm -v kas_kas-backups:/backups -v "$PWD":/out alpine \
    tar czf /out/kas-backups-$(date -u +%Y%m%d).tar.gz -C /backups .

then copy that archive somewhere else entirely.

Suggested retention: 7 daily, 4 weekly, and at least one off-server copy.
See docs/backup-restore.md.
NEXT
