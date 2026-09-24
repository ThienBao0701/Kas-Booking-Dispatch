import { prisma } from '../../src/db/prisma';

/**
 * The suite shares the application's own Prisma client rather than opening a
 * second one, so a test's assertions and the code under test always observe
 * the same connection state. vitest.config.ts points DATABASE_URL at the
 * suite's own PostgreSQL schema before any import runs.
 *
 * Unlike the SQLite pilot — where a second client would intermittently hit
 * SQLITE_BUSY because only one writer is allowed — PostgreSQL handles
 * concurrent writers fine. Tests that specifically need TWO simultaneous
 * writers therefore open their own extra clients deliberately; see
 * tests/pg/concurrency.test.ts.
 */
export const testPrisma = prisma;

/**
 * Removes booking data between tests; branches are left in place by default.
 *
 * Deleting Booking cascades to rooms, nights, guests, audit events, warnings,
 * proofs and comparisons via the schema's ON DELETE CASCADE, but the explicit
 * deletes are kept: they document the shape, and they keep the reset working
 * if a cascade is ever relaxed.
 */
export async function resetBookingData(): Promise<void> {
  await testPrisma.notification.deleteMany();
  await testPrisma.bookingStatusHistory.deleteMany();
  await testPrisma.bookingAuditEvent.deleteMany();
  await testPrisma.bookingGuest.deleteMany();
  await testPrisma.bookingNightPrice.deleteMany();
  await testPrisma.bookingRoom.deleteMany();
  // A charge document may reference a Booking, so it goes before Booking. Its
  // children are cascaded, but naming them keeps the reset working if a cascade
  // is ever relaxed — and keeps the shape visible.
  await testPrisma.chargeDocumentAudit.deleteMany();
  await testPrisma.chargeDocumentAttachment.deleteMany();
  await testPrisma.chargeDocument.deleteMany();
  await testPrisma.booking.deleteMany();
}

/**
 * Clears the incident tables, attempts first.
 *
 * Exported because several suites clear incidents BETWEEN tests, not just
 * around them, and the order is not obvious: a repair attempt points at the
 * incident it belongs to, so deleting incidents first relies on a cascade that
 * may be relaxed later. Calling this instead of `hotelIssue.deleteMany()`
 * directly keeps that ordering knowledge in one place.
 */
export async function resetIssueData(): Promise<void> {
  // A reception journal entry can REFERENCE an incident, and that FK is RESTRICT
  // on purpose — the journal entry must not vanish because an incident was
  // removed. So the journal goes first or `hotelIssue.deleteMany()` throws P2003
  // the moment any "Sự cố cơ sở vật chất" report exists.
  await resetReportData();
  await testPrisma.technicalRepairAttempt.deleteMany();
  await testPrisma.hotelIssue.deleteMany();
}

/**
 * Clears the reception operational journal — "Báo cáo vấn đề".
 *
 * The five detail tables CASCADE from their report, and so do the audit rows
 * that belong to one. The audit rows that do NOT belong to one — "Tiền đầu ca",
 * which is a property of the shift rather than of any payment — cascade from
 * nothing, so they are deleted explicitly and FIRST. Missing that leaves rows
 * holding RESTRICT references to User and Branch, and `resetAll` then fails
 * several files later with a P2003 that names neither.
 */
export async function resetReportData(): Promise<void> {
  await testPrisma.receptionReportAudit.deleteMany();
  await testPrisma.receptionPayment.deleteMany();
  await testPrisma.guestRequestReport.deleteMany();
  await testPrisma.facilityIssueReport.deleteMany();
  await testPrisma.customerComplaintReport.deleteMany();
  await testPrisma.roomServiceReport.deleteMany();
  await testPrisma.receptionOperationalReport.deleteMany();
}

/**
 * Clears the shift tables, and does so in the ONLY order that works.
 *
 * ShiftHandover holds REQUIRED references to two ReceptionShiftSession rows —
 * the one that ended and the one that began — so Prisma defaults both to
 * RESTRICT and `receptionShiftSession.deleteMany()` throws P2003 the moment a
 * single handover exists. The notes go first because a note may point at a
 * handover.
 */
export async function resetShiftData(): Promise<void> {
  // Journal entries point at sessions with SET NULL, so they would survive —
  // but they hold RESTRICT references to Branch and User, and every caller that
  // clears shifts is about to clear those too.
  await resetReportData();
  await testPrisma.shiftHandoverNote.deleteMany();
  await testPrisma.shiftHandover.deleteMany();
  await testPrisma.receptionShiftSession.deleteMany();
}

export async function resetAll(): Promise<void> {
  await resetBookingData();
  // ChargeDocument holds RESTRICT FKs to Branch and User (a charge document is
  // financial evidence — deleting a branch must not silently take it with it),
  // so it is cleared before either. resetBookingData already did this; the
  // repeat is harmless and keeps resetAll readable on its own.
  await testPrisma.chargeDocumentAudit.deleteMany();
  await testPrisma.chargeDocumentAttachment.deleteMany();
  await testPrisma.chargeDocument.deleteMany();
  // HotelIssue holds RESTRICT FKs to User/Branch, so it must be cleared first —
  // and its repair attempts before it.
  await resetIssueData();
  // Chat box holds a RESTRICT FK from ChatConversation.createdByUserId and
  // ChatMessage.senderUserId to User — a thread must not vanish because an
  // account was removed. Children first, then the thread.
  //
  // ADDED LATE, AND THAT IS THE POINT: the chat tables shipped while the whole
  // server suite was blocked on its database target, so `user.deleteMany()`
  // began failing here the moment the suite could run again. Any future model
  // holding a RESTRICT reference to User or Branch must be added to this list.
  await testPrisma.chatAttachment.deleteMany();
  await testPrisma.chatMessage.deleteMany();
  await testPrisma.chatConversation.deleteMany();
  // Reminder holds RESTRICT FKs to User for BOTH sender and recipient.
  await testPrisma.reminder.deleteMany();
  // Room-mapping rows reference both Branch and User; clear them before either.
  await testPrisma.branchRoomClassAlias.deleteMany();
  await testPrisma.branchRoomClass.deleteMany();
  await testPrisma.branchRoomMappingVersion.deleteMany();
  await testPrisma.branchChangeLog.deleteMany();
  await testPrisma.branchSourceAlias.deleteMany();
  // ReceptionShiftSession holds RESTRICT FKs to BOTH User and Branch — a shift
  // is an audit record of who was on the desk, so an account being removed must
  // not silently take it with it. Cleared here, before either, together with the
  // handovers and notes that hold RESTRICT references to the sessions
  // themselves. The proofs that point at a session are already gone with their
  // bookings, and that FK is SET NULL anyway.
  await resetShiftData();
  await testPrisma.session.deleteMany();
  await testPrisma.user.deleteMany();
  await testPrisma.branch.deleteMany();
}

/**
 * Resets the sequence-backed identity columns so explicit-id fixtures and
 * auto-generated ids cannot collide between tests.
 *
 * On SQLite this was unnecessary — deleting every row reset the ROWID counter.
 * PostgreSQL sequences do not rewind on DELETE, which is a real behavioural
 * difference the D.1 migration introduced.
 */
export async function resetSequences(): Promise<void> {
  for (const table of ['Branch', 'User', 'BranchSourceAlias']) {
    await testPrisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'),
                     COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`,
    );
  }
}

/** Date-only helper matching how the app stores dates (UTC midnight). */
export function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
