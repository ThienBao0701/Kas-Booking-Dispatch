# Incident response

What to do when production misbehaves. The order matters: **preserve evidence,
then stabilise, then decide about data.**

Alias used below:

```bash
alias kdc='docker compose -f compose.production.yml --env-file .env.production'
```

---

## 0. First five minutes

1. **Do not delete or recreate containers yet** — that destroys the logs.
2. Capture evidence:

   ```bash
   mkdir -p incident-$(date -u +%Y%m%dT%H%M%SZ) && cd $_
   kdc ps                                        > ps.txt
   kdc logs --no-color --timestamps app          > app.log
   kdc logs --no-color --timestamps caddy        > caddy.log
   kdc exec -T app node -e "fetch('http://127.0.0.1:3001/api/ready').then(r=>r.json()).then(b=>console.log(JSON.stringify(b,null,2)))" > ready.json 2>&1
   df -h                                         > disk.txt
   docker system df -v                           > volumes.txt
   cd ..
   ```

3. Note the deployed release: `grep APP_RELEASE_REF .env.production`.
4. **Take a backup of the current state before changing anything**, unless the
   database itself is suspected to be corrupt:

   ```bash
   ./scripts/production/backup.sh
   ```

   That snapshot *is* the evidence for any later data question.

`rollback.sh` performs steps 2 automatically before it swaps the image.

---

## 1. Triage by symptom

### The site does not load at all

```bash
kdc ps
kdc logs --tail=100 caddy
```

| Cause | Check | Fix |
| --- | --- | --- |
| Certificate not issued | `kdc logs caddy \| grep -i acme` | DNS must resolve to this host and 80/443 must be open (`sudo ufw status`). |
| Caddy down | `kdc ps` | `kdc up -d caddy` |
| App unhealthy → Caddy has no upstream | `kdc ps` shows `unhealthy` | Continue to the next section. |
| Host firewall | `sudo ufw status verbose` | `sudo ufw allow 80,443/tcp` |

### The app container is unhealthy or restarting

```bash
kdc logs --tail=200 app
```

| Cause | Signature | Fix |
| --- | --- | --- |
| Invalid configuration | `Invalid environment configuration:` listing keys | Fix `.env.production`; the app refuses to boot on an unsafe config (that is the design). |
| Dev tools armed | `ENABLE_DEV_TEST_TOOLS must be false in production` | Set it to `false` and recreate. |
| Missing secret file | `SESSION_SECRET_FILE is set but could not be read` | Recreate `secrets/session_secret`, `chmod 600`. |
| Database unreachable | `/api/health` 503 | Check the `kas-db` volume is mounted and the disk is not full. |
| Disk full | `df -h` at 100 % | Free space (see §3), then restart. |
| Migration not applied | Prisma "table does not exist" | `kdc run --rm --no-deps app npx prisma migrate deploy --schema prisma/schema.prisma` |

### Uploads fail

| Cause | Check | Fix |
| --- | --- | --- |
| Volume not writable | `ready.json` → `proofUploads: ok=false` | Ensure `/data/uploads` is owned by uid 1000 (`node`). |
| File too large | 413 in the response | Raise `MAX_UPLOAD_MB`, and keep Caddy's `max_size` above it. |
| Proxy rejects the body | Caddy log shows the rejection | Raise `request_body max_size` in the `Caddyfile`. |
| Wrong type | 415 | Only PNG/JPEG/WebP are accepted, verified by magic bytes — this is intended. |

### Logins fail for everyone

| Cause | Check | Fix |
| --- | --- | --- |
| Session secret changed | Everyone logged out at once | A changed `SESSION_SECRET` invalidates all sessions. Restore the previous secret if it was rotated by mistake. |
| Rate limiter tripped | 429 responses | Expected under brute force. It is per-IP with a rolling window; wait it out or raise `LOGIN_RATE_LIMIT_MAX` deliberately. |
| Cookie not sent | Works over HTTP, not HTTPS | `SESSION_COOKIE_SECURE=true` requires HTTPS end to end; check `APP_ORIGIN` matches the real host. |
| Wrong proxy trust | Rate limiting hits everyone at once | `TRUST_PROXY` must equal the number of proxies (1 behind Caddy). |

### Something developer-only is visible in production

Treat as a **security incident**.

```bash
kdc exec app printenv NODE_ENV ENABLE_DEV_TEST_TOOLS
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/dev-test/status   # must be 404
```

If `NODE_ENV` is not `production`, the stack is running the wrong configuration.
Stop the app, fix `.env.production`, recreate, and then review what was exposed
(demo data generation and the branch switcher can both alter data).

---

## 2. Rollback decision

```
Is the application broken?
├── No  ──▶ Do not roll back. Investigate with logs.
└── Yes
     │
     ├── Did the release add a migration?
     │    ├── No  ──▶ ./scripts/production/rollback.sh          (app only, data kept)
     │    └── Yes
     │         ├── Old code can still read the new schema (additive columns)
     │         │        ──▶ rollback.sh (app only, data kept)
     │         └── Old code CANNOT read it
     │                  ──▶ roll FORWARD with a fix, or
     │                      restore the pre-update backup (accepting data loss)
     │
     └── Is the DATA wrong or corrupt?
          ──▶ back up the current state first (evidence),
              then ./scripts/production/restore.sh --live <chosen backup>
```

**Never** reverse a migration by hand, and never restore a database "just to be
safe". A restore always loses everything written since that backup — it is a
deliberate, explicit decision, not a reflex.

All of this project's migrations so far are additive, so an application-only
rollback is normally safe. Verify per release rather than assuming it.

---

## 3. Disk full

```bash
df -h /var/lib/docker
docker system df -v | grep kas
```

In order of safety:

1. Prune old backups: `./scripts/production/backup.sh --retain=7` (or copy the
   oldest off-server first, then delete them).
2. Prune unused images: `docker image prune -f` — keeps `kas-app:previous`
   only if it is still tagged, so check before pruning if you may need it.
3. Prune build cache: `docker builder prune -f`.
4. **Never** delete the `kas-db`, `kas-uploads` or `caddy-data` volumes.

Container logs cannot cause this: they are capped at 5 × 10 MB per service.

---

## 4. Suspected data corruption

1. **Stop the app** immediately: `kdc stop app`. Do not keep writing.
2. Copy the raw volume for forensics before touching it:

   ```bash
   docker run --rm -v kas_kas-db:/db -v "$PWD":/out alpine \
     tar czf /out/kas-db-forensic-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /db .
   ```

3. Pick the newest backup taken **before** the suspected corruption.
4. **Drill it first**: `./scripts/production/restore.sh --drill <backup>` and
   confirm the row counts look right.
5. Only then: `./scripts/production/restore.sh --live <backup>`.
6. Work through the post-restore checklist in
   [backup-restore.md](backup-restore.md) §5.
7. Write down what was lost (the window between the backup and the incident) and
   tell the branches, so they can re-enter those bookings.

---

## 5. After every incident

- [ ] Evidence directory kept somewhere durable.
- [ ] Root cause written down, with the release reference.
- [ ] `APP_IMAGE_TAG` points at a real release again (not `previous`).
- [ ] A fresh backup exists and verifies.
- [ ] If a gap in monitoring or in this document was exposed, fix the document.
- [ ] If configuration was the cause, consider whether the app should have
      refused to start — validation belongs in `server/src/config/env.ts`.
