/**
 * Builds a deterministic SQLite database that stands in for the D.0 pilot.
 *
 * WHY A FIXTURE: Phase D.1 develops and tests the transfer tool against a
 * generated database rather than a real pilot file. The real one holds guest
 * names, phone numbers and identity numbers, and a migration tool is exactly
 * the kind of code that should never need production personal data to be
 * proven correct.
 *
 * WHY IT REPLAYS THE ARCHIVED MIGRATIONS: the schema is not re-typed here. It
 * is produced by executing `prisma/legacy-sqlite/migrations/*` in order — the
 * same eleven files the pilot ran — so the fixture's shape cannot drift away
 * from the shape the transfer tool will actually meet, and `_prisma_migrations`
 * is populated so the compatibility gate is exercised for real.
 *
 * The data deliberately includes the awkward cases:
 *   - BOTH SQLite datetime representations in the same column (INTEGER epoch
 *     milliseconds as Prisma writes them, and the TEXT "YYYY-MM-DD HH:MM:SS"
 *     that the C.3.8 backfill's CURRENT_TIMESTAMP wrote);
 *   - every RoomClassResolutionStatus, including LEGACY and UNRESOLVED rows
 *     that D.1 must carry across untouched;
 *   - NULLs in every nullable business column that matters.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Room classes per branch — the C.3.8 production shape (3+8+4+6+6+9+6+6 = 48). */
export const FIXTURE_CLASS_COUNTS = [3, 8, 4, 6, 6, 9, 6, 6] as const;
export const FIXTURE_BRANCH_COUNT = 8;
export const FIXTURE_ALIASES_PER_BRANCH = 3;

export interface FixtureSummary {
  file: string;
  branches: number;
  branchAliases: number;
  users: number;
  mappingVersions: number;
  roomClasses: number;
  roomClassAliases: number;
  bookings: number;
  bookingRooms: number;
  bookingGuests: number;
  bookingNightPrices: number;
  bookingAuditEvents: number;
  branchChangeLogs: number;
  bookingStatusHistory: number;
  notifications: number;
  hotelIssues: number;
}

/** A fixed instant so every generated fixture is byte-identical. */
const BASE_MS = Date.UTC(2026, 5, 1, 3, 0, 0); // 2026-06-01T03:00:00Z

/** Prisma-style storage: epoch milliseconds. */
const ms = (dayOffset: number, hour = 3): number =>
  BASE_MS + dayOffset * 86_400_000 + hour * 3_600_000;

/** Backfill-style storage: SQLite CURRENT_TIMESTAMP text, always UTC. */
const text = (dayOffset: number, hour = 3): string =>
  new Date(ms(dayOffset, hour)).toISOString().replace('T', ' ').slice(0, 19);

function legacyMigrationsDir(repoRoot: string): string {
  return path.join(repoRoot, 'prisma', 'legacy-sqlite', 'migrations');
}

