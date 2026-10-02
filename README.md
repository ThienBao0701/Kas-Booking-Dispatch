# hotel-booking-dispatch

Hệ thống điều phối và theo dõi đơn đặt phòng nội bộ (internal hotel booking dispatch and tracking system).

Quản trị viên (Admin) dán văn bản đặt phòng thô từ Booking.com, hệ thống trích xuất thông tin (khách, ngày, **giá từng đêm của từng phòng**), Admin kiểm tra rồi **gửi xuống chi nhánh**. Lễ tân (Receptionist) của 8 chi nhánh chỉ thấy đơn của chi nhánh mình, sao chép thông tin, tạo đặt phòng trong hệ thống khách sạn nội bộ, rồi bấm **Đã tạo hoàn thành**. Toàn bộ lịch sử được lưu vĩnh viễn.

## Tech stack

- **Frontend:** React + TypeScript + Vite + Tailwind CSS + TanStack Query + React Hook Form + Zod — installable PWA
- **Backend:** Node.js + Express + TypeScript + Prisma + SQLite, session-based auth, Server-Sent Events
- **Testing:** Vitest, React Testing Library, Supertest

## Quick start (development)

```bash
npm install
copy .env.example .env    # then edit .env (SESSION_SECRET, INITIAL_ADMIN_*)
npm run db:migrate
npm run db:seed
npm run dev               # starts the backend (:3002) and the frontend (:5173) together
```

Then open the frontend at **http://localhost:5173** and log in with the initial
Admin from `.env`. The backend API runs on **http://localhost:3002**; in
development the Vite dev server proxies `/api` to it, so the browser stays
same-origin and the session cookie flows automatically.

> **Development uses 3002, production uses 3001.** They are separate on purpose,
> so both can run at the same time. If development is ever pointed back at 3001
> and a production service is listening, the dev frontend will proxy `/api` into
> the production backend and show live data behind a local-looking UI.

To run the two servers separately:

```bash
npm run dev -w server     # backend only, http://localhost:3002
npm run dev -w client     # frontend only, http://localhost:5173 (proxies /api → :3002)
```

**Sessions & credentials:** authentication is a server-side session addressed by
an HTTP-only cookie — the frontend stores **no** token in LocalStorage or
SessionStorage, and every request is sent with `credentials: "include"`.
Refreshing the browser restores the session from the cookie via
`GET /api/auth/me`. A user with a temporary password is forced to change it
before reaching the app.

> The frontend is currently the **Phase 3A foundation**: authentication,
> app shell, role-based navigation and professional empty states. The booking
> screens arrive in later phases.

## Production

```bash
npm run build
npm run start
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start server + client in development mode |
| `npm run build` | Production build (server + client) |
| `npm run start` | Run production server (serves built client) |
| `npm run test` | Run all tests |
| `npm run lint` | Lint all workspaces |
| `npm run typecheck` | TypeScript checks |
| `npm run db:migrate` | Apply database migrations |
| `npm run db:seed` | Seed the initial branches + backfill their platform hotel names |

## Authentication & accounts

The backend uses session-based authentication (an HTTP-only cookie holding only
an opaque session id; all session data stays server-side). Sessions are stored
in the SQLite database and survive server restarts.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | Signs the session cookie. **Required**, ≥ 16 characters. |
| `SESSION_COOKIE_SECURE` | `true` to send the cookie only over HTTPS (production). Default `false`. |
| `SESSION_MAX_AGE_HOURS` | Session lifetime / rolling idle window. Default `12`. |
| `LOGIN_RATE_LIMIT_MAX` | Login attempts per IP per window before `429`. Default `10`. |
| `LOGIN_RATE_LIMIT_WINDOW_MINUTES` | Login rate-limit window. Default `15`. |
| `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` / `INITIAL_ADMIN_FULL_NAME` | The first administrator, created once at startup. |
| `PROOF_UPLOAD_DIR` | Filesystem directory for proof screenshots. Relative paths resolve from the repo root. Default `server/uploads/booking-proofs` (git-ignored). Only metadata + a safe path are stored in SQLite. |

### First login

1. Set `INITIAL_ADMIN_*` in `.env`. On first start the server creates that
   single ADMIN account (password bcrypt-hashed). It is never recreated or
   overwritten on later restarts. **There is no default public account** — in
   production the server refuses to start if these are missing rather than
   inventing a predictable one.
2. Log in at `POST /api/auth/login` with those credentials.
3. The initial admin is flagged `mustChangePassword`. Until the password is
   changed via `POST /api/auth/change-password`, every protected endpoint
   returns `PASSWORD_CHANGE_REQUIRED` — only `GET /api/auth/me`,
   `POST /api/auth/change-password` and `POST /api/auth/logout` are allowed.

Password policy: at least 8 characters including a letter and a number.

### Managing receptionists (admin only)

The admin creates and manages receptionist accounts via `/api/admin/users`
(create, update name/branch, reset password, enable/disable). Each new
receptionist gets a temporary password and is forced to change it at first
login. Accounts are never deleted (historical bookings reference them) — disable
them instead. A disabled account, or one whose password was just reset, loses
access on its next request even if it still holds a session cookie.

### Branch isolation

Every receptionist is bound to exactly one branch (8 initially; the Admin can add
more — see [docs/branch-management.md](docs/branch-management.md)). The backend
enforces this on every request from the authenticated session — a receptionist
can never reach another branch by changing a URL id, a query parameter, or a
JSON `branchId`. The admin can see and act across all branches.

### Development login workflow

```bash
copy .env.example .env    # then set SESSION_SECRET and INITIAL_ADMIN_*
npm run db:migrate
npm run db:seed
npm run dev
# POST http://localhost:3002/api/auth/login  { username, password }
# -> then POST /api/auth/change-password to clear the forced change
```

## Booking dispatch workflow (backend)

Kas is **not** a hotel PMS and never creates hotel reservations. It routes a
Booking.com **or Agoda** reservation to one branch and tracks whether the branch
actually created it — verified by an uploaded screenshot the Admin checks.

### Status flow

```
DRAFT ──(ready, optional)──▶ READY ──┐
  │                                   ├──(send)──▶ NEW ──(admin approves proof)──▶ COMPLETED ──▶ ARCHIVED
  └───────────────(send)──────────────┘
