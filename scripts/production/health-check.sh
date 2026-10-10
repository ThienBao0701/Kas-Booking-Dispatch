#!/usr/bin/env bash
#
# KAS — verify the running stack.
#
#   ./scripts/production/health-check.sh
#
# Checks liveness and readiness from INSIDE the private network (the app port is
# never published), then confirms the public HTTPS entry point answers. Exits
# non-zero on the first failure so it can gate a deploy or update.
#
set -Eeuo pipefail

COMPOSE_FILE="compose.production.yml"
ENV_FILE=".env.production"
ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
SLEEP_SECONDS="${HEALTH_SLEEP:-2}"

ok()   { printf '\033[1;32m  OK  \033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m FAIL \033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

info "Container status"
dc ps

info "Liveness — GET /api/health (internal)"
for i in $(seq 1 "$ATTEMPTS"); do
  if dc exec -T app node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ok "/api/health responded 200"
    break
  fi
  [[ "$i" -eq "$ATTEMPTS" ]] && fail "/api/health did not become healthy in time"
  sleep "$SLEEP_SECONDS"
done

info "Readiness — GET /api/ready (internal)"
dc exec -T app node -e "
fetch('http://127.0.0.1:3001/api/ready')
  .then(async r => { const b = await r.json(); console.log(JSON.stringify(b.checks)); process.exit(r.ok ? 0 : 1); })
  .catch(() => process.exit(1))
" || fail "/api/ready reported a dependency problem (see the check list above)"
ok "all readiness checks passed"

info "Developer tooling must be absent"
if dc exec -T app node -e "
fetch('http://127.0.0.1:3001/api/dev-test/status')
  .then(r => process.exit(r.status === 404 ? 0 : 1))
  .catch(() => process.exit(1))
" 2>/dev/null; then
  ok "/api/dev-test/* returns 404"
else
  fail "DEV-TEST ENDPOINTS ARE REACHABLE IN PRODUCTION — stop and fix ENABLE_DEV_TEST_TOOLS"
fi

info "Public HTTPS entry point"
DOMAIN="$(grep -E '^APP_DOMAIN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')"
if [[ -z "$DOMAIN" ]]; then
  printf '  (APP_DOMAIN not set — skipping the external check)\n'
else
  if curl -fsS --max-time 15 "https://${DOMAIN}/api/health" >/dev/null; then
    ok "https://${DOMAIN}/api/health responded"
  else
    fail "public HTTPS check failed (DNS, firewall, or certificate issuance)"
  fi
fi

info "All checks passed"
