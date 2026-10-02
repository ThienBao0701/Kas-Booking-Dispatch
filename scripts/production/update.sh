#!/usr/bin/env bash
#
# KAS — deploy a new release.
#
#   ./scripts/production/update.sh v1.2.3
#
# Order matters: back up first, then build, then migrate, then swap the app.
# The previous image is retagged `kas-app:previous` so rollback.sh can restore
# it without a rebuild.
#
set -Eeuo pipefail

COMPOSE_FILE="compose.production.yml"
ENV_FILE=".env.production"
RELEASE="${1:-}"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mXX %s\033[0m\n' "$*" >&2; exit 1; }

[[ -n "$RELEASE" ]] || die "Usage: $0 <git-tag-or-commit>"
[[ -f "$COMPOSE_FILE" ]] || die "Run this from the repository root."
[[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE."

# --------------------------------------------------------------- 1. backup
log "Backing up before the update"
./scripts/production/backup.sh

# --------------------------------------------------------------- 2. keep the old image
if docker image inspect "kas-app:$(grep -E '^APP_IMAGE_TAG=' "$ENV_FILE" | cut -d= -f2)" >/dev/null 2>&1; then
  CURRENT_TAG="$(grep -E '^APP_IMAGE_TAG=' "$ENV_FILE" | cut -d= -f2)"
  log "Tagging the running image as kas-app:previous (rollback target)"
  docker tag "kas-app:${CURRENT_TAG}" kas-app:previous
fi

# --------------------------------------------------------------- 3. fetch the exact release
log "Checking out ${RELEASE}"
git fetch --all --tags
git checkout --detach "$RELEASE"
COMMIT="$(git rev-parse --short HEAD)"

# Record what is being deployed so backups can be traced back to it.
sed -i -E "s|^APP_RELEASE_REF=.*|APP_RELEASE_REF=${RELEASE}|" "$ENV_FILE"
sed -i -E "s|^APP_IMAGE_TAG=.*|APP_IMAGE_TAG=${RELEASE}|" "$ENV_FILE"

# --------------------------------------------------------------- 4. build
log "Building ${RELEASE} (${COMMIT})"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build

# --------------------------------------------------------------- 5. migrate
# Forward-only. `migrate deploy` never reverses a migration; if a release needs
# a schema rollback that is a database restore decision — see
# docs/incident-response.md.
log "Applying database migrations"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" run --rm --no-deps app \
  npx prisma migrate deploy --schema prisma/schema.prisma

# --------------------------------------------------------------- 6. seed (idempotent)
log "Re-running the production seed (idempotent)"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" run --rm --no-deps app \
  npm run prod:seed

# --------------------------------------------------------------- 7. swap
log "Recreating the application container"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --no-deps app

log "Verifying health"
./scripts/production/health-check.sh

log "Update to ${RELEASE} (${COMMIT}) complete. Rollback image: kas-app:previous"