```

- **DRAFT** — extracted and saved; the Admin may edit it; not visible to receptionists.
- **READY** — optional review gate: the Admin validated the data. Editing a READY
  booking sends it back to **DRAFT** for revalidation.
- **NEW** — dispatched to exactly one branch; visible in that branch's *Đơn mới*
  list; awaiting external creation + proof.
- **COMPLETED** — the Admin reviewed the receptionist's proof screenshot and
  confirmed the reservation was created correctly. Reached **only** by proof
  approval (see below). Kept permanently.
- **ARCHIVED** — older history, retained (never hard-deleted).

Every status transition writes one immutable `BookingStatusHistory` row.

### Proof verification workflow

A booking carries a second, independent `verificationStatus` lifecycle alongside
`status`:

```
NOT_SUBMITTED ──(receptionist uploads proof)──▶ PENDING_REVIEW ──┬─(admin: Đúng)──▶ APPROVED  (status ⇒ COMPLETED)
        ▲                                                         │
        └──────────────────(receptionist resubmits)◀── REJECTED ◀┘ (admin: Sai + lý do)
```

- The receptionist creates the reservation in the external hotel system, then
  uploads **≥1 screenshot** (PNG/JPEG/WebP, ≤10 MB) with an optional note and
  presses **"Gửi Admin kiểm tra"** (`POST /api/bookings/:id/proofs`). The booking
  moves to `PENDING_REVIEW` and every active Admin is notified.
- The Admin opens a desktop **LEFT (original booking) / RIGHT (screenshot)**
  comparison and either **approves** (`…/proofs/:proofId/approve` → booking
  `COMPLETED` + `APPROVED`) or **rejects** with a reason code
  (`…/proofs/:proofId/reject` → `REJECTED`, status stays `NEW`).
- On rejection the receptionist sees the reason (*Sai tên khách, Sai mã Booking,
  Sai ngày, Sai số lượng phòng, Sai hạng phòng, Sai giá, Thiếu phòng, Ảnh không
  rõ, Khác*) and can **resubmit**, creating attempt #2, #3, …
- Every attempt is an **immutable** `BookingCreationProof` row
  (`@@unique([bookingId, attemptNumber])`) — proofs are never overwritten or
  hard-deleted, preserving the full audit trail even if the receptionist is later
  disabled.

**Proof file storage.** Only metadata + a safe server-generated relative path live
in SQLite — never the image bytes. Files are written under `PROOF_UPLOAD_DIR`
(default `server/uploads/booking-proofs`, git-ignored) with a random server name;
the client filename is never trusted. The real image type is verified by
**magic-byte sniffing** (PNG/JPEG/WebP) — a spoofed content-type is rejected
`415 UNSUPPORTED_MEDIA`, oversize is `413 FILE_TOO_LARGE`. Images are served only
through an authenticated, branch-isolated route
(`GET /api/bookings/:id/proofs/:proofId/image`), never as public static files.

### Proof OCR — advisory extraction only

When a proof is submitted, the server can run **OCR** over the screenshot to read
operational text (booking code, guest name, check-in/out dates, nights, room type,
room quantity, total, payment wording, note, branch/address when visible) and show
it to the Admin. This is **advisory extraction only**:

- It **never** approves, rejects, or compares a proof against the booking, and it
  produces **no** MATCH/MISMATCH verdict and no approval recommendation. The Admin
  always checks the screenshot themselves. (Comparison/decisioning is a later
  milestone.)
- Every extracted field carries an **OCR confidence** (0–100). That is a signal
  about the *reading*, not about whether the proof is correct. Uncertain fields
  are returned as `null` (NOT_FOUND) — a value is never invented.

**Pluggable provider.** OCR runs through a `ProofOcrProvider` abstraction so no
paid/cloud service is hard-coded. Two flags in `.env` control it:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROOF_OCR_ENABLED` | `false` | Off by default — the app always starts and works without OCR. |
| `PROOF_OCR_LANGUAGE` | `eng+vie` | Tesseract language packs, used only when enabled. |