/** The archived SQLite migration names, in application order. */
export function legacyMigrationNames(repoRoot: string): string[] {
  return fs
    .readdirSync(legacyMigrationsDir(repoRoot), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Creates the fixture at `file`, replacing anything already there.
 * Returns the exact counts written, which the tests assert against.
 */
export function buildFixtureSqlite(file: string, repoRoot: string): FixtureSummary {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }

  const db = new DatabaseSync(file);
  try {
    // --- Schema: replay the archived pilot migrations verbatim -------------
    const names = legacyMigrationNames(repoRoot);
    for (const name of names) {
      const sql = fs.readFileSync(
        path.join(legacyMigrationsDir(repoRoot), name, 'migration.sql'),
        'utf8',
      );
      db.exec(sql);
    }

    // Prisma's own ledger, so checkSourceCompatibility sees a real version.
    db.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
    )`);
    const migration = db.prepare(
      'INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (?,?,?,?,?,1)',
    );
    names.forEach((name, index) => {
      migration.run(`fixture-${index}`, `checksum-${index}`, text(index), name, text(index));
    });

    const summary = seedFixtureData(db);
    return { file, ...summary };
  } finally {
    db.close();
  }
}

function seedFixtureData(db: DatabaseSync): Omit<FixtureSummary, 'file'> {
  // --- Branches (ids 1..8, explicit so ID preservation is testable) --------
  const branch = db.prepare(
    'INSERT INTO "Branch" (id, code, hotelName, address, branchNumber, breakfastIncluded, phone, email, contactName, note, active, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (let i = 1; i <= FIXTURE_BRANCH_COUNT; i += 1) {
    branch.run(
      i,
      `BRANCH_${String(i).padStart(2, '0')}`,
      `Khách sạn Chi nhánh ${i}`,
      `${i} Đường Số ${i}, Quận 1`,
      i,
      i % 2 === 0 ? 1 : 0,
      i % 3 === 0 ? null : `028000000${i}`,
      i % 4 === 0 ? null : `cn${i}@example.invalid`,
      i % 5 === 0 ? null : `Quản lý ${i}`,
      null,
      1,
      // Deliberately mixed representations across rows of one column.
      i % 2 === 0 ? ms(i) : text(i),
      i % 2 === 0 ? ms(i) : text(i),
    );
  }

  // --- Branch aliases: exactly 3 per branch = 24 --------------------------
  const alias = db.prepare(
    'INSERT INTO "BranchSourceAlias" (id, branchId, source, alias, normalizedAlias, matchMode, active, priority, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  const aliasSources = ['BOOKING_COM', 'AGODA', 'MANUAL'];
  let aliasId = 1;
  for (let b = 1; b <= FIXTURE_BRANCH_COUNT; b += 1) {
    for (const source of aliasSources) {
      alias.run(
        aliasId,
        b,
        source,
        `Hotel ${b} ${source}`,
        `hotel ${b} ${source.toLowerCase()}`,
        source === 'BOOKING_COM' ? 'SIMILARITY' : 'EXACT',
        1,
        0,
        ms(b),
        ms(b),
      );
      aliasId += 1;
    }
  }

  // --- Users: one Admin + one receptionist per branch ----------------------
  const user = db.prepare(
    'INSERT INTO "User" (id, username, passwordHash, fullName, role, branchId, active, mustChangePassword, lastLoginAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  user.run(1, 'admin', '$2a$04$fixturehashfixturehashfixturehashfix', 'Quản trị viên', 'ADMIN', null, 1, 0, ms(2), ms(0), ms(0));
  for (let b = 1; b <= FIXTURE_BRANCH_COUNT; b += 1) {
    user.run(
      b + 1,
      `letan${b}`,
      '$2a$04$fixturehashfixturehashfixturehashfix',
      `Lễ tân ${b}`,
      'RECEPTIONIST',
      b,
      1,
      0,
      b % 3 === 0 ? null : ms(b, 8),
      ms(1),
      ms(1),
    );
  }

  // --- One ACTIVE mapping version per branch, plus one ARCHIVED on branch 1 -
  const version = db.prepare(
    'INSERT INTO "BranchRoomMappingVersion" (id, branchId, versionNumber, status, createdByUserId, activatedByUserId, createdAt, activatedAt, archivedAt, changeReason) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  for (let b = 1; b <= FIXTURE_BRANCH_COUNT; b += 1) {
    version.run(`ver-${b}`, b, b === 1 ? 2 : 1, 'ACTIVE', 1, 1, ms(3), ms(4), null, 'Cấu hình ban đầu');
  }
  // An archived predecessor proves history survives the transfer intact.
  version.run('ver-1-old', 1, 1, 'ARCHIVED', 1, 1, ms(1), ms(1), ms(3), 'Bản đầu tiên');

  // --- 48 room classes, distributed 3/8/4/6/6/9/6/6 ------------------------
  const roomClass = db.prepare(
    'INSERT INTO "BranchRoomClass" (id, branchId, versionId, stableKey, displayName, normalizedName, pmsCode, active, sortOrder, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  const classAlias = db.prepare(
    'INSERT INTO "BranchRoomClassAlias" (id, roomClassId, versionId, branchId, alias, normalizedAlias, source, active, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  let classCount = 0;
  let classAliasCount = 0;
  for (let b = 1; b <= FIXTURE_BRANCH_COUNT; b += 1) {
    const n = FIXTURE_CLASS_COUNTS[b - 1]!;
    for (let c = 1; c <= n; c += 1) {
      const id = `rc-${b}-${c}`;
      roomClass.run(
        id,
        b,
        `ver-${b}`,
        `class-${c}`,
        `Phòng loại ${c}`,
        `phong loai ${c}`,
        `PMS${b}${c}`,
        1,
        c,
        c % 2 === 0 ? ms(5) : text(5),
        c % 2 === 0 ? ms(5) : text(5),
      );
      classCount += 1;
      classAlias.run(
        `rca-${b}-${c}`,
        id,
        `ver-${b}`,
        b,
        `Loại ${c} CN${b}`,
        `loai ${c} cn${b}`,
        'SEED',
        1,
        ms(5),
        ms(5),
      );
      classAliasCount += 1;
    }
  }
  // The archived version keeps its own classes — historical snapshots must
  // stay explainable, so these are transferred too.
  roomClass.run('rc-1-old', 1, 'ver-1-old', 'class-1', 'Phòng cũ', 'phong cu', 'OLDSTD', 1, 1, ms(1), ms(1));
  classCount += 1;

  // --- Bookings, rooms, guests, prices, audit -----------------------------
  const booking = db.prepare(
    'INSERT INTO "Booking" (id, bookingCode, hotelName, branchId, customerName, phone, sourcePlatform, businessType, businessTypeConfidence, businessTypeDetectionSource, businessTypeManuallyConfirmed, checkInDate, checkInTime, checkOutDate, checkOutTime, totalAmount, currency, paymentStatus, specialRequest, rawText, status, isLastMinute, sentAt, sentByUserId, completedAt, completedByUserId, completionNote, verificationStatus, reviewedByUserId, reviewedAt, parserVersion, createdByUserId, noteGeneratedAt, noteVersion, isDemo, demoBatchId, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const room = db.prepare(
    'INSERT INTO "BookingRoom" (id, bookingId, roomIndex, roomType, roomSubtotal, taxAmount, feeAmount, roomClassId, roomClassVersionId, roomClassBranchId, roomClassDisplayName, roomClassPmsCode, roomClassSourceText, roomClassStatus, roomClassResolvedAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const guest = db.prepare(
    'INSERT INTO "BookingGuest" (id, bookingId, fullName, phone, email, nationality, identityNumber, identityType, note, isPrimary, sortOrder, createdByUserId, updatedByUserId, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const night = db.prepare(
    'INSERT INTO "BookingNightPrice" (id, bookingRoomId, stayDate, amount, currency, manuallyCorrected, isEstimated, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  const auditEvent = db.prepare(
    'INSERT INTO "BookingAuditEvent" (id, bookingId, action, field, oldValue, newValue, reason, actorUserId, actorRole, correlationId, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  const statusHistory = db.prepare(
    'INSERT INTO "BookingStatusHistory" (id, bookingId, oldStatus, newStatus, changedByUserId, changedAt, note) VALUES (?,?,?,?,?,?,?)',
  );

  // Every resolution status is represented, so §10's "legacy stays legacy"
  // has something real to assert against on the PostgreSQL side.
  const statuses = ['RESOLVED', 'LEGACY', 'UNRESOLVED', 'MANUAL'];
  const bookingStatuses = ['NEW', 'COMPLETED', 'READY', 'DRAFT'];
  let rooms = 0;
  let guests = 0;
  let nights = 0;
  let audits = 0;
  let history = 0;
  const bookingCount = 12;

  for (let i = 1; i <= bookingCount; i += 1) {
    const b = ((i - 1) % FIXTURE_BRANCH_COUNT) + 1;
    const status = bookingStatuses[(i - 1) % bookingStatuses.length]!;
    booking.run(
      `bk-${i}`,
      `BC${String(100000 + i)}`,
      `Hotel ${b} BOOKING_COM`,
      b,
      `Khách Hàng ${i}`,
      i % 4 === 0 ? null : `09000000${String(i).padStart(2, '0')}`,
      i % 3 === 0 ? 'AGODA' : 'BOOKING_COM',
      i % 5 === 0 ? 'PARTNER' : 'DIRECT',
      i % 5 === 0 ? 80 : null,
      i % 5 === 0 ? 'auto:partner-rate' : null,
      0,
      ms(10 + i),
      '14:00',
      ms(12 + i),
      '12:00',
      i % 6 === 0 ? null : 1_000_000 + i * 50_000,
      'VND',
      i % 2 === 0 ? 'PAY_BEFORE' : 'PAY_AFTER',
      i % 7 === 0 ? 'Phòng tầng cao' : null,
      `Raw booking text ${i}`,
      status,
      i % 8 === 0 ? 1 : 0,
      status === 'DRAFT' ? null : ms(9 + i),
      status === 'DRAFT' ? null : 1,
      status === 'COMPLETED' ? ms(11 + i) : null,
      status === 'COMPLETED' ? b + 1 : null,
      null,
      status === 'COMPLETED' ? 'APPROVED' : 'NOT_SUBMITTED',
      status === 'COMPLETED' ? 1 : null,
      status === 'COMPLETED' ? ms(12 + i) : null,
      'parser-v3',
      1,
      status === 'DRAFT' ? null : ms(9 + i),
      status === 'DRAFT' ? null : 'note-v2',
      0,
      null,
      i % 2 === 0 ? ms(8 + i) : text(8 + i),
      i % 2 === 0 ? ms(8 + i) : text(8 + i),
    );

    // Primary guest mirrors Booking.customerName/phone, as C.3.8 guarantees.
    guest.run(
      `gs-${i}-1`,
      `bk-${i}`,
      `Khách Hàng ${i}`,
      i % 4 === 0 ? null : `09000000${String(i).padStart(2, '0')}`,
      null,
      i % 3 === 0 ? 'VN' : null,
      null,
      null,
      null,
      1,
      0,
      1,
      null,
      text(8 + i),
      text(8 + i),
    );
    guests += 1;
    if (i % 3 === 0) {
      guest.run(`gs-${i}-2`, `bk-${i}`, `Khách phụ ${i}`, null, null, null, null, null, null, 0, 1, 1, 1, ms(9 + i), ms(9 + i));
      guests += 1;
    }

    const roomCount = (i % 2) + 1;
    for (let r = 1; r <= roomCount; r += 1) {
      const roomId = `rm-${i}-${r}`;
      const resolution = statuses[(i + r) % statuses.length]!;
      const resolved = resolution === 'RESOLVED' || resolution === 'MANUAL';
      room.run(
        roomId,
        `bk-${i}`,
        r,
        `Room type ${r}`,
        500_000 * r,
        i % 3 === 0 ? 50_000 : null,
        null,
        resolved ? `rc-${b}-1` : null,
        resolved ? `ver-${b}` : null,
        b,
        resolved ? 'Phòng loại 1' : null,
        resolved ? `PMS${b}1` : null,
        `Room type ${r}`,
        resolution,
        resolved ? ms(9 + i) : null,
        ms(8 + i),
        ms(8 + i),
      );
      rooms += 1;

      for (let n = 0; n < 2; n += 1) {
        night.run(
          `np-${i}-${r}-${n}`,
          roomId,
          ms(10 + i + n, 0),
          i % 6 === 0 ? null : 400_000 + n * 10_000,
          'VND',
          0,
          0,
          ms(8 + i),
          ms(8 + i),
        );
        nights += 1;
      }
    }

    auditEvent.run(
      `ae-${i}`,
      `bk-${i}`,
      'BOOKING_GUEST_ADDED',
      'fullName',
      null,
      `Khách Hàng ${i}`,
      null,
      1,
      'ADMIN',
      `corr-${i}`,
      text(8 + i),
    );
    audits += 1;

    statusHistory.run(`sh-${i}`, `bk-${i}`, null, status, 1, ms(8 + i), null);
    history += 1;
  }

  // --- Branch audit trail --------------------------------------------------
  const changeLog = db.prepare(
    'INSERT INTO "BranchChangeLog" (id, branchId, action, field, oldValue, newValue, changedByUserId, changedAt) VALUES (?,?,?,?,?,?,?,?)',
  );
  let logs = 0;
  for (let b = 1; b <= FIXTURE_BRANCH_COUNT; b += 1) {
    changeLog.run(`bcl-${b}`, b, 'BRANCH_CREATED', null, null, `BRANCH_${String(b).padStart(2, '0')}`, 1, text(b));
    logs += 1;
    changeLog.run(`bcl-rm-${b}`, b, 'ROOM_MAPPING_ACTIVATED', 'versionNumber', '0', '1', 1, ms(4));
    logs += 1;
  }

  // --- Notifications + issues ---------------------------------------------
  const notification = db.prepare(
    'INSERT INTO "Notification" (id, userId, bookingId, title, body, read, createdAt, readAt, isDemo, demoBatchId) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  let notifications = 0;
  for (let i = 1; i <= 6; i += 1) {
    notification.run(`nt-${i}`, ((i - 1) % 8) + 2, `bk-${i}`, 'Đơn mới', `Đơn bk-${i}`, i % 2, ms(9 + i), i % 2 ? ms(10 + i) : null, 0, null);
    notifications += 1;
  }

  const issue = db.prepare(
    'INSERT INTO "HotelIssue" (id, branchId, roomNumber, category, description, photoStoredName, photoMimeType, status, reportedByUserId, acceptedByUserId, resolvedByUserId, resolvedAt, isDemo, demoBatchId, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  let issues = 0;
  for (let i = 1; i <= 4; i += 1) {
    issue.run(
      `is-${i}`,
      i,
      `${i}0${i}`,
      ['DOOR', 'AIR_CONDITIONER', 'WIFI', 'OTHER'][i - 1]!,
      `Sự cố ${i}`,
      null,
      null,
      i === 4 ? 'RESOLVED' : 'NEW',
      i + 1,
      i === 4 ? 1 : null,
      i === 4 ? 1 : null,
      i === 4 ? ms(15) : null,
      0,
      null,
      ms(13),
      ms(13),
    );
    issues += 1;
  }

  return {
    branches: FIXTURE_BRANCH_COUNT,
    branchAliases: FIXTURE_BRANCH_COUNT * FIXTURE_ALIASES_PER_BRANCH,
    users: FIXTURE_BRANCH_COUNT + 1,
    mappingVersions: FIXTURE_BRANCH_COUNT + 1,
    roomClasses: classCount,
    roomClassAliases: classAliasCount,
    bookings: bookingCount,
    bookingRooms: rooms,
    bookingGuests: guests,
    bookingNightPrices: nights,
    bookingAuditEvents: audits,
    branchChangeLogs: logs,
    bookingStatusHistory: history,
    notifications,
    hotelIssues: issues,
  };
}
