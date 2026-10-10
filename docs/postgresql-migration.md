# PostgreSQL 17 — architecture, migration and cutover (Phase D.1)

This document covers the move from the D.0 SQLite pilot to PostgreSQL 17, and
the procedures that keep it safe afterwards.

> **Phase D.1 did NOT perform a production cutover.** Everything below was
> built and rehearsed against the disposable `kas_d1_test` database. The
> reserved database `kas_production` was never connected to, migrated,
> inspected or written to.

---

## 1. Target architecture

```
Admin PC and CN1–CN8 branch browsers
            │
   Cloudflare Named Tunnel          (configured in a later phase)
            │
   KAS server on localhost:3001     node server/dist/index.js
            │
   PostgreSQL 17 on localhost:5432  Windows service, host-installed
```

- One Admin workstation, one always-on backend, eight branches on browsers.
- **No database container.** PostgreSQL is installed on the Windows host.
  Docker remains an optional secondary path for the *app only*, reaching the
  host database through `host.docker.internal`. Two copies of the data would
  mean two things to back up and one of them silently going stale.
- Production serves the built SPA, its deep links, the API, `/api/health` and
  `/api/ready` from **one origin**. It never uses `npm run dev`, Vite's port
  5173, a Quick Tunnel, hot reload, or any dev-test endpoint.

---

## 2. Why the SQLite migrations are not reused

`prisma/legacy-sqlite/migrations/` holds the eleven pilot migrations verbatim.
They are **never executed against PostgreSQL**. They use SQLite's table-rebuild
idiom:

```sql
PRAGMA defer_foreign_keys=ON;
CREATE TABLE "new_Booking" (...);
INSERT INTO "new_Booking" SELECT ... FROM "Booking";
DROP TABLE "Booking";
ALTER TABLE "new_Booking" RENAME TO "Booking";
```

PostgreSQL cannot parse `PRAGMA`, and if it could, `DROP TABLE "Booking"` would
be catastrophic. `prisma/migrations/` instead holds a deterministic baseline:

| Migration | Purpose |
|---|---|
| `20260731000000_postgresql_baseline` | The whole schema on an empty database: 21 tables, 20 enum types, 37 foreign keys, all unique/partial indexes. |
| `20260731010000_d1_concurrency_hardening` | Invariants that application code alone can no longer guarantee once writers run in parallel. |

The archive is kept, not deleted: it is still the definition of the **source**
database the transfer tool reads, and historical snapshots must stay
explainable.

### Engine differences that mattered

| Area | SQLite | PostgreSQL | Handling |
|---|---|---|---|
| Enums | `TEXT` | native enum types | Off-enum values fail loudly; `--dry-run` pre-flights every enum column. |
| `autoincrement()` | ROWID | sequence-backed | Sequences do **not** advance on explicit-id inserts → resynced (§6). |
| Booleans | `0`/`1` | native `boolean` | Coerced explicitly. |
| `DateTime` | **mixed**: epoch-ms *and* `'YYYY-MM-DD HH:MM:SS'` | `timestamp(3)` | Both forms coerced to the same UTC instant. |
| Concurrency | single writer | true parallelism | Read-then-write races became real (§7). |
| Collation | `BINARY` | `English_United States.1252` (deterministic) | Uniqueness stays case-**sensitive**; verified by test. |
| JSON columns | `TEXT` | left as `text` | Converting to `jsonb` would re-interpret stored data — forbidden. |

---

## 3. Local D.1 setup (no password ever typed into a shell)

Create an untracked `.env.d1.local` at the repository root with exactly one
line. `.gitignore` already covers it via the `.env.*` rule.

Run in an **interactive** PowerShell window (not a "Run" button — it prompts):

```powershell
$sec = Read-Host -AsSecureString 'kas_app password'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$url = 'postgresql://kas_app:' + [uri]::EscapeDataString($plain) + '@127.0.0.1:5432/kas_d1_test'
[System.IO.File]::WriteAllText('C:\Kas\.env.d1.local', "DATABASE_URL=$url`n", (New-Object System.Text.UTF8Encoding($false)))
icacls C:\Kas\.env.d1.local /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
Remove-Variable sec,bstr,plain,url
```

⚠️ **Percent-encode reserved characters** in the password —
`@ : / ? # % [ ] &` and space. `[uri]::EscapeDataString` does it for you. An
unencoded `@` makes the URL resolve to a *different host*, producing a
confusing "database does not exist" rather than an authentication error.

