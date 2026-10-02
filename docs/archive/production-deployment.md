> **ARCHIVED — this describes the superseded pilot deployment.**
>
> Kas runs on **Windows with PostgreSQL**, installed by
> `scripts/production/windows/Install-Kas.ps1` and started by `Kas.cmd` /
> `KasService.cmd`. See [deployment.md](../deployment.md) and
> [../production-runbook.md](../production-runbook.md) for the supported path.
>
> This document is kept for one reason: it is the rollback procedure named by
> the error a **SQLite-era backup** (`formatVersion: 1`) produces when the
> current tool refuses it. If you are holding such a backup, this is how it was
> deployed. Nothing here is supported for new installs.

# Production deployment — Ubuntu VPS

Milestone D.0. This is the complete, first-time deployment procedure for KAS on
a single Ubuntu server.

> **No real domain, IP, password or token appears anywhere in this repository.**
> `example.invalid` is a reserved, never-resolving placeholder. Replace it with
> your own values **only** in the server's `.env.production`, which is
> git-ignored.

---

## 0. Architecture

```
                     ┌──────────────────────────────────────────┐
   Internet          │  VPS (Ubuntu)                            │
   ────────▶ :443 ───┼─▶ caddy ──(private network)──▶ app:3001  │
             :80  ───┤     · TLS + auto-renew          · API    │
                     │     · the ONLY published ports  · client │
                     │                                          │
                     │  volumes: kas-db · kas-uploads           │
                     │           kas-backups · caddy-data       │
                     └──────────────────────────────────────────┘
```

- **One** application container serves both the JSON API and the built React
  client on one internal port, so the browser is always same-origin with the API.
- The eight hotels do **not** run their own backends. Each branch simply opens
  the one HTTPS domain in a browser and logs in with an account permanently
  bound to its branch (enforced server-side).
- The app port is never published to the host. Only Caddy publishes 80/443.

### Database: hardened SQLite — **PILOT ONLY**

This milestone deploys SQLite on a persistent volume, deliberately:

- The Prisma provider stays `sqlite`, so the eleven committed migrations remain
  valid and the entire test suite keeps running against the real engine.
- Backups use SQLite's `VACUUM INTO`, which is consistent against a live
  database (see [backup-restore.md](backup-restore.md)).

**Constraints you must respect:**

- **Do not scale the app container.** SQLite allows exactly one writer; a second
  app replica will produce `SQLITE_BUSY` errors and can corrupt state.
  `docker compose up --scale app=2` is unsupported.
- The database file lives on the `kas-db` volume — never inside the container.

A PostgreSQL migration is a separate milestone (D.1) and is **required before a
full eight-branch rollout**. See "Known limits" at the end.

---

## 1. Install Docker Engine

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Verify:

```bash
docker version && docker compose version
```

## 2. Firewall

Only SSH and HTTP(S) may be reachable. Nothing else — in particular no database
port and no application port.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

## 3. Check out the exact release

Never deploy a moving branch — always a tag or an explicit commit.

```bash
sudo mkdir -p /opt/kas && sudo chown "$USER" /opt/kas
git clone <your-repository-url> /opt/kas
cd /opt/kas
git fetch --all --tags
git checkout --detach v1.0.0        # the exact release you intend to run
git rev-parse --short HEAD          # record this
```

## 4. Create the environment file and secrets

```bash
cp .env.production.example .env.production
chmod 600 .env.production
nano .env.production
```

Set at minimum: `APP_DOMAIN`, `APP_ORIGIN` (the same host, `https://`),
`ACME_EMAIL`, `APP_RELEASE_REF`, `APP_IMAGE_TAG`.

Secrets are files, never environment values — they stay out of `docker inspect`
and out of any shell history:

```bash
mkdir -p secrets && chmod 700 secrets
openssl rand -hex 48 > secrets/session_secret
chmod 600 secrets/session_secret
```

Do **not** create `secrets/initial_admin_password`. The Admin is created
interactively in step 8, so its password is never written to a file.

`secrets/`, `.env.production` and every `*.db`, upload and backup path are
git-ignored; verify with `git status --short` before you ever commit anything.

## 5. Point DNS at the server

Create an `A` record (and `AAAA` if you have IPv6) for `APP_DOMAIN` pointing at
the VPS address, then wait for it to resolve:

```bash
dig +short <your-domain>
```

Caddy cannot obtain a certificate until DNS resolves and ports 80/443 reach the
server, so complete this **before** step 6.

