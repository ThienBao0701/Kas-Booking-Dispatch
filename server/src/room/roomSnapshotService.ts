/**
 * Writing and re-applying booking room-class snapshots (Phase C.3.8).
 *
 * The immutability rule, precisely:
 *
 *   A snapshot that is RESOLVED or MANUAL is NEVER overwritten automatically.
 *   Activating a new mapping version, editing a guest, dispatching, or any
 *   other routine operation leaves it exactly as it was.
 *
 *   A snapshot that is UNRESOLVED or LEGACY may be *completed* automatically —
 *   for example when a DRAFT booking finally gets its branch assigned. That is
 *   filling in a blank, not rewriting history.
 *
 *   Replacing an already-resolved snapshot requires the explicit, audited
 *   "apply latest room mapping" action.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { loadActiveMapping, resolveRoomClass, toSnapshot } from './roomClassResolver';
import type { GuestActor } from '../booking/guestService';

export interface SnapshotOutcome {
  roomsExamined: number;
  roomsResolved: number;
  roomsUnresolved: number;
  roomsSkipped: number;
}

/**
 * Resolves every room of a booking against the booking's OWN branch and stores
 * the snapshot. Skips rooms that already carry a RESOLVED/MANUAL snapshot.
 *
 * Safe to call repeatedly — it is how a booking acquires its codes as soon as
 * its branch is known, and it is a no-op once everything is resolved.
 */
export async function applyRoomClassSnapshots(
  bookingId: string,
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<SnapshotOutcome> {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, branchId: true, rooms: { select: { id: true, roomType: true, roomClassStatus: true } } },
  });
  if (!booking) throw ApiError.notFound('Không tìm thấy đơn đặt phòng.');

  const outcome: SnapshotOutcome = {
    roomsExamined: booking.rooms.length,
    roomsResolved: 0,
    roomsUnresolved: 0,
    roomsSkipped: 0,
  };

  // A booking with no branch cannot have a branch-specific room class, so it
  // simply has no snapshot yet — writing a row of nulls would be noise. It is
  // resolved later, when the Admin assigns the branch (see `sendBooking`).
  if (booking.branchId == null) {
    outcome.roomsSkipped = booking.rooms.length;
    return outcome;
  }

  // Nothing to do when every room is already resolved — avoid loading the
  // mapping at all. This keeps repeated calls (extract → edit → dispatch)
  // essentially free.
  const pending = booking.rooms.filter(
    (r) => r.roomClassStatus !== 'RESOLVED' && r.roomClassStatus !== 'MANUAL',
  );
  if (pending.length === 0) {
    outcome.roomsSkipped = booking.rooms.length;
    return outcome;
  }

  // Loaded once per booking, never per room.
  const mapping = await loadActiveMapping(booking.branchId, client);

  outcome.roomsSkipped = booking.rooms.length - pending.length;

  for (const room of pending) {
    const resolution = resolveRoomClass(
      { branchId: booking.branchId, sourceRoomName: room.roomType },
      mapping,
    );

    // An unresolved room keeps its LEGACY marker rather than being downgraded,
    // so the legacy note path stays in charge of it.
    if (resolution.status === 'UNRESOLVED' && room.roomClassStatus === 'LEGACY') {
      outcome.roomsUnresolved += 1;
      continue;
    }

    await client.bookingRoom.update({
      where: { id: room.id },
      data: toSnapshot(resolution, now),
    });

    if (resolution.status === 'RESOLVED') outcome.roomsResolved += 1;
    else outcome.roomsUnresolved += 1;
  }

  return outcome;
}

export interface ReapplyPreviewRoom {
  roomId: string;
  roomIndex: number;
  sourceText: string | null;
  current: { displayName: string | null; pmsCode: string | null; versionId: string | null };
  latest: { displayName: string | null; pmsCode: string | null; versionId: string | null };
  wouldChange: boolean;
}

/**
 * Shows what "apply latest room mapping" WOULD do, without doing it. The Admin
 * sees the old and the new value for every room before confirming.
 */
