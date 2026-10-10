#!/usr/bin/env bash
#
# KAS — first-time production deployment.
#
# Run from the repository root on the server, after checking out the exact tag
# you intend to run. Idempotent: safe to re-run if a step failed.
#
#   ./scripts/production/deploy.sh
#
set -Eeuo pipefail

COMPOSE_FILE="compose.production.yml"
ENV_FILE=".env.production"
SECRETS_DIR="secrets"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mXX %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "Docker is not installed."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is not available."

[[ -f "$COMPOSE_FILE" ]] || die "Run this from the repository root ($COMPOSE_FILE not found)."
[[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE. Copy .env.production.example and fill it in."

# ---------------------------------------------------------------- secrets
log "Checking secrets"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

# A secret is generated only if it does not exist — re-running never rotates a
# live session secret (which would log every user out).
if [[ ! -s "$SECRETS_DIR/session_secret" ]]; then
  log "Generating session secret"
  openssl rand -hex 48 > "$SECRETS_DIR/session_secret"
fi
if [[ ! -s "$SECRETS_DIR/initial_admin_password" ]]; then
  # Deliberately NOT auto-generated: the Admin password is chosen by a human,
  # interactively, and is never written to a shell history or a log.
  warn "No $SECRETS_DIR/initial_admin_password."
  warn "That is fine — create the Admin interactively after start-up:"
  warn "  docker compose -f $COMPOSE_FILE exec app npm run prod:create-admin"
  : > "$SECRETS_DIR/initial_admin_password"
fi
chmod 600 "$SECRETS_DIR"/*
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------------- validate
log "Validating compose configuration"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" config >/dev/null

# ---------------------------------------------------------------- build
log "Building the application image"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build

# ---------------------------------------------------------------- migrate
# Migrations run BEFORE the app serves traffic, in a one-shot container.
# `migrate deploy` only applies committed migrations; it never generates,
# resets or drops anything.
log "Applying database migrations"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" run --rm --no-deps app \
  npx prisma migrate deploy --schema prisma/schema.prisma

# ---------------------------------------------------------------- seed
log "Seeding production configuration (branches + platform hotel names)"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" run --rm --no-deps app \
  npm run prod:seed

# ---------------------------------------------------------------- start
log "Starting the stack"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

log "Waiting for the application to become healthy"
./scripts/production/health-check.sh

cat <<'NEXT'

Deployment finished. Remaining manual steps:

  1. Create the first administrator (interactive, password is never echoed):
       docker compose -f compose.production.yml exec app npm run prod:create-admin

  2. Log in over HTTPS at your APP_ORIGIN and change that password immediately.

  3. Create the eight receptionist accounts from the Admin UI
     (Quản lý tài khoản). They are deliberately NOT created by any script.

  4. Schedule daily backups — see docs/backup-restore.md.

  5. Run a restore drill into a temporary directory before you rely on it.

NEXT