## 6. Deploy

```bash
./scripts/production/deploy.sh
```

The script validates the compose file, builds the image, runs
`prisma migrate deploy`, runs the production bootstrap, starts the stack, and
waits for health. It is idempotent — safe to re-run if a step fails.

Individual steps, if you prefer to run them by hand:

```bash
docker compose -f compose.production.yml --env-file .env.production config
docker compose -f compose.production.yml --env-file .env.production build
docker compose -f compose.production.yml --env-file .env.production run --rm --no-deps app \
  npx prisma migrate deploy --schema prisma/schema.prisma
docker compose -f compose.production.yml --env-file .env.production run --rm --no-deps app \
  npm run prod:seed
docker compose -f compose.production.yml --env-file .env.production up -d
```

## 7. Migrations and bootstrap — what runs and what must never run

| Command | Use |
| --- | --- |
| `npx prisma migrate deploy` | **The only** production migration command. Applies committed migrations, forward-only. |
| `npm run prod:seed` | Idempotent bootstrap: branches + Booking.com/Agoda hotel names, nothing else. |
| `prisma migrate dev` | ❌ Never in production — generates and can reset. |
| `prisma migrate reset` | ❌ Never — drops the database. |
| `prisma db push` | ❌ Never — bypasses migration history. |
| `npm run data:prepare-production` | ❌ Not part of deployment. Wipes all operational data; development tool only. |

The bootstrap creates **zero** bookings, proofs, issues, notifications, demo
batches and **zero** `reception_test` accounts. Re-running it never overwrites an
Admin-edited branch number/name/address and never re-enables an alias an Admin
deliberately disabled.

## 8. Create the first administrator

Interactive, so no password is written to a file, a log or your shell history:

```bash
docker compose -f compose.production.yml --env-file .env.production exec app \
  npm run prod:create-admin
```

It asks for a username, display name and password (typed twice, never echoed),
enforces a 12+ character policy with mixed case, a digit and a symbol, and
refuses to create a second Admin unless you pass `--allow-additional`. The
account is created with **must change password**, so you rotate it at first login.

**Log in over HTTPS immediately and change that password.**

## 9. Verify

```bash
./scripts/production/health-check.sh
```

This checks, from inside the private network: `/api/health`, `/api/ready` (with
its per-dependency list), that `/api/dev-test/*` returns **404**, and finally
that the public HTTPS URL answers.

Manual checks to add on first deployment:

- Open `https://<your-domain>` — the app shell loads over a valid certificate.
- Log in as the Admin. **Quản lý khách sạn & chi nhánh** lists all eight branches.
- No yellow "CHẾ ĐỘ DỮ LIỆU TEST ĐANG BẬT" banner appears anywhere.
- No "Công cụ dữ liệu test" panel appears in Quản lý tài khoản.

## 10. Create the receptionist accounts

**Not** done by any script, deliberately. After the system is verified, create
them in the Admin UI (**Quản lý tài khoản → Thêm lễ tân**): one account per
branch, each bound to its branch, each with a temporary password the receptionist
must change at first login.

## 11. Schedule daily backups

```bash
sudo crontab -e
```

```cron
# 02:15 daily, keep the newest 7 archives
15 2 * * * cd /opt/kas && ./scripts/production/backup.sh --retain=7 >> /var/log/kas-backup.log 2>&1
```

Then read [backup-restore.md](backup-restore.md) and perform a **restore drill**
before you rely on the backups. An untested backup is not a backup.

## 12. Day-to-day operations

Update, rollback, logs, disk usage and incident handling are in
[production-runbook.md](production-runbook.md) and
[incident-response.md](incident-response.md).

---

## Known limits

1. **SQLite is a pilot database.** Single writer, no horizontal scaling. Full
   eight-branch rollout should wait for the PostgreSQL milestone (D.1).
2. **Docker verification is outstanding.** The Docker Engine was not available on
   the machine where D.0 was authored, so `docker build`,
   `docker compose config` and a live container run have **not** been executed.
   Run all three on the VPS (or any Docker host) before going live.
3. **No off-server backup automation.** The backup script writes to a volume on
   the same machine; copying an archive elsewhere is a documented manual step.
4. **Certificates need reachable DNS.** Caddy cannot issue a certificate before
   `APP_DOMAIN` resolves to the server and 80/443 are open.
5. **The image installs the Prisma CLI at runtime** so `migrate deploy` can run
   inside the container. That is intentional and comes from the lockfile.