export async function previewLatestMapping(
  bookingId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ReapplyPreviewRoom[]> {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: {
      branchId: true,
      rooms: {
        orderBy: { roomIndex: 'asc' },
        select: {
          id: true, roomIndex: true, roomType: true, roomClassSourceText: true,
          roomClassDisplayName: true, roomClassPmsCode: true, roomClassVersionId: true,
        },
      },
    },
  });
  if (!booking) throw ApiError.notFound('Không tìm thấy đơn đặt phòng.');

  const mapping = await loadActiveMapping(booking.branchId, client);

  return booking.rooms.map((room) => {
    const sourceText = room.roomClassSourceText ?? room.roomType;
    const next = resolveRoomClass(
      { branchId: booking.branchId ?? -1, sourceRoomName: sourceText },
      mapping,
    );
    return {
      roomId: room.id,
      roomIndex: room.roomIndex,
      sourceText,
      current: {
        displayName: room.roomClassDisplayName,
        pmsCode: room.roomClassPmsCode,
        versionId: room.roomClassVersionId,
      },
      latest: { displayName: next.displayName, pmsCode: next.pmsCode, versionId: next.versionId },
      wouldChange:
        next.pmsCode !== room.roomClassPmsCode || next.displayName !== room.roomClassDisplayName,
    };
  });
}

/** Booking states whose snapshots are frozen for good. */
const FROZEN_STATUSES = ['COMPLETED', 'ARCHIVED'] as const;

export interface ManualRoomClassResult {
  roomIndex: number;
  roomClassId: string;
  displayName: string;
  pmsCode: string;
  status: 'MANUAL';
}

/**
 * An Admin explicitly chooses the internal room class for ONE room of a booking.
 *
 * This is the write path behind the Admin's "Mã nội bộ" selector. It exists
 * because automatic resolution can only match a name it recognises: a room the
 * branch has no alias for stays UNRESOLVED, and the note then falls back to the
 * legacy keyword abbreviation. Someone has to be able to say what the room
 * actually is — and have that answer persist, because the note the receptionist
 * pastes is generated from this snapshot, not from anything on the Admin's
 * screen.
 *
 * WHAT IT DOES NOT DO: it never guesses, and it never accepts a class from
 * another branch. The chosen id is put through the SAME resolver the automatic
 * path uses, with `explicitRoomClassId` set — that resolver already refuses an
 * id which is not an active class of this branch's ACTIVE mapping version, and
 * already reports such a selection as MANUAL. So the branch/version rule is
 * enforced in exactly one place for both paths, and a stale dropdown (a branch
 * changed in another tab, a mapping version activated meanwhile) is rejected
 * here rather than silently written.
 *
 * Recorded as MANUAL, which `applyRoomClassSnapshots` then refuses to overwrite
 * automatically — the Admin's decision outlives every later routine operation.
 */
export async function setManualRoomClass(
  bookingId: string,
  roomIndex: number,
  roomClassId: string,
  actor: GuestActor,
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ManualRoomClassResult> {
  if (actor.role !== 'ADMIN') {
    throw ApiError.forbidden('Chỉ quản trị viên mới được chọn mã hạng phòng nội bộ.');
  }

  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      branchId: true,
      status: true,
      rooms: {
        where: { roomIndex },
        select: {
          id: true,
          roomIndex: true,
          roomType: true,
          roomClassSourceText: true,
          roomClassDisplayName: true,
          roomClassPmsCode: true,
        },
      },
    },
  });
  if (!booking) throw ApiError.notFound('Không tìm thấy đơn đặt phòng.');

  if ((FROZEN_STATUSES as readonly string[]).includes(booking.status)) {
    throw ApiError.conflict('Đơn đã hoàn thành hoặc lưu trữ — không đổi được mã hạng phòng.', {
      status: booking.status,
    });
  }
  // Without a branch there is no catalogue to validate against, so there is
  // nothing that could legitimately be chosen yet.
  if (booking.branchId == null) {
    throw ApiError.validation('Vui lòng chọn chi nhánh trước khi chọn mã hạng phòng nội bộ.');
  }

  const room = booking.rooms[0];
  if (!room) throw ApiError.notFound('Không tìm thấy hạng phòng trong đơn này.');

  const mapping = await loadActiveMapping(booking.branchId, client);
  const resolution = resolveRoomClass(
    {
      branchId: booking.branchId,
      // Preserved so the snapshot still records what the OTA actually said.
      sourceRoomName: room.roomClassSourceText ?? room.roomType,
      explicitRoomClassId: roomClassId,
    },
    mapping,
  );

  // The resolver answers MANUAL only when the id is an active class of THIS
  // branch's active version. Anything else comes back UNRESOLVED and is refused
  // here rather than written as a blank snapshot.
  if (resolution.status !== 'MANUAL') {
    throw ApiError.validation(
      'Mã hạng phòng không thuộc cấu hình đang áp dụng của chi nhánh này. Vui lòng chọn lại.',
    );
  }

  await client.$transaction(async (tx) => {
    await tx.bookingRoom.update({ where: { id: room.id }, data: toSnapshot(resolution, now) });
    await tx.bookingAuditEvent.create({
      data: {
        bookingId,
        // The EXISTING action, deliberately: it already means "this booking's
        // room mapping was changed by a person", which is exactly what this is.
        // A new enum member would need a database migration to record something
        // the `reason` below already states unambiguously.
        action: 'BOOKING_ROOM_MAPPING_REAPPLIED',
        field: `room ${room.roomIndex}`,
        oldValue: `${room.roomClassDisplayName ?? '—'} / ${room.roomClassPmsCode ?? '—'}`,
        newValue: `${resolution.displayName} / ${resolution.pmsCode}`,
        reason: 'Quản trị viên chọn mã hạng phòng nội bộ (chọn thủ công).',
        actorUserId: actor.id,
        actorRole: actor.role,
      },
    });
  });

  return {
    roomIndex: room.roomIndex,
    roomClassId: resolution.roomClassId!,
    displayName: resolution.displayName!,
    pmsCode: resolution.pmsCode!,
    status: 'MANUAL',
  };
}