Never commit `.env`, `.env.production`, `.env.d1.local`, a `pgpass.conf`, or
any backup credential.

---

## 4. Schema deployment

```bash
npm.cmd run db:generate
npm.cmd run db:migrate
```

`db:migrate` is `prisma migrate deploy`. **Never** run `migrate dev`,
`migrate reset` or `db push --force-reset` against anything that holds real
data — all three can drop it.

---

## 5. SQLite → PostgreSQL transfer

```bash
npm.cmd run d1:transfer -- --source <pilot.db> --dry-run
npm.cmd run d1:transfer -- --source <pilot.db> --execute
npm.cmd run d1:verify   -- --source <pilot.db> --out report.json
```

Guarantees:

- The source is opened **read-only at the driver level** and hashed before and
  after; a changed hash is reported as a critical problem.
- The target is guarded twice — statically (URL) and live
  (`SELECT current_database()`). `kas_production` is refused before a
  connection is opened.
- Foreign keys stay **enforced**; nothing is deferred or dropped.
- One transaction per table. A failure rolls that table back whole and stops,
  so children are never inserted without their parents.
- A non-empty target is refused unless `--resume` is passed.
- The source's `_prisma_migrations` must end at
  `20260728093914_c38_branch_room_class_versioning`, or the transfer refuses.

### What the transfer deliberately does NOT do (§10)

Database migration is **storage** migration, not business-data
reinterpretation. It never re-applies a room mapping, resolves a
`LEGACY`/`UNRESOLVED` snapshot, rewrites a PMS note, moves a booking between
branches, changes guest information, or regenerates audit history.

---

## 6. Sequence synchronisation

PostgreSQL sequences are advanced only by `nextval`. Importing `id = 8`
explicitly leaves the sequence at 1, so the **first** branch an Admin creates
after a cutover would fail on a duplicate primary key — in production, with no
obvious cause.

The transfer therefore runs `setval(seq, MAX(id) + 1, false)` for every
sequence-backed column and verifies the result:

| Table | Column | Sequence |
|---|---|---|
| `Branch` | `id` | `Branch_id_seq` |
| `User` | `id` | `User_id_seq` |
| `BranchSourceAlias` | `id` | `BranchSourceAlias_id_seq` |

`npm.cmd run d1:verify` re-checks this read-only (it reads `last_value` /
`is_called` rather than calling `nextval`, so auditing never consumes an id).

---

## 7. Concurrency design

Isolation level is PostgreSQL's default **READ COMMITTED**. No global locks are
taken. Correctness comes from conditional writes plus database-level partial
unique indexes:

| Operation | Mechanism |
|---|---|
| Booking dispatch / ready / acknowledge | `updateMany` with the expected status in `WHERE` + row-count check. |
| Room-mapping activation | Archive-then-promote inside one transaction, guarded by `BranchRoomMappingVersion_one_active_per_branch`. |
| Guest PATCH | Conditional `updateMany` on `updatedAt` **inside** the transaction (the pre-check outside it is a fast fail, not the guarantee). |
| Primary-guest change | `BookingGuest_one_primary_per_booking` partial unique index. |
| Duplicate dispatch | `Booking_one_operational_per_code_branch_checkin` partial unique index. |

The last three were added in D.1. Under SQLite's single writer they could not
be observed; with eight branches writing in parallel they are real.

> The duplicate-booking index covers **operational** statuses only
> (`NEW`, `COMPLETED`, `ARCHIVED`). `DRAFT`/`READY` duplicates remain allowed,
> because the extraction flow deliberately *warns* rather than blocks.

**Cutover pre-check:** if the live pilot database already contains duplicate
operational bookings, `20260731010000_d1_concurrency_hardening` will FAIL and
stop. That is deliberate — such rows are an operational problem a human must
resolve, not something a migration may silently delete or merge.

---

## 8. Backup and restore

```bash
npm.cmd run prod:backup -- --retain=14
npm.cmd run prod:restore -- --backup=<dir> [--target-url=<url>] [--reset-schema]
npm.cmd run d1:drill -- --confirm-destructive
```