When enabled, the first provider is **local [`tesseract.js`](https://github.com/naptha/tesseract.js)**,
loaded lazily as an **optional** dependency (`npm install tesseract.js -w server`);
if it is not installed the run simply fails gracefully. Automated tests use a
deterministic mock provider and never require real Tesseract.

**Failure / disabled behaviour.** Proof submission **never fails because of OCR**.
If OCR is disabled the analysis is recorded as `DISABLED`; if it errors it is
recorded as `FAILED` with a **sanitised** message (never a stack trace or file
path) and the Admin sees a "check the image manually" note. The proof attempt is
valid regardless.

**Data model.** Each run is an immutable `BookingProofAnalysis` row
(`PENDING → PROCESSING → COMPLETED | FAILED`, or `DISABLED`). A proof may have
several runs — **re-analysis creates a new row; earlier runs are preserved**. The
raw text is length-capped and the structured fields are stored as a JSON string;
no image BLOBs and no filesystem paths are stored. Only one run may be active per
proof at a time (duplicate active runs are refused with `409`).

**Admin-only APIs** (receptionists cannot read raw OCR data; branch isolation and
proof authorization are enforced):

```
GET  /api/admin/bookings/:bookingId/proofs/:proofId/analyses          # all runs, newest first
GET  /api/admin/bookings/:bookingId/proofs/:proofId/analyses/latest   # most recent run (or null)
POST /api/admin/bookings/:bookingId/proofs/:proofId/analyze           # re-analyse (guards duplicates)
```

### Proof compare engine — advisory, deterministic, local

After an OCR analysis becomes `COMPLETED`, the server compares the **persisted
booking** (what the Admin dispatched) against the **OCR-detected** fields and
stores an immutable `BookingProofComparison`. It is **local, deterministic logic
only** — no AI, no external service — and is **advisory**: it never approves,
rejects, or changes any booking/proof status. The Admin remains the decision-maker.

**Field states** are `MATCH` / `MISMATCH` / `WARNING` / `NOT_FOUND` /
`NOT_APPLICABLE`; the **overall** verdict is:

- `MATCH` — every detected field matches safely.
- `WARNING` — no confirmed critical mismatch, but some fields are missing/uncertain.
- `MISMATCH` — at least one field clearly differs (any critical field, or an
  opposite payment instruction).
- `UNAVAILABLE` — OCR disabled/pending/failed, or no completed analysis.

**Critical fields** (a confirmed mismatch ⇒ overall `MISMATCH`): booking code
(exact digits, never fuzzy), check-in, check-out, total amount, room quantity.
**Operational fields**: customer name (accent-insensitive, bounded edit distance),
room type (controlled alias map, e.g. *Standard Double ≈ STAN*), payment status
(opposite ⇒ `MISMATCH`), night count, nightly prices, PMS-note components.
Unreadable nightly prices are `NOT_APPLICABLE` (excluded) so an otherwise-clean
proof is never marked wrong just because per-night prices weren't legible.

Rules live in focused modules (`server/src/booking/compare/`: `comparators.ts`,
`engine.ts`, `textNormalize.ts`, `derive.ts`) under a stable
`comparisonVersion` (**`proof-compare-v1`**); a future ruleset change gets a new
version. Runs are immutable — re-analysis (a new `COMPLETED` analysis) yields a new
comparison and preserves earlier ones. At most one comparison per
`(analysis, version)`.

**Admin-only APIs** (receptionists cannot read comparison JSON; proof∈booking
enforced):

```
GET  /api/admin/bookings/:bookingId/proofs/:proofId/comparisons          # all runs, newest first
GET  /api/admin/bookings/:bookingId/proofs/:proofId/comparisons/latest   # most recent (or null)
POST /api/admin/bookings/:bookingId/proofs/:proofId/compare              # compare latest completed
                                                                         #   analysis (409 if none /
                                                                         #   already compared)
```

#### Smart compare assistant (C.3.5) — deterministic explanations

The comparison result is **additively enriched** (still `proof-compare-v1`, no new
migration) with deterministic, local explanations — never AI, never a status
change. Each field may carry:

- **`details`** — structured diff: booking-code `changedPositions`/`missingCount`/
  `extraCount`; money `deltaAmount` + `direction`; date `deltaDays`; night
  `deltaNights`; room `deltaQuantity` + per-type `roomGroups` + `addedTypes`.
- **`explanation`** — one Vietnamese sentence (e.g. *"Ảnh thấp hơn dữ liệu Admin
  450.000 đ."*, *"Ngày trong ảnh trễ hơn 1 ngày."*, *"Thiếu 1 phòng."*, *"Khớp sau
  khi bỏ dấu tiếng Việt."*).
- **`suggestion`** — a fixed per-field "what to check" hint (stable lookup, no
  free-form text).
- **`diffSegments`** — a safe token diff (`unchanged`/`added`/`removed`) for name,
  room type, etc., rendered as **text only** (never `dangerouslySetInnerHTML`).
- **`confidenceLabel`/`confidenceMessage`** — the field's OCR confidence bucketed
  as HIGH (≥90) / MEDIUM (70–89) / LOW (<70). Confidence is *not* correctness.

The result also gains a **`headline`**, a de-duplicated **`suggestions`** list
("Admin nên kiểm tra …"), and a **`noteComponents`** checklist for the PMS note
(Mã Booking / Hạng phòng / Số đêm / Giá tổng / Thanh toán / CI, plus Ăn sáng for
breakfast branches, Đơn đối tác for partner bookings, Giờ đến when expected).
Helpers live in `server/src/booking/compare/{smartDiff,suggest,enrich}.ts`.
**Enrichment is strictly additive** — it never changes a field `result` or the
`overall` status, and older stored C.3 rows (without these fields) remain readable.

### Send-to-branch flow

`POST /api/admin/bookings/:id/send` (Admin) assigns one branch, re-runs full
validation, and — if there are no blocking errors and every non-blocking warning
is acknowledged (`acknowledgedWarningCodes`) — atomically: sets `branchId`,
`status = NEW`, `sentAt`, `sentByUserId`, computes `isLastMinute`, writes status
history, and creates an unread notification for every **active** receptionist of
that branch. `sentAt` is permanent and is never overwritten by `completedAt`
(*gửi đơn ngày nào thì phân loại ngày đó*). Re-sending a dispatched booking is a
`409 CONFLICT` with no duplicate side effects.

### Branch isolation

A receptionist only ever sees dispatched bookings for their own branch. A
client-supplied `branchId` on `GET /api/bookings/new|pending-review|rejected|completed|history`
is ignored for receptionists (the server derives the branch from the session), and
viewing, uploading a proof for, reviewing, or fetching a proof image of another
branch's booking returns `403 BRANCH_ACCESS_DENIED`. Receptionists cannot approve
or reject proofs (`requireAdmin`). `rawText` is returned to the Admin only, not to
receptionists.

### Last-minute definition

A booking is **last minute** when its check-in date equals *today in
Asia/Ho_Chi_Minh* at dispatch time. The backend is authoritative (never the
browser timezone), `isLastMinute` is persisted at send time and not recomputed on
read, and the receptionist inbox sorts last-minute bookings first.

### Duplicate detection

Sending is refused with `409 DUPLICATE_BOOKING` when another `NEW`/`COMPLETED`/
`ARCHIVED` booking already exists with the same `bookingCode` + `branchId` +
`checkInDate` (the response carries the existing booking id and status).

### Persistent notifications (no realtime yet)

Notifications are stored rows exposed by polling-ready APIs
(`GET /api/notifications`, `/api/notifications/unread-count`,
`POST /api/notifications/:id/read`, `/api/notifications/read-all`); each is scoped
to its owner. **Server-Sent Events / live push are intentionally deferred to a
later phase.**

### Hotel issue counters (branch command center)

Unresolved hotel-issue counts are computed **live from `HotelIssue` status** — there
is no persisted counter table and no duplicate totals. **Unresolved = `NEW` +
`IN_PROGRESS`; `COMPLETED` issues stay in history but are never counted.**

`GET /api/issues/summary` returns totals plus a per-branch breakdown:

```jsonc
{ "totalUnresolved": 8, "newCount": 5, "inProgressCount": 3,
  "byBranch": [ { "branchId": 8, "address": "191 Lê Thánh Tôn",
                  "newCount": 2, "inProgressCount": 1, "totalUnresolved": 3 } ] }
```

Branch scope mirrors the rest of the app: an **Admin** and **Bộ phận kỹ thuật**
each see **all eight branches** (including zero-count ones); a **receptionist**
sees **only their own branch** and cannot widen the scope with a `branchId` query
parameter. The counters feed the
Admin sidebar badge, the dashboard "Sự cố đang mở" card, and the per-branch summary
cards on the Issues page (click a card to filter the list). They refresh on the
existing **polling** cadence — **no SSE**. Counts always come from issue status,
never from unread-notification rows.

### History API

`GET /api/bookings/history` supports search (booking code / customer / phone) and
filters (branch, status, payment, last-minute, sent/check-in/completed date
ranges) with pagination; receptionists are always constrained to their own branch.

## Operational app (frontend)

Kas is an internal **booking dispatch centre** — it is **not** a hotel PMS and
never creates hotel reservations. It extracts Booking.com **and Agoda**
information, dispatches it to one branch, helps receptionists copy it into their
own hotel system, and records **proof-verified** confirmation.

### Import sources — Booking.com + Agoda

The **Nhập đơn** page has two tabs, **Booking.com** and **Agoda**. Each pastes raw
confirmation text into the same extraction engine; the Agoda adapter
(`parseAgodaBooking`) reuses the shared parser with a few Agoda-specific labels
(*Agoda Booking ID, Lead guest, Total charge, Rooms booked*), the `VND 1,050,000`
money format and Agoda prepaid phrases, and returns the **identical** normalized
structure. Booking.com behaviour is unchanged. Each booking stores its
`sourcePlatform` (`BOOKING_COM` | `AGODA`), shown as a chip throughout the UI.

#### Public hotel names → stable branch codes

A property is listed under **different public names on different platforms**, and a
listing can be **renamed over time**. Routing always uses the stable branch `code`,
never a display name, a numeric id or a position in a list. Earlier public names are
**kept** as aliases so historical emails still parse, and every alias must resolve to
exactly one branch (asserted by a no-ambiguity test).

Since Milestone C.3.7 these names live in the database (`BranchSourceAlias`) and are
managed by the Admin — see **[docs/branch-management.md](docs/branch-management.md)**.
`npm run db:seed` backfills every name below from the legacy in-code tables
(`branchMatcher.BRANCH_ALIASES`, `AGODA_HOTEL_NAMES`), which remain only as defaults
for fixtures and as a post-migration fallback. Matching behaviour is unchanged:
Booking.com prefers an exact alias then similarity, Agoda is exact-only.

Current Booking.com names for the two renamed properties:

| Booking.com public name | Branch code | Stored address |
| --- | --- | --- |
| Bamboo Water Hotel *(was Luxury Elegance Hotel Ben Thanh)* | `LY_TU_TRONG_260` | 260 Lý Tự Trọng |
| Kaliee Nata Hotel *(was INDOCHINA Premium)* | `NGUYEN_THAI_BINH_170` | 170-172-174 Nguyễn Thái Bình |

The normalized booking still shows the **stored branch address** as the operational
hotel; the source name is retained for audit/parser review.

#### Agoda hotel-partner (YCS) booking emails

`parseAgodaBooking` recognises a **second** Agoda document — the hotel-partner
booking email — and routes it to a dedicated deterministic extractor
(`server/src/booking/agodaPartner.ts`). Detection requires **at least two**
partner-specific markers (*Reference sell rate, Net rate, Customer First/Last Name,
No. of Rooms, No. of Extra Bed, Rate Plan, Reservation Information*), so a generic
"Booking confirmation" line, a Booking.com email or a manual booking can never be
misclassified. Extracted: booking id, property, customer first/last/full name,
country, dates, nights, room type + quantity, occupancy, extra beds, rate plan,
cancellation policy, nightly rates, reference sell rate, net rate, payment.

Hard rules:

- **The operational "Khách sạn" value is the configured branch ADDRESS**, exactly
  like Booking.com — never Agoda's public property name. The public "KAS …" name is
  only a *lookup value*: `branchMatcher.AGODA_HOTEL_NAMES` maps the eight names to
  existing stable branch codes and `resolveAgodaBranch` resolves them by an **exact**
  (case/accent/whitespace-normalised) match. Exact matching is deliberate — every KAS
  name shares the words "KAS" and "Hotel", so similarity scoring would rate different
  properties alike. An unknown or incomplete name (*KAS Passion Hotel*, *Milestone
  Premium*, *KAS Sonata Hotel*, *KAS Luxury Hotel*, *Unknown Hotel*) is **never**
  assigned to a default branch: the source name is preserved, the warning *"Không xác
  định được địa chỉ chi nhánh từ tên khách sạn Agoda."* is raised, and the Admin
  selects the branch manually. All eight names are operator-confirmed:

  | Agoda property name | Branch code | Stored address |
  | --- | --- | --- |
  | KAS Passion Boutique Hotel | `TRUONG_DINH_05` | 05 Trương Định |
  | KAS Elegance Hotel | `LY_TU_TRONG_260` | 260 Lý Tự Trọng |
  | KAS Ancient Boutique Hotel | `NGUYEN_TRAI_47A` | 47A Nguyễn Trãi |
  | KAS Milestone Premium Hotel | `NGUYEN_THAI_BINH_170` | 170-172-174 Nguyễn Thái Bình |
  | KAS Zody Boutique Hotel | `LE_THANH_TON_278` | 278 Lê Thánh Tôn |
  | KAS Sonata Luxury Hotel | `BUI_THI_XUAN_40` | 40-42 Bùi Thị Xuân |
  | KAS Eliana Luxury Hotel | `BUI_THI_XUAN_13` | 13 Bùi Thị Xuân |
  | KAS Dilly Hotel | `LE_THANH_TON_191` | 191 Lê Thánh Tôn |
- **Agoda's Property ID is never read, stored, displayed or tested.** Only the
  property name is taken from a `KAS … (Property ID 245858)` block.
- **Nights = check-out − check-in** (calendar days), never the nightly-row count,
  the email date or "today"; cross-month and cross-year stays are supported.
- **The Net rate is the total hotel receivable (công nợ).** The internal nightly
  debt schedule is generated by splitting that total **evenly across the stay
  nights** (`money.allocateEvenly`), check-in inclusive → check-out exclusive, and
  always sums back to the total exactly. An indivisible remainder is distributed one
  đồng at a time to the **earliest** nights (`1.000.001 / 2 → 500.001 + 500.000`);
  VND stays integer and the total is never rounded or changed. The split is by
  **nights**, never by adults, occupancy, extra beds or rooms. Agoda's own nightly
  rows are parsed for **diagnostics only** — if they disagree with the generated
  allocation a non-blocking `INFO` warning is raised and the total is left untouched.
- **Room quantity comes only from "No. of Rooms"** — never occupancy/adults/beds.
- **Room type → code** via a controlled, *specificity-ordered* map:
  `Standard`/`Standard (0)` → **STAN**, `Superior` → **SUP**, `Deluxe` → **DEL**,
  `Deluxe Room - 01` → **LUXDEL**, `D-D Room - 03` / `Deluxe Giường Đôi/2 Giường Đơn`
  → **DD**, `Deluxe Balcony` → **DEBAL**, `King Balcony` → **KINGBAL**,
  `Deluxe Family` → **DEFAM**, `Family` → **FAM**. The most specific pattern always
  wins (so *Deluxe Room - 01* is never DEL). An **unknown type is preserved verbatim
  and flagged for manual review — never guessed** into an existing code.
- The note's first amount is the labelled **Net rate**, the second the labelled
  **Reference sell rate**. Commission, other programs, withholding tax, tax on
  commission, promotions and compensation are **never** used and never derived
  arithmetically; a missing rate fails safely with a validation error.
- Money accepts `VND 1,016,710.00`, `1,680,000 VND`, `1.016.710 VND` (a trailing
  2-digit decimal is dropped, 3-digit groups are kept) and renders with Vietnamese
  dot separators.

The operator's exact two-line PMS note is produced by `buildAgodaPmsNote`:

```
AGD 1753026280_1STAN_2DEM 1.016.710 CN
GIÁ KHÁCH ĐẶT 1.680.000 KHONG AN SANG
```

The breakfast phrase is a fixed business rule — coffee/tea, drinking water or a
welcome drink are **not** breakfast, so line 2 always ends `KHONG AN SANG`. The note
never contains the customer name, phone, dates, cancellation policy, `PREPAID`, or
commission. `PREPAID` is still captured as structured payment data. The extract
preview returns these details as `agoda`, and the **Nhập đơn** page shows them with
a one-click copy of the note.

### Booking business type (DIRECT / PARTNER / UNKNOWN)

Every booking carries a **business type**, independent of the OTA source, branch,
payment status or proof state:

| Type | UI label | Meaning |
| --- | --- | --- |
| `DIRECT` | 🟢 Đơn thường | An ordinary retail reservation. |
| `PARTNER` | 🟠 Đơn đối tác | A B2B / agency / corporate / partner-rate reservation. |
| `UNKNOWN` | ⚪ Chưa xác định | No confident evidence — the Admin confirms. |

**Automatic detection.** At extraction a deterministic `detectBusinessType`
inspects the reservation text (rate plan, notes, configured partner keywords) —
**never the phone number, never the OTA source, never AI/random**. It scores
matched evidence 0–100; at or above the **confidence threshold (90)** it classifies
`DIRECT` or `PARTNER` automatically, otherwise `UNKNOWN`. An ordinary
Booking.com/Agoda booking is never `PARTNER` just because of the OTA source (the
"Booking.com for Partners" extranet chrome is explicitly ignored). All keywords,
aliases and weights live in one file, **`server/src/booking/partnerDetectionRules.ts`**
— *the current limitation is that partner rules are configured in code*; add new
partners there.

**Manual override.** On the review form the Admin sees the detected type + a
confidence read-out ("Độ tin cậy loại đơn: 96%"). For `UNKNOWN` a prompt appears
("Không thể tự xác định loại đơn. Admin vui lòng xác nhận.") with two actions —
**Đánh dấu là Đơn thường** / **Đánh dấu là Đơn đối tác**. A manual choice is
persisted (`businessTypeManuallyConfirmed = true`), overrides detection and is
never re-detected afterwards. Only an Admin may confirm/override
(`POST /api/admin/bookings/:id/business-type`, admin-only); a receptionist cannot.
A `ĐƠN ĐỐI TÁC` badge marks partner bookings on detail and list rows; `UNKNOWN`
shows `CHƯA XÁC ĐỊNH LOẠI ĐƠN`.

### Vietnamese status labels (UI)

| DB status | UI label | Verification | UI label |
| --- | --- | --- | --- |
| `DRAFT` | Bản nháp | `NOT_SUBMITTED` | Chưa gửi kiểm tra |
| `NEW` | Chờ chi nhánh tạo | `PENDING_REVIEW` | Chờ kiểm tra |
| `COMPLETED` | Đã xác nhận đúng | `APPROVED` | Đã xác nhận đúng |
| `ARCHIVED` | Đã lưu trữ | `REJECTED` | Cần tạo lại |

### Payment wording (operational)

Every operational screen (dispatch form, booking detail, PMS note, COPY ALL,
history, completed lists, proof review) shows exactly **`PAY BEFORE CHECK-IN`**
(prepaid) or **`PAY AFTER CHECK-IN`** (pay at the property) — never the old
"Đã thanh toán" / "Thanh toán tại khách sạn". The internal DB enum
(`PAY_BEFORE` / `PAY_AFTER`) is unchanged; the parser meaning is unchanged
(prepayment required → `PAY_BEFORE`, no prepayment → `PAY_AFTER`).

### Branch address on the review form

The first field on the Admin review form is **"Địa chỉ khách sạn"** — a read-only
display of the **selected branch's address** (e.g. `191 Lê Thánh Tôn`), not the raw
Booking.com property name. It updates immediately when the Admin changes the branch
dropdown. The original `hotelName` is kept internally for parser matching and audit,
and the real `branchId` is what is stored/dispatched.

### History & completed list columns

Both the Admin and receptionist history/completed tables show a **Hạng phòng (SL)**
column — a room-type summary aggregated by persisted type from the physical room
records (e.g. `Superior Giường Đôi (2)`, or `Superior Giường Đôi (1) | Deluxe
Giường Đôi (1)` for mixed types) — and a **Giá tổng** column using the booking-level
`totalAmount` (`Chưa xác định` when unknown), via one shared `roomSummary` helper so
both roles see the same result. Tables scroll horizontally on mobile; booking code,
room summary and total are never hidden.

### Breakfast branches (PMS note)

Only three branches include breakfast, keyed by stable branch **code** (never DB id
or array position): `LY_TU_TRONG_260` (260 Lý Tự Trọng), `NGUYEN_TRAI_47A`
(47A Nguyễn Trãi), `NGUYEN_THAI_BINH_170` (170-172-174 Nguyễn Thái Bình). For these,
line 2 of the PMS note begins with `ĂN SÁNG`; no other branch includes it. This
applies to both DIRECT and PARTNER bookings. For a **PARTNER** booking the contact
label (`CÓ ZL` / `CÓ WA` / `NO CONTACT`) is replaced by **`ĐƠN ĐỐI TÁC`**; breakfast,
date, arrival note and requests are preserved, and the phone number never appears in
the note.

The receptionist action is **“Gửi Admin kiểm tra”** — meaning *“I have created this
reservation in the hotel system; here is the screenshot.”* The Admin verdict is
**“Đúng — xác nhận”** or **“Sai — yêu cầu tạo lại”**. Kas never claims to create
the booking itself.

### Admin workflow

Tổng quan (dashboard) → **Nhập đơn** (Booking.com/Agoda tabs: paste → Trích xuất →
sửa → chọn chi nhánh → Gửi) → **Chờ chi nhánh tạo** (monitor) → **Chờ kiểm tra**
(review LEFT/RIGHT proof comparison → Đúng/Sai) → **Cần tạo lại** → **Đã xác nhận
đúng** → **Lịch sử**. Account management lives in the account menu (**Quản lý tài
khoản**).

### Receptionist workflow

**Đơn mới** (master-detail inbox, auto-refresh every 20s, last-minute first) →
open a booking → copy fields / **Sao chép toàn bộ** → create it in the hotel
system → upload the screenshot(s) → **Gửi Admin kiểm tra** → **Chờ Admin kiểm
tra**. If rejected it appears under **Cần tạo lại** with the reason; fix and
resubmit. Approved bookings move to **Đã xác nhận đúng**. Receptionists only ever
see their own branch.

### LAST MINUTE

🔥 **LAST MINUTE / Nhận phòng hôm nay** = check-in date is today in
Asia/Ho_Chi_Minh (backend authoritative). Shown with a red badge, sorted first in
the inbox, and distinguished in the notification dropdown. No sound, no flashing.

### “Sao chép toàn bộ” (COPY ALL) format

Plain text (no Markdown/HTML/JSON), Vietnamese accents and VND separators
preserved, every room and every expected night listed; missing values show
`Chưa xác định`, a hidden phone shows `(Hiển thị số điện thoại)`:

```
CHI NHÁNH: 05 Trương Định
NAME: Nguyễn Văn A
SDT: 0901234567
MÃ BOOKING: 489234523
GIÁ TIỀN TỔNG: 1.700.000 ₫
NGÀY CHECK IN: Chủ Nhật, 19/07/2026
NGÀY CHECK OUT: Thứ Ba, 21/07/2026
GIÁ TIỀN CHO TỪNG ĐÊM CỦA TỪNG PHÒNG:

PHÒNG 1:
HẠNG PHÒNG: Deluxe Double Room
* Đêm 19/07/2026: 850.000 ₫
* Đêm 20/07/2026: 850.000 ₫

TRẠNG THÁI: PAY AFTER
```

Individual fields and whole-room blocks each have their own **Sao chép** button.

### PWA (installable app)

The client is an installable PWA (`vite-plugin-pwa`): app name **Kas Booking
Dispatch** / short name **Kas**, `display: standalone`, theme `#2563eb`. A
**“Cài ứng dụng”** button appears when the browser offers installation, and a
**“Có phiên bản mới”** prompt appears when an update is ready. The service worker
**precaches static assets only** — it has **no runtime API caching** and never
serves `/api` from cache, so operational data is always live. See
[`docs/pwa-install.md`](docs/pwa-install.md).

### LAN deployment (internal network)

The Admin machine runs the central server; receptionist machines open the Admin
machine's LAN IP in Chrome/Edge. All users share the **one** SQLite database on
the server machine — never copy the `.db` file to each machine. See
[`docs/deployment.md`](docs/deployment.md). Windows Firewall may need the port
allowed. **Back up the server's `data.db` regularly.** No Docker required.

> Accounting / finance / PMS integration and real-time SSE are **future
> extensions**, intentionally not built in this milestone.

## Developer test tools (DEVELOPMENT ONLY)

For testing every branch locally there is an optional, **development-only**
toolset — demo-data generation, a `reception_test` branch switcher, and safe
cleanup — gated by `ENABLE_DEV_TEST_TOOLS=true` **and** a non-production `NODE_ENV`.
In production every `/api/dev-test/*` endpoint returns `404` and no dev UI appears,
even if the flag is mistakenly set. Demo rows are tagged `isDemo` + a `demoBatchId`
(a new additive migration; existing rows default to non-demo) so they can never be
confused with real data and are deleted reliably. Admin-only APIs:

```
POST   /api/dev-test/demo/generate   # deterministic demo data for every ACTIVE branch (seeded)
DELETE /api/dev-test/demo            # clear ONLY demo-tagged data (typed-phrase confirm)
POST   /api/dev-test/active-branch   # reception_test only: switch effective branch (session)
```

A separate **official-launch reset** (`npm run data:prepare-production`, CLI-only,
interactive phrase `PREPARE KAS FOR OFFICIAL USE`) backs up the DB + uploads, then
wipes ALL operational data (demo **and** real) while preserving the schema, every
configured branch **and its platform hotel names**, the Admin account and
configuration, and disables `reception_test`. Full
guide: [`docs/testing-8-branches.md`](docs/testing-8-branches.md). **Never enable
`ENABLE_DEV_TEST_TOOLS` in production.**

## Documentation

- [`docs/branch-management.md`](docs/branch-management.md) — Admin hotel & branch management: branch number vs stable code, internal name vs platform aliases, add/rename/re-address, Booking.com & Agoda names, exact vs similarity matching, disabling a branch.
- [`docs/room-class-mapping.md`](docs/room-class-mapping.md) — **branch-specific room classes**: the 48 confirmed CN1–CN8 mappings and PMS codes, alias/normalisation rules, versioned draft → activate workflow, immutable per-booking snapshots, safe guest updates, audit and migration behaviour.
- [`docs/production-deployment.md`](docs/production-deployment.md) — **Ubuntu VPS production deployment**: Docker image, Compose stack, Caddy/HTTPS, secrets, `migrate deploy`, production bootstrap, initial Admin.
- [`docs/production-runbook.md`](docs/production-runbook.md) — day-to-day operation: status, logs, update, rollback, accounts, certificates, routine checks.
- [`docs/backup-restore.md`](docs/backup-restore.md) — backup contents, consistency guarantees, retention, restore drill and real restore.
- [`docs/incident-response.md`](docs/incident-response.md) — triage by symptom, rollback decision tree, disk full, suspected corruption.
- [`docs/testing-8-branches.md`](docs/testing-8-branches.md) — developer branch test env, demo data, safe cleanup, official reset.
- [`docs/deployment.md`](docs/deployment.md) — LAN deployment on Windows + SQLite backup.
- [`docs/pwa-install.md`](docs/pwa-install.md) — installing Kas as a Windows PWA and pinning to the taskbar.