/**
 * Explicitly re-resolves a booking against its branch's CURRENT active mapping.
 *
 * Never automatic. Requires an authorised actor, a reason, and a booking that
 * is not completed/archived — a finished booking's note is a historical record
 * and is never recalculated.
 */
export async function applyLatestMapping(
  bookingId: string,
  reason: string,
  actor: GuestActor,
  client: PrismaClient = defaultPrisma,
): Promise<{ outcome: SnapshotOutcome; rooms: ReapplyPreviewRoom[] }> {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, branchId: true, status: true },
  });
  if (!booking) throw ApiError.notFound('Không tìm thấy đơn đặt phòng.');

  if (actor.role !== 'ADMIN') {
    throw ApiError.forbidden('Chỉ quản trị viên mới được áp dụng lại cấu hình hạng phòng.');
  }
  if ((FROZEN_STATUSES as readonly string[]).includes(booking.status)) {
    throw ApiError.conflict('Đơn đã hoàn thành hoặc lưu trữ — không tính lại mã phòng.', {
      status: booking.status,
    });
  }
  if (booking.branchId == null) {
    throw ApiError.validation('Đơn chưa có chi nhánh nên không thể xác định hạng phòng.');
  }
  if (reason.trim().length === 0) {
    throw ApiError.validation('Cần nêu lý do khi áp dụng lại cấu hình hạng phòng.');
  }

  const before = await previewLatestMapping(bookingId, client);
  const mapping = await loadActiveMapping(booking.branchId, client);
  const now = new Date();

  const outcome: SnapshotOutcome = {
    roomsExamined: before.length, roomsResolved: 0, roomsUnresolved: 0, roomsSkipped: 0,
  };

  await client.$transaction(async (tx) => {
    for (const room of before) {
      const resolution = resolveRoomClass(
        { branchId: booking.branchId!, sourceRoomName: room.sourceText },
        mapping,
      );
      // Only a successful resolution replaces an existing snapshot; a failure
      // must never blank out a code the booking already had.
      if (resolution.status !== 'RESOLVED') {
        outcome.roomsUnresolved += 1;
        continue;
      }
      await tx.bookingRoom.update({ where: { id: room.roomId }, data: toSnapshot(resolution, now) });
      outcome.roomsResolved += 1;

      await tx.bookingAuditEvent.create({
        data: {
          bookingId,
          action: 'BOOKING_ROOM_MAPPING_REAPPLIED',
          field: `room ${room.roomIndex}`,
          oldValue: `${room.current.displayName ?? '—'} / ${room.current.pmsCode ?? '—'}`,
          newValue: `${resolution.displayName} / ${resolution.pmsCode}`,
          reason,
          actorUserId: actor.id,
          actorRole: actor.role,
        },
      });
    }
  });

  return { outcome, rooms: await previewLatestMapping(bookingId, client) };
}
