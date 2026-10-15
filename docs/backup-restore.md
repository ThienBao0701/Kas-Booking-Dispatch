# Backup and restore

> **CURRENT FORMAT AND COMMANDS — Windows + PostgreSQL.**
>
> ```
> KasBackup.cmd                          back up now (also runs nightly at 22:00)
> npm run prod:restore -- --list         list backups
> npm run prod:restore -- --backup=<dir> --safe    supervised restore
> Kas.cmd --diagnose                     is the last backup recent?
> ```
>
> A backup directory contains:
>
> | File | What it is |
> | --- | --- |
> | `database.dump` | `pg_dump --format=custom` — a consistent snapshot of the LIVE database, no downtime |
> | `uploads/` | every proof image and issue photo |
> | `logs/` | the runtime logs as they were |
> | `config.json` | which settings were configured — **secret values withheld** |
> | `manifest.json` | written LAST; checksums, versions, row counts, total size |
>
> **No backup ever contains a credential.** `config.json` records that
> `DATABASE_URL` was set, never what it was.
>
> **Retention:** the newest 30 are kept. An incomplete backup is never counted
> and never deleted, and the newest is never deleted.
>
> **`--safe` restore** stops Kas, takes a verified rollback point, restores,
> restarts, waits for health, and **rolls everything back if any step fails**.
>
> Restoring `kas_production` or `kas_d1_test` is **refused by design**. A real
> production restore is a deliberate manual act, not something a flag enables.
>
> Sections 1–2 below describe the SQLite-era pilot format (`formatVersion: 1`),
> which the current tool refuses. They are kept for anyone holding such an
> archive — see [archive/production-deployment.md](archive/production-deployment.md).

---


What is protected, how a consistent snapshot is taken, and how to get the system
back. Read this **before** you need it, and rehearse the drill.

---

## 1. What a backup contains

One directory per backup, under the `kas-backups` volume (`/data/backups`):

```
backup-20260726T0215/
├── database.sqlite                 consistent snapshot of the live database
├── uploads/
│   ├── booking-proofs/             every proof screenshot
│   └── issue-photos/               every issue photo
└── manifest.json                   written LAST — see below
```

`manifest.json`:

| Field | Purpose |
| --- | --- |
| `formatVersion` | Restore refuses a format it does not understand. |
| `createdAt` | UTC timestamp. |
| `releaseRef` | The git tag/commit that was deployed (`APP_RELEASE_REF`). |
| `appVersion` | Package version. |
| `database.sha256`, `.bytes` | Integrity of the database file. |
| `uploads[].sha256`, `.files`, `.bytes` | Integrity of each upload set. |
| `counts` | Row counts (branches, aliases, users, bookings, proofs, issues, notifications) for a quick post-restore sanity check. |

The manifest is written **after** everything else, so a directory without a valid
manifest is by construction incomplete — and the restore tool rejects it.

The manifest contains **no secret**: no `DATABASE_URL`, no session secret, no
password hash.

## 2. Why the database snapshot is safe

The database is captured with SQLite's `VACUUM INTO`, executed through the app's
own connection:

- It runs inside a read transaction against the **live, actively written**
  database — no downtime, no maintenance window.
- The result is fully checkpointed and self-contained: there is **no companion
  `-wal`/`-shm` file** to keep in sync.
- It needs no `sqlite3` binary on the host.

> Plainly copying `data.db` while the app is running is **not** safe: the
> write-ahead log holds committed data that is not yet in the main file, and the
> copy can be torn. The backup script never does this.

## 3. Taking a backup

```bash
./scripts/production/backup.sh                # keep every archive
./scripts/production/backup.sh --retain=7     # keep the newest 7
```

Exit code 0 = success, non-zero = failure, so cron or a systemd timer can alert
on it. Nothing secret is printed.

Scheduled daily (see [production-deployment.md](production-deployment.md) §11):

```cron
15 2 * * * cd /opt/kas && ./scripts/production/backup.sh --retain=7 >> /var/log/kas-backup.log 2>&1
```

### Retention

Recommended: **7 daily**, **4 weekly**, and **at least one copy off this server**.

