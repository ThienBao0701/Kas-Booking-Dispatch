#!/usr/bin/env bash
#
# KAS — roll back the APPLICATION to the previously deployed image.
#
#   ./scripts/production/rollback.sh
#
# THIS SCRIPT DOES NOT TOUCH THE DATABASE.
#
# Application rollback and database rollback are different decisions:
#
#   * Application rollback (this script) is cheap and safe when the new release
#     is broken but the schema is unchanged or backward compatible. Data written
#     by the new release is kept.
#
#   * Database rollback means RESTORING A BACKUP and losing every change made
#     since that backup was taken. It is never automatic, and never implied by
#     an application rollback. Use scripts/production/restore.sh, deliberately,
#     after reading docs/incident-response.md.
#
# If the failed release added a migration that the old code cannot read, an
# application rollback alone is NOT enough — stop and follow the incident
# runbook instead of guessing.
#
set -Eeuo pipefail

COMPOSE_FILE="compose.production.yml"
ENV_FILE=".env.production"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mXX %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "$COMPOSE_FILE" ]] || die "Run this from the repository root."
docker image inspect kas-app:previous >/dev/null 2>&1 \
  || die "No kas-app:previous image. Nothing to roll back to (was update.sh used?)."

# Preserve evidence BEFORE changing anything — the logs of the failing container
# disappear when it is replaced.
EVIDENCE="incident-$(date -u +%Y%m%dT%H%M%SZ)"
log "Preserving evidence in ${EVIDENCE}/"
mkdir -p "$EVIDENCE"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs --no-color --timestamps app  > "$EVIDENCE/app.log"  2>&1 || true
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs --no-color --timestamps caddy > "$EVIDENCE/caddy.log" 2>&1 || true
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps > "$EVIDENCE/ps.txt" 2>&1 || true

warn "Rolling back the APPLICATION only. The database is left exactly as it is."

log "Pointing the stack at kas-app:previous"
sed -i -E "s|^APP_IMAGE_TAG=.*|APP_IMAGE_TAG=previous|" "$ENV_FILE"

log "Recreating the application container"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-deps app

log "Verifying health"
./scripts/production/health-check.sh

cat <<'NEXT'

Application rolled back.

Decide explicitly whether a DATABASE rollback is also required:

  * Health is green and data looks correct  -> STOP. Do not restore.
  * The failed release corrupted or wrote bad data
        -> take a backup of the CURRENT state first (so the evidence survives),
           then restore the chosen backup with scripts/production/restore.sh.
  * The failed release added a migration the old code cannot read
        -> the old image will fail too. Roll FORWARD with a fix, or restore the
           pre-update backup. See docs/incident-response.md.

Remember to set APP_IMAGE_TAG back to a real release tag once resolved.
NEXT
