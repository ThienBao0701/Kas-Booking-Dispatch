#!/usr/bin/env bash
#
# KAS — restore from a backup.
#
#   ./scripts/production/restore.sh --list
#   ./scripts/production/restore.sh --drill  backup-20260726T0130
#   ./scripts/production/restore.sh --live   backup-20260726T0130
#
# --drill  restores into a throwaway directory inside the container. Nothing
#          live is touched. THIS IS THE ONLY MODE YOU SHOULD EVER PRACTISE WITH,
#          and it is the mode to use for the regular restore drill.
#
# --live   overwrites the running data. The app is stopped first, because
#          restoring a database file under a running process is how you get a
#          corrupted database. A snapshot of the current state is taken
#          automatically before anything is overwritten.
#
# The underlying tool verifies the manifest and every SHA-256 checksum first and
# refuses to restore a backup that does not verify. It also requires a typed
# confirmation phrase — there is no unattended restore.
#
set -Eeuo pipefail

COMPOSE_FILE="compose.production.yml"
ENV_FILE=".env.production"
MODE="${1:-}"
BACKUP="${2:-}"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mXX %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "$COMPOSE_FILE" ]] || die "Run this from the repository root."

case "$MODE" in
  --list)
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T app \
      npm run --silent prod:restore -- --list
    ;;

  --drill)
    [[ -n "$BACKUP" ]] || die "Usage: $0 --drill <backup-dir>"
    log "Restore DRILL for ${BACKUP} — live data is not touched"
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec app \
      npm run --silent prod:restore -- \
        --backup="$BACKUP" \
        --target-db=/tmp/restore-drill/db/kas.db \
        --target-uploads=/tmp/restore-drill/uploads
    log "Verifying the restored copy is a readable database"
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T app \
      env DATABASE_URL="file:/tmp/restore-drill/db/kas.db" \
      npx prisma migrate status --schema prisma/schema.prisma || true
    warn "Drill complete. Remove /tmp/restore-drill inside the container when done."
    ;;

  --live)
    [[ -n "$BACKUP" ]] || die "Usage: $0 --live <backup-dir>"
    warn "This OVERWRITES live production data with ${BACKUP}."
    warn "Everything written since that backup will be lost."
    read -r -p "Type YES to continue: " ack
    [[ "$ack" == "YES" ]] || die "Aborted."

    log "Stopping the application (Caddy keeps serving an error page)"
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" stop app

    log "Restoring"
    # A one-shot container so the restore does not need the app running.
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" run --rm --no-deps app \
      npm run --silent prod:restore -- --backup="$BACKUP"

    log "Applying migrations (the backup may predate the running code)"
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" run --rm --no-deps app \
      npx prisma migrate deploy --schema prisma/schema.prisma

    log "Starting the application"
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d app
    ./scripts/production/health-check.sh
    warn "Work through the post-restore checklist the restore tool printed."
    ;;

  *)
    die "Usage: $0 --list | --drill <backup> | --live <backup>"
    ;;
esac
