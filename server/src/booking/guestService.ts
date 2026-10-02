/**
 * Booking guest management (Phase C.3.8).
 *
 * PATCH semantics throughout. The contract this module guarantees:
 *
 *   Updating one guest field changes THAT FIELD AND NOTHING ELSE.
 *
 * A request that sets only a phone number must not clear the name, passport or
 * nationality; must not touch the other guests; and must never alter the
 * booking's branch, room class, room-code snapshot, payments, attachments,
 * status, note or dates. Absent keys mean "leave alone" — only a key that is
 * explicitly present is written, so `{ phone: null }` clears the phone while
 * omitting `phone` preserves it.
 *
 * `Booking.customerName` / `Booking.phone` remain the denormalised mirror of
 * the PRIMARY guest (every pre-existing read path still uses them), so the two
 * are kept in step inside the same transaction — never by a background job.
 */
import type { BookingAuditAction, Prisma, PrismaClient, UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';

const optionalText = (max: number) => z.string().trim().max(max).nullish();

export const createGuestSchema = z.object({
  fullName: z.string().trim().min(1, 'Tên khách không được để trống.').max(200),
  phone: optionalText(50),
  email: z.string().trim().email('Email không hợp lệ.').max(200).nullish(),
  nationality: optionalText(100),
  identityNumber: optionalText(100),
  identityType: optionalText(50),
  note: optionalText(1000),
  /** Making the new guest primary demotes the current one, atomically. */
  isPrimary: z.boolean().optional(),
});

/**
 * Every field optional — but `.strict()` still rejects unknown keys, so a typo
 * such as `phoneNumber` fails loudly instead of silently doing nothing.
 * `fullName` may be supplied but never emptied: a guest must keep a name.
 */
export const updateGuestSchema = z
  .object({
    fullName: z.string().trim().min(1, 'Tên khách không được để trống.').max(200).optional(),
    phone: optionalText(50),
    email: z.string().trim().email('Email không hợp lệ.').max(200).nullish(),
    nationality: optionalText(100),
    identityNumber: optionalText(100),
    identityType: optionalText(50),
    note: optionalText(1000),
    /** Optimistic concurrency: the updatedAt the client last saw. */
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .strict()
  .refine(
    (v) => Object.keys(v).filter((k) => k !== 'expectedUpdatedAt').length > 0,
    { message: 'Cần ít nhất một trường để cập nhật.' },
  );

export type CreateGuestInput = z.infer<typeof createGuestSchema>;
export type UpdateGuestInput = z.infer<typeof updateGuestSchema>;

export interface GuestView {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  nationality: string | null;
  identityNumber: string | null;
  identityType: string | null;
  note: string | null;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GuestActor {
  id: number;
  role: UserRole;
  branchId: number | null;
}

function serializeGuest(g: {
  id: string; fullName: string; phone: string | null; email: string | null;
  nationality: string | null; identityNumber: string | null; identityType: string | null;
  note: string | null; isPrimary: boolean; sortOrder: number; createdAt: Date; updatedAt: Date;
}): GuestView {
  return {
    id: g.id, fullName: g.fullName, phone: g.phone, email: g.email,
    nationality: g.nationality, identityNumber: g.identityNumber, identityType: g.identityType,
    note: g.note, isPrimary: g.isPrimary, sortOrder: g.sortOrder,
    createdAt: g.createdAt, updatedAt: g.updatedAt,
  };
}

async function recordAudit(
  tx: Prisma.TransactionClient,
  bookingId: string,
  action: BookingAuditAction,
  actor: GuestActor,
  field?: string | null,
  oldValue?: string | null,
  newValue?: string | null,
  reason?: string | null,
): Promise<void> {
  await tx.bookingAuditEvent.create({
    data: {
      bookingId,
      action,
      field: field ?? null,
      oldValue: oldValue ?? null,
      newValue: newValue ?? null,
      reason: reason ?? null,
      actorUserId: actor.id,
      actorRole: actor.role,
    },
  });
}

/**
 * Loads the booking and enforces branch isolation.
 *
 * A receptionist may only touch guests on a booking of their OWN branch, and
 * only once it has been dispatched to them. Admins may reach any booking.
 * This is the backend gate — hiding a button in the UI is not a control.
 */
async function authorizeBooking(
  client: PrismaClient,
  bookingId: string,
  actor: GuestActor,
): Promise<{ id: string; branchId: number | null; status: string; customerName: string; phone: string | null }> {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, branchId: true, status: true, customerName: true, phone: true },
  });
  if (!booking) throw ApiError.notFound('Không tìm thấy đơn đặt phòng.');

  if (actor.role !== 'ADMIN') {
    if (booking.branchId == null || booking.branchId !== actor.branchId) {
      throw ApiError.branchAccessDenied();
    }
    if (booking.status === 'DRAFT' || booking.status === 'READY') {
      // Not yet dispatched: invisible to reception, so not editable either.
      throw ApiError.notFound('Không tìm thấy đơn đặt phòng.');
    }
  }
  return booking;
}

/** The primary guest's name/phone, mirrored onto the booking's scalar columns. */
async function syncPrimaryMirror(tx: Prisma.TransactionClient, bookingId: string): Promise<void> {
  const primary = await tx.bookingGuest.findFirst({
    where: { bookingId, isPrimary: true },
    orderBy: { sortOrder: 'asc' },
  });
  if (!primary) return;
  await tx.booking.update({
    where: { id: bookingId },
    data: { customerName: primary.fullName, phone: primary.phone },
  });
}

export async function listGuests(
  bookingId: string,
  actor: GuestActor,
  client: PrismaClient = defaultPrisma,
): Promise<GuestView[]> {
  await authorizeBooking(client, bookingId, actor);
  const guests = await client.bookingGuest.findMany({
    where: { bookingId },
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return guests.map(serializeGuest);
}

/**
 * Adds a guest. Existing guests are never touched, and no booking field other
 * than the primary-guest mirror (only when this guest becomes primary) changes.
 */
export async function addGuest(
  bookingId: string,
  input: CreateGuestInput,
  actor: GuestActor,
  client: PrismaClient = defaultPrisma,
): Promise<GuestView[]> {
  await authorizeBooking(client, bookingId, actor);

  await client.$transaction(async (tx) => {
    const count = await tx.bookingGuest.count({ where: { bookingId } });
    // The first guest on a booking is necessarily the primary one.
    const makePrimary = input.isPrimary === true || count === 0;

    if (makePrimary) {
      await tx.bookingGuest.updateMany({ where: { bookingId, isPrimary: true }, data: { isPrimary: false } });
    }

    const created = await tx.bookingGuest.create({
      data: {
        bookingId,
        fullName: input.fullName,
        phone: input.phone ?? null,
        email: input.email ?? null,
        nationality: input.nationality ?? null,
        identityNumber: input.identityNumber ?? null,
        identityType: input.identityType ?? null,
        note: input.note ?? null,
        isPrimary: makePrimary,
        sortOrder: count,
        createdByUserId: actor.id,
        updatedByUserId: actor.id,
      },
    });

    await recordAudit(tx, bookingId, 'BOOKING_GUEST_ADDED', actor, 'fullName', null, created.fullName);
    if (makePrimary) {
      await recordAudit(tx, bookingId, 'BOOKING_PRIMARY_GUEST_CHANGED', actor, 'primaryGuest', null, created.fullName);
      await syncPrimaryMirror(tx, bookingId);
    }
  });

  return listGuests(bookingId, actor, client);
}

/**
 * Partially updates one guest.
 *
 * Only keys physically present in the payload are written. Nothing about the
 * booking itself — branch, room class, room code snapshot, dates, payment,
 * status, note, attachments — is read or modified here.
 */
export async function updateGuest(
  bookingId: string,
  guestId: string,
  input: UpdateGuestInput,
  actor: GuestActor,
  client: PrismaClient = defaultPrisma,
): Promise<GuestView[]> {
  await authorizeBooking(client, bookingId, actor);

  const existing = await client.bookingGuest.findUnique({ where: { id: guestId } });
  if (!existing || existing.bookingId !== bookingId) {
    throw ApiError.notFound('Không tìm thấy khách trong đơn này.');
  }

  // Optimistic concurrency, first pass: fail fast on an obviously stale read so
  // the caller gets a clear conflict without doing any work.
  //
  // This check ALONE is not sufficient. It reads outside the transaction, so
  // two receptionists who both read the same version would both pass it and
  // both write — a time-of-check/time-of-use race. Under SQLite's single
  // writer that was almost unobservable; on PostgreSQL, with eight branches
  // writing concurrently, it is real. The authoritative check is the
  // conditional updateMany inside the transaction below.
  if (input.expectedUpdatedAt) {
    const seen = new Date(input.expectedUpdatedAt).getTime();
    if (seen !== existing.updatedAt.getTime()) {
      throw ApiError.conflict('Thông tin khách vừa được người khác cập nhật. Hãy tải lại rồi thử lại.', {
        currentUpdatedAt: existing.updatedAt.toISOString(),
      });
    }
  }

  const has = (key: keyof UpdateGuestInput): boolean =>
    Object.prototype.hasOwnProperty.call(input, key);

  // `UpdateManyMutationInput` (not `UpdateInput`): the write below is a
  // conditional updateMany so the stale-read guard runs inside the database.
  const data: Prisma.BookingGuestUpdateManyMutationInput = { updatedByUserId: actor.id };
  const changed: string[] = [];

  // Each field is written ONLY when the caller sent that exact key.
  for (const field of ['fullName', 'phone', 'email', 'nationality', 'identityNumber', 'identityType', 'note'] as const) {
    if (!has(field)) continue;
    const next = field === 'fullName' ? input.fullName! : (input[field] ?? null);
    (data as Record<string, unknown>)[field] = next;
    if (String(existing[field] ?? '') !== String(next ?? '')) {
      changed.push(`${field}: ${existing[field] ?? '—'} → ${next ?? '—'}`);
    }
  }

  await client.$transaction(async (tx) => {
    // Optimistic concurrency, authoritative pass: the row is updated ONLY if
    // its `updatedAt` is still the value the caller saw. PostgreSQL evaluates
    // this predicate while holding the row lock, so of two concurrent writers
    // exactly one matches and the loser gets a conflict instead of silently
    // overwriting a change it never saw. `updatedAt` is maintained by Prisma's
    // @updatedAt, so it advances on every write and needs no extra column.
    const written = await tx.bookingGuest.updateMany({
      where: {
        id: guestId,
        ...(input.expectedUpdatedAt ? { updatedAt: existing.updatedAt } : {}),
      },
      data,
    });
    if (written.count === 0) {
      throw ApiError.conflict('Thông tin khách vừa được người khác cập nhật. Hãy tải lại rồi thử lại.', {
        currentUpdatedAt: existing.updatedAt.toISOString(),
      });
    }

    if (changed.length > 0) {
      await recordAudit(tx, bookingId, 'BOOKING_GUEST_UPDATED', actor, existing.fullName, null, changed.join('; '));
    }
    // Only the primary guest's name/phone are mirrored onto the booking.
    if (existing.isPrimary && (has('fullName') || has('phone'))) {
      await syncPrimaryMirror(tx, bookingId);
    }
  });

  return listGuests(bookingId, actor, client);
}

/** Promotes a guest to primary; the previous primary keeps all of its data. */
export async function setPrimaryGuest(
  bookingId: string,
  guestId: string,
  actor: GuestActor,
  client: PrismaClient = defaultPrisma,
): Promise<GuestView[]> {
  await authorizeBooking(client, bookingId, actor);

  const target = await client.bookingGuest.findUnique({ where: { id: guestId } });
  if (!target || target.bookingId !== bookingId) {
    throw ApiError.notFound('Không tìm thấy khách trong đơn này.');
  }
  if (target.isPrimary) return listGuests(bookingId, actor, client);

  await client.$transaction(async (tx) => {
    const previous = await tx.bookingGuest.findFirst({ where: { bookingId, isPrimary: true } });
    await tx.bookingGuest.updateMany({ where: { bookingId, isPrimary: true }, data: { isPrimary: false } });
    await tx.bookingGuest.update({ where: { id: guestId }, data: { isPrimary: true, updatedByUserId: actor.id } });
    await recordAudit(
      tx, bookingId, 'BOOKING_PRIMARY_GUEST_CHANGED', actor, 'primaryGuest',
      previous?.fullName ?? null, target.fullName,
    );
    await syncPrimaryMirror(tx, bookingId);
  });

  return listGuests(bookingId, actor, client);
}

/**
 * Removes a guest. The primary guest cannot be removed while others exist —
 * promote someone else first, so a booking never loses its contact.
 */
export async function removeGuest(
  bookingId: string,
  guestId: string,
  actor: GuestActor,
  client: PrismaClient = defaultPrisma,
): Promise<GuestView[]> {
  await authorizeBooking(client, bookingId, actor);

  const target = await client.bookingGuest.findUnique({ where: { id: guestId } });
  if (!target || target.bookingId !== bookingId) {
    throw ApiError.notFound('Không tìm thấy khách trong đơn này.');
  }
  const total = await client.bookingGuest.count({ where: { bookingId } });
  if (target.isPrimary && total > 1) {
    throw ApiError.validation('Hãy chọn khách chính khác trước khi xoá khách chính hiện tại.');
  }

  await client.$transaction(async (tx) => {
    await tx.bookingGuest.delete({ where: { id: guestId } });
    await recordAudit(tx, bookingId, 'BOOKING_GUEST_REMOVED', actor, 'fullName', target.fullName, null);
  });

  return listGuests(bookingId, actor, client);
}

/** Booking-scoped audit trail, newest first. */
export async function listBookingAudit(
  bookingId: string,
  actor: GuestActor,
  client: PrismaClient = defaultPrisma,
) {
  await authorizeBooking(client, bookingId, actor);
  const rows = await client.bookingAuditEvent.findMany({
    where: { bookingId },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { actor: { select: { id: true, fullName: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    field: r.field,
    oldValue: r.oldValue,
    newValue: r.newValue,
    reason: r.reason,
    actor: r.actor ? { id: r.actor.id, fullName: r.actor.fullName } : null,
    actorRole: r.actorRole,
    createdAt: r.createdAt,
  }));
}
