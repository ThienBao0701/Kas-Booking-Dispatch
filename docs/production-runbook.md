# Production runbook

> **THE SUPPORTED HOST IS WINDOWS.** Day-to-day operation is
> [launcher.md](launcher.md); acceptance is
> [production-checklist.md](production-checklist.md).
>
> | Task | Command |
> | --- | --- |
> | Start | `Kas.cmd` (or the Scheduled Task `Kas` at boot) |
> | Stop | `Kas.cmd --stop` — **never** Task Manager |
> | Restart | `Kas.cmd --restart` |
> | Is it healthy? | `Kas.cmd --health` |
> | Something is wrong | `Kas.cmd --diagnose`, then send `logs\deployment-report.json` |
> | Back up now | `KasBackup.cmd` |
> | Restore | `npm run prod:restore -- --backup=<dir> --safe` |
> | Which build is this? | `Kas.cmd --version` |
> | Where are the logs? | `Kas.cmd --logs` |
>
> The application supervises itself: it restarts the server **once** if it dies
> or stops answering, then stops and says so rather than looping. It never
> restarts for a database outage, a full disk or an unwritable uploads
> directory — a restart fixes none of those. See `logs\service.log`.
>
> The Docker/VPS material below belongs to the superseded pilot and is kept for
> reference only.

---


Day-to-day operation of KAS on the VPS. Every command runs from `/opt/kas`
(the repository checkout) unless stated otherwise.

A convenience alias for everything below:

```bash
alias kdc='docker compose -f compose.production.yml --env-file .env.production'
```

---

## 1. Status and logs

| Task | Command |
| --- | --- |
| Service status | `kdc ps` |
| Application logs (follow) | `kdc logs -f --tail=200 app` |
| Caddy logs (TLS, requests) | `kdc logs -f --tail=200 caddy` |
| Logs since a time | `kdc logs --since 30m app` |
| Health + readiness + dev-tool check | `./scripts/production/health-check.sh` |
| Readiness detail | `kdc exec -T app node -e "fetch('http://127.0.0.1:3001/api/ready').then(r=>r.json()).then(b=>console.log(JSON.stringify(b,null,2)))"` |
| Database size | `kdc exec -T app sh -c 'ls -lh /data/db'` |
| Volume usage | `docker system df -v \| grep kas` |
| Disk usage | `df -h /var/lib/docker` |
| Container resource use | `docker stats --no-stream` |

Docker's json-file driver is capped at **5 × 10 MB per container**
(`compose.production.yml`), so logs cannot fill the disk.

**Logs never contain** passwords, session cookies, tokens, proof image content
or full booking payloads. Application errors log a request id plus the error;
5xx stack traces are logged server-side but never returned to a user.

## 2. Start / stop / restart

```bash
kdc up -d                 # start everything
kdc restart app           # restart only the app (keeps Caddy + certs up)
kdc stop app              # stop the app; Caddy stays up and serves an error
kdc down                  # stop everything (volumes are PRESERVED)
```

`docker compose down -v` would **delete the volumes**, i.e. the database,
uploads and backups. Never run it on the VPS.

All services use `restart: unless-stopped`, so they come back automatically
after a crash or a host reboot.

## 3. Deploy an update

```bash
./scripts/production/update.sh v1.2.3
```

In order: **backup → tag the current image as `kas-app:previous` → check out the
exact release → build → `prisma migrate deploy` → idempotent bootstrap →
recreate the app → health check.**

Notes:

- The backup happens *first*, deliberately, so there is always a restore point
  from immediately before the change.
- Migrations are forward-only. `migrate deploy` never reverses anything.
- The previous image is kept so an application rollback needs no rebuild.
- `APP_RELEASE_REF` / `APP_IMAGE_TAG` in `.env.production` are updated, which is
  what stamps the release into every later backup manifest.

## 4. Roll back

```bash
./scripts/production/rollback.sh
```

**This rolls back the application only. It does not touch the database.**

Application rollback and database rollback are separate decisions:

| Situation | Action |
| --- | --- |
| New release is broken, schema unchanged/compatible | `rollback.sh`. Keep all data. **Do not restore.** |
| New release wrote bad data | Back up the *current* state first (evidence), then restore a chosen backup. |
| New release added a migration the old code cannot read | The old image will fail too. Roll **forward** with a fix, or restore the pre-update backup. |

The script preserves `app`/`caddy` logs and `ps` output into an
`incident-<timestamp>/` directory **before** replacing the container, because
those logs vanish with it. See [incident-response.md](incident-response.md).

Afterwards, set `APP_IMAGE_TAG` back to a real release tag.

## 5. Backups

```bash
./scripts/production/backup.sh --retain=7     # manual
./scripts/production/restore.sh --list        # what exists
./scripts/production/restore.sh --drill <backup-dir>   # rehearse, safe
```

Scheduled daily via cron (see
[production-deployment.md](production-deployment.md) §11). Full detail:
[backup-restore.md](backup-restore.md).

**Do a restore drill at least monthly.** It touches nothing live.

## 6. Accounts

| Task | Where |
| --- | --- |
| Create the first Admin | `kdc exec app npm run prod:create-admin` (once) |
| Create receptionists | Admin UI → **Quản lý tài khoản → Thêm bộ phận** |
| Lock / unlock a receptionist | Admin UI → **Quản lý tài khoản** |
| Reset a receptionist password | Admin UI (issues a temporary password) |
| Add / rename / disable a branch | Admin UI → **Khách sạn & chi nhánh** |
| Change a Booking.com / Agoda hotel name | Admin UI → **Quản lý tên trên nền tảng** |

Branch and hotel-name changes are configuration, not code — no deployment is
needed. See [branch-management.md](branch-management.md).

Disabling an account immediately destroys its sessions.

## 7. Certificates

Caddy obtains and renews certificates automatically and stores them on the
`caddy-data` volume. Nothing to schedule.

If issuance fails: check that DNS resolves to this server, that ports 80 and 443
are open, and read `kdc logs caddy`. Losing the `caddy-data` volume simply causes
re-issuance (mind Let's Encrypt rate limits).

## 8. Routine health checklist

Weekly:

- [ ] `kdc ps` — both services `Up` and `healthy`.
- [ ] `./scripts/production/health-check.sh` passes, including the 404 for dev tools.
- [ ] `df -h` — disk below ~80 %.
- [ ] Last night's backup exists (`./scripts/production/restore.sh --list`).
- [ ] At least one backup copied off this server.

Monthly:

- [ ] Restore drill (`--drill`) succeeds and the checklist is worked through.
- [ ] Review Admin accounts and receptionist accounts still in use.
- [ ] Apply host OS security updates and reboot during a quiet window.

## 9. What must never appear in production

If any of these is visible, treat it as an incident and stop:

- The yellow **CHẾ ĐỘ DỮ LIỆU TEST ĐANG BẬT** banner
- **Công cụ dữ liệu test** in Quản lý tài khoản
- A branch switcher for a normal receptionist
- `reception_test` in the account list
- A 200 response from any `/api/dev-test/*` URL
- A stack trace in an HTTP response body

The app **refuses to start** with `ENABLE_DEV_TEST_TOOLS=true` and
`NODE_ENV=production`, and the dev-test router 404s regardless — so the most
likely cause is that the stack is not actually running in production mode.
Check `kdc exec app printenv NODE_ENV`.
