# Developer test environment — all branches, demo data & safe cleanup

> Since Milestone C.3.7 the branch count is **not fixed at 8**: the Admin can add,
> renumber and disable branches at runtime (see
> [`branch-management.md`](branch-management.md)). Everything below derives the
> branch set from the database — the "8" in this document is simply the number the
> system currently ships with.

> **DEVELOPMENT ONLY.** Everything below is gated by `ENABLE_DEV_TEST_TOOLS` **and**
> a non-production `NODE_ENV`. In production every dev-test endpoint responds `404`
> and no dev UI is shown — even if the flag is mistakenly set to `true`.
>
> **Never enable `ENABLE_DEV_TEST_TOOLS` in production.**

## 1. Enabling the developer tools

In your local `.env`:

```
NODE_ENV=development
ENABLE_DEV_TEST_TOOLS=true
```

Restart the server. When enabled, a yellow banner **“CHẾ ĐỘ DỮ LIỆU TEST ĐANG BẬT”**
appears under the top bar for every user, and the Admin gains a **“Công cụ dữ liệu
test”** panel in *Quản lý tài khoản* (Settings).

To disable again: set `ENABLE_DEV_TEST_TOOLS=false` (or remove it) and restart.

## 2. The test receptionist account

A single dedicated account is used to test every branch (its switcher lists all
active branches, including any the Admin has just added):

| | |
| --- | --- |
| Username | `reception_test` |
| Display name | `Lễ tân Test 8 Chi Nhánh` |
| Password | `ReceptionTest1` (dev-only, documented on purpose) |
| Role | `RECEPTIONIST` |

Create/reuse it from the Admin (it is also created automatically the first time you
generate demo data): `POST /api/dev-test/ensure-test-account`.

**It does not weaken branch isolation.** Ordinary receptionists remain permanently
tied to their assigned branch. Only `reception_test`, and only while the dev tools
are enabled, can switch its *effective* branch — and that choice lives **only in the
session** (the account’s stored DB branch is never changed).

## 3. Branch switching

Log in as `reception_test`. The banner shows a **“Chi nhánh đang test”** selector
listing all 8 stored branch addresses. Choosing one:

- calls `POST /api/dev-test/active-branch` (session only), and
- invalidates every branch-scoped query, so **Đơn mới / Chờ kiểm tra / Cần tạo lại /
  Đã hoàn thành / Lịch sử / Sự cố / Thông báo / bộ đếm sự cố** all refresh to the
  chosen branch — no logout required.

A client-supplied `branchId` on ordinary API calls **cannot** override this; the
server always uses the session’s active test branch for the test account. Ordinary
receptionists never see the switcher and can never switch.

## 4. Generating demo data

Admin → Settings → **Công cụ dữ liệu test**. Configure:

- **Số booking mỗi chi nhánh** (0–100)
- **Số sự cố mỗi chi nhánh** (0–50)
- **Bao gồm proof / OCR / comparison**
- **Seed** (same seed ⇒ identical data — deterministic)

Press **“Tạo dữ liệu demo cho *N* chi nhánh”** (the count comes from the server,
never a hardcoded 8) and confirm. API: `POST /api/dev-test/demo/generate`.

The generator spreads data across **every ACTIVE branch** — a ninth branch added by
the Admin is included automatically, and a disabled branch is skipped — and across
booking statuses
(`DRAFT/READY/NEW/PENDING_REVIEW/REJECTED/COMPLETED`), payment (`PAY_BEFORE/PAY_AFTER`),
business type (`DIRECT/PARTNER/UNKNOWN`), single/multi-room, single/multi-night,
last-minute and future dates, with/without phone, arrival notes, and breakfast per
the existing branch codes. Proofs use tiny generated placeholder PNGs; OCR and
comparison rows are **safe fakes** (provider `demo`) — **real Tesseract is never
invoked** and nothing is auto-approved.

All data is obviously fictional (`TEST Nguyễn Văn 001`, code `TST00000001`, phone
`0900000001`) and every row is tagged `isDemo = true` + a `demoBatchId`.

## 5. Clearing demo data

Admin → **“Xóa toàn bộ dữ liệu demo”** (danger). Two-step confirmation; the second
step requires typing exactly:

```
XOA DU LIEU DEMO
```

API: `DELETE /api/dev-test/demo` (body `{ "confirmPhrase": "XOA DU LIEU DEMO" }`).

**Demo clear deletes only demo-tagged data** (bookings + their rooms/nights/proofs/
OCR/comparisons/history, demo issues, demo notifications, demo batches, and the demo
proof/issue image files). It **preserves**: real bookings/issues/proofs/
notifications, all users, **every branch** + its settings (branch number, breakfast,
address, code) **and its platform hotel names**, configuration, parser/business-type
rules and migrations.

## 6. Demo clear vs official-launch reset

|  | Demo clear | Official-launch reset |
| --- | --- | --- |
| Trigger | Admin button (`DELETE /api/dev-test/demo`) | CLI only (`npm run data:prepare-production`) |
| Deletes | **only** `isDemo` data | **ALL** operational data (demo **and** real) |
| Backup | not required | **required** (DB + uploads + manifest) before deletion |
| `reception_test` | kept | disabled |
| Sessions | kept | all cleared |

## 7. Official-launch reset (final transition)

When testing is finished and you are ready to hand the system to real operators:

```bash
npm run data:prepare-production
```

It requires the interactive phrase:

```
PREPARE KAS FOR OFFICIAL USE
```

and (in production only) an explicit `--allow-production` flag. It:

1. **Backs up first** — copies `prisma/data.db`, the proof/issue upload dirs and a
   `manifest.json` (before/after counts) to a timestamped folder under `backups/`
   (git-ignored). It **aborts if the backup fails** — nothing is deleted.
2. Deletes ALL operational data: bookings, rooms, nights, histories, proofs, proof
   files, OCR analyses, comparisons, notifications, hotel issues, issue photos,
   sessions and demo batches.
3. **Disables** `reception_test` (never auto-creates production receptionists).
4. **Preserves**: schema + all migrations, **every configured branch** (branch
   numbers / codes / addresses / breakfast / contact) **and every
   `BranchSourceAlias`**, the Admin account, roles/permissions and configuration.

It is **idempotent** — running it twice leaves the system safely empty.

> Do not run the official reset against data you want to keep. Use `--allow-production`
> only for the real go-live.

## 8. Empty official state — verification

After the reset the app opens normally with clear empty states and:

- 8 configured branches, 1 real Admin account, roles/permissions, configuration
- **zero** bookings/rooms/nights/proofs/OCR/comparisons/notifications/issues/photos
- **zero** active sessions, no `reception_test` access, no demo batches/files

Quick check (dev):

```bash
npx prisma studio --schema prisma/schema.prisma   # Booking / HotelIssue / Notification = 0
```

## 9. Creating real receptionists later

Production receptionists are created **manually, after** go-live, from Admin →
*Quản lý tài khoản* → **Thêm bộ phận**, each assigned to exactly one real branch. Do
not reuse `reception_test` for real operations.

## 10. Backups

`backups/pre-official-<timestamp>/` contains `data.db`, `uploads/` and `manifest.json`.
Keep these off the machine (copy to another drive) and **never commit them** — the
`backups/` directory is git-ignored.