`--retain=N` keeps the newest N and deletes the rest. Without the flag nothing is
ever deleted — pruning is opt-in on purpose.

For weeklies, run a second scheduled copy into a different directory, or copy
one archive per week off-server and keep it there.

### Off-server copy — required

A backup on the same disk does not survive that disk failing.

```bash
docker run --rm -v kas_kas-backups:/backups -v "$PWD":/out alpine \
  tar czf /out/kas-backups-$(date -u +%Y%m%d).tar.gz -C /backups .
```

Then move that archive to another machine or an object store. D.0 deliberately
ships no automatic upload to any external service.

## 4. Restore drill — do this monthly

The drill restores into a throwaway directory **inside** the container. Live
data is not touched, and the app keeps serving.

```bash
./scripts/production/restore.sh --list
./scripts/production/restore.sh --drill backup-20260726T0215
```

The tool verifies the manifest and every SHA-256 checksum first, then writes to
`/tmp/restore-drill/`, and finally runs `prisma migrate status` against the
restored copy so you can see whether it matches the running code.

A drill is successful when:

- [ ] Verification reports no problems.
- [ ] The restored database opens and its row counts match `manifest.counts`.
- [ ] The restored upload directories contain the expected number of files.

Clean up afterwards:

```bash
docker compose -f compose.production.yml --env-file .env.production exec app rm -rf /tmp/restore-drill
```

## 5. Real restore

> **This overwrites live data. Everything written after the chosen backup is
> lost.** Do not run it to "have a look".

```bash
./scripts/production/restore.sh --live backup-20260726T0215
```

What it does, in order:

1. Asks you to type `YES`.
2. **Stops the app** — restoring a database file under a running process is how
   you corrupt it.
3. Verifies the manifest and all checksums; **aborts** if anything mismatches.
4. Requires the typed phrase `RESTORE KAS DATA`.
5. Snapshots the current database and uploads into `pre-restore-<timestamp>/`,
   so even a mistaken restore is reversible.
6. Removes stale `-wal`/`-shm` files and writes the database.
7. Replaces the upload directories wholesale (a file absent from the backup does
   not survive).
8. Runs `prisma migrate deploy` — the backup may predate the running code.
9. Starts the app and runs the health check.
10. Prints a verification checklist.

### Post-restore verification checklist

- [ ] `/api/health` and `/api/ready` both return 200.
- [ ] Row counts match `manifest.counts`.
- [ ] Admin can log in.
- [ ] **Khách sạn & chi nhánh** lists the expected branches, numbers and aliases.
- [ ] Open a booking that has a proof — the image displays.
- [ ] A receptionist sees only their own branch.
- [ ] Paste one Booking.com and one Agoda sample; both resolve to the right branch.

## 6. When a backup is rejected

The restore tool refuses, and explains why, when:

| Problem | Message |
| --- | --- |
| No/parse-failed manifest | `Thiếu hoặc hỏng manifest.json.` |
| Unknown format version | `Định dạng bản sao lưu không được hỗ trợ` |
| Database file missing | `Thiếu tệp cơ sở dữ liệu trong bản sao lưu.` |
| Database checksum mismatch | `Checksum cơ sở dữ liệu không khớp — bản sao lưu đã hỏng.` |
| Upload checksum mismatch | `Checksum thư mục "<name>" không khớp.` |

A rejected backup writes **nothing**. Pick an older archive and drill it before
committing to a live restore.

## 7. Test coverage

`server/tests/backupRestore.test.ts` runs entirely against temporary databases
and temporary directories — never a real environment:

- a snapshot taken while the database is being written is a readable database
  containing the just-written row, with no `-wal`/`-shm` companions;
- the manifest carries checksums, counts, timestamp and release, and no secret;
- retention keeps the newest N and deletes nothing by default;
- a restore into temporary targets reproduces both the database and the uploads
  byte-for-byte, and does not touch the live paths;
- a restore is refused without explicit confirmation;
- the pre-restore state is preserved;
- a missing manifest, a tampered database, a missing database file and a
  tampered upload set are each rejected, writing nothing.