A backup directory contains `database.dump` (pg_dump custom format, schema
scoped), `uploads/`, and `manifest.json` written **last** — so a directory
without a valid manifest is by construction incomplete and is rejected.

Verification checks the manifest, the SHA-256 of the archive and of every
upload directory, **and** that `pg_restore --list` can parse the archive. A
matching checksum proves the bytes are intact; it does not prove they are a
readable archive.

Restore refuses to: run without `confirmed`, target a reserved database, drop a
schema without a second explicit flag, or restore into a schema whose name
differs from the archive's (pg_restore cannot rename schemas). It takes its own
pg_dump of the current state first, then verifies the restored data against the
manifest's counts and re-checks the C.3.8 invariants.

A backup file existing is not evidence. `d1:drill` proves the loop end to end:
back up → verify → drop schema → restore → re-count and re-check invariants.

---

## 9. Controlled production cutover (NOT performed in D.1)

1. **Announce a maintenance window.** Reception must not be dispatching.
2. **Stop the application.** No writers to the SQLite pilot.
3. **Back up the pilot** (D.0 tooling) and copy it off the machine.
4. **Pre-check** for duplicate operational bookings and for a source schema
   ending at the expected migration: `d1:transfer --dry-run`.
5. **Deploy the schema** to the empty production database:
   `npm.cmd run db:migrate`.
6. **Transfer**: `d1:transfer --execute`.
7. **Verify**: `d1:verify --out cutover-report.json`. Require **0 failures** —
   8 branches, 24 aliases, 48 active room classes, one ACTIVE version per
   branch, `3/8/4/6/6/9/6/6`, snapshots unchanged, sequences synchronised.
8. **Switch the application** to the PostgreSQL `DATABASE_URL`.
9. **Smoke test**: `/api/health`, `/api/ready`, log in, open a branch, open a
   booking with a proof image, confirm a receptionist sees only their branch.
10. **Rollback window**: keep the pilot database untouched and the application
    able to switch back for at least one full operating day.

### Rollback

The SQLite pilot file is never modified by any D.1 tool, so rollback is:
point `DATABASE_URL` back at the `file:` URL, redeploy the D.0 build, restart.
D.0-format (`formatVersion: 1`) backups are explicitly refused by the
PostgreSQL restore tool with a message pointing here, rather than failing
obscurely.

---

## 10. Windows service preparation

`scripts/production/windows/KasOps.ps1` provides the operator commands:
`Invoke-KasMigrate`, `Invoke-KasSeed`, `New-KasAdmin`, `Invoke-KasBackup`,
`Invoke-KasRestore`, `Invoke-KasHealthCheck`, `Start-KasProduction`.

PowerShell 5.1: Prisma and `psql` write informational output to **stderr**.
That is not a failure — always check the real exit code, never the presence of
stderr text.

Running the server as a Windows service (NSSM / `sc.exe`) is a later phase; it
requires `NODE_ENV`, `DATABASE_URL`, `SESSION_SECRET` and the directory
variables in the service environment, and the service account must have read
access to whatever holds them.

---

## 11. Prohibited commands

Never run these against any database that holds real data:

```
prisma migrate reset
prisma db push --force-reset
DROP DATABASE kas_production
DROP SCHEMA public CASCADE      (on anything but a disposable target)
TRUNCATE <operational table>
manual DELETE of operational rows
```

`kas_production` is refused by `server/src/d1/guard.ts` in every D.1 tool —
including any database whose name merely *contains* "production".

---

## 12. Failure recovery

| Symptom | Cause | Action |
|---|---|---|
| `password authentication failed` | wrong password, or unencoded reserved character | Re-create `.env.d1.local` with `[uri]::EscapeDataString`. |
| `database "…" does not exist` right after a password change | unencoded `@` split the URL | Same as above. |
| `/api/ready` reports `migrations: schema chưa được triển khai đầy đủ` | database reachable but not migrated | `npm.cmd run db:migrate`. |
| Duplicate key on the first new branch/user after cutover | sequences not resynced | Re-run `d1:verify`; re-run the transfer's sequence step. |
| `d1:transfer` refuses: target not empty | a previous run already wrote | Confirm intent, then `--resume`. |
| Migration fails on `Booking_one_operational_per_code_branch_checkin` | real duplicate operational bookings exist | Resolve them with an operator — never auto-delete. |
