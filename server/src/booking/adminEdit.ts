import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { generateStayDates } from './dates';
import { loadBookingDetail } from './bookingRepo';
import { snapshotRoomClasses } from './store';
import type { BookingDetail } from './bookingView';

/**
 * Admin editing of a DRAFT/READY booking. Nested rooms and nightly rows are
 * replaced atomically; the engine's invariants are enforced (unique room index,
 * unique stay date per room, no check-out night, every expected night present)
 * and prices are never invented, divided or copied between rooms. Editing a
 * READY booking sends it back to DRAFT for revalidation.
 */

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải có định dạng YYYY-MM-DD.');

const nightSchema = z
  .object({
    stayDate: isoDateSchema,
    amount: z.number().int().nonnegative().nullable(),
    currency: z.string().trim().min(1).max(8).optional(),
    manuallyCorrected: z.boolean().optional(),
  })
  .strict();

const roomSchema = z
  .object({
    roomIndex: z.number().int().positive(),
    roomType: z.string().trim().max(200).nullable().optional(),
    roomSubtotal: z.number().int().nonnegative().nullable().optional(),
    taxAmount: z.number().int().nonnegative().nullable().optional(),
    feeAmount: z.number().int().nonnegative().nullable().optional(),
    nights: z.array(nightSchema),
  })
  .strict();

// `.strict()` rejects any forbidden field (id, status, rawText, parserVersion,
// createdBy/sentBy/completedBy, sentAt/completedAt) instead of silently ignoring it.
export const updateBookingSchema = z
  .object({
    hotelName: z.string().trim().max(300).nullable().optional(),
    branchId: z.number().int().positive().nullable().optional(),
    customerName: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    bookingCode: z.string().trim().max(100).optional(),
    checkInDate: isoDateSchema.nullable().optional(),
    checkOutDate: isoDateSchema.nullable().optional(),
    checkInTime: z.string().trim().max(50).nullable().optional(),
    checkOutTime: z.string().trim().max(50).nullable().optional(),
    totalAmount: z.number().int().nonnegative().nullable().optional(),
    currency: z.string().trim().min(1).max(8).optional(),
    paymentStatus: z.enum(['PAY_BEFORE', 'PAY_AFTER']).optional(),
    specialRequest: z.string().trim().max(2000).nullable().optional(),
    rooms: z.array(roomSchema).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật.' });

export type UpdateBookingInput = z.infer<typeof updateBookingSchema>;

function toUtcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function has<K extends string>(obj: Record<string, unknown>, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export async function updateBookingDraft(
  bookingId: string,
  input: UpdateBookingInput,
  adminUserId: number,
): Promise<BookingDetail> {
  const booking = await loadBookingDetail(bookingId);
  if (booking.status !== 'DRAFT' && booking.status !== 'READY') {
    throw ApiError.conflict('Chỉ có thể sửa đơn ở trạng thái nháp hoặc sẵn sàng.', {
      status: booking.status,
    });
  }

  if (has(input, 'branchId') && input.branchId != null) {
    const branch = await prisma.branch.findUnique({ where: { id: input.branchId } });
    if (!branch || !branch.active) {
      throw ApiError.validation('Chi nhánh không hợp lệ hoặc đã ngừng hoạt động.');
    }
  }

  const newCheckIn = has(input, 'checkInDate')
    ? (input.checkInDate ? toUtcDate(input.checkInDate) : null)
    : booking.checkInDate;
  const newCheckOut = has(input, 'checkOutDate')
    ? (input.checkOutDate ? toUtcDate(input.checkOutDate) : null)
    : booking.checkOutDate;
  const newCurrency = input.currency ?? booking.currency;

  // Validate the nested room/night structure the admin submitted.
  if (input.rooms) {
    validateRoomStructure(input.rooms, newCheckIn, newCheckOut);
  }

  // Prior nightly amounts, to decide manuallyCorrected without inventing intent.
  const priorNight = new Map<string, { amount: number | null; manuallyCorrected: boolean }>();
  for (const room of booking.rooms) {
    for (const night of room.nights) {
      priorNight.set(`${room.roomIndex}|${night.stayDate.toISOString().slice(0, 10)}`, {
        amount: night.amount,
        manuallyCorrected: night.manuallyCorrected,
      });
    }
  }

  const scalar: Prisma.BookingUpdateInput = {};
  if (has(input, 'hotelName')) scalar.hotelName = input.hotelName ?? null;
  if (has(input, 'customerName')) scalar.customerName = input.customerName ?? '';
  if (has(input, 'phone')) scalar.phone = input.phone ?? null;
  if (has(input, 'bookingCode')) scalar.bookingCode = input.bookingCode ?? '';
  if (has(input, 'checkInDate')) scalar.checkInDate = newCheckIn;
  if (has(input, 'checkOutDate')) scalar.checkOutDate = newCheckOut;
  if (has(input, 'checkInTime')) scalar.checkInTime = input.checkInTime ?? null;
  if (has(input, 'checkOutTime')) scalar.checkOutTime = input.checkOutTime ?? null;
  if (has(input, 'totalAmount')) scalar.totalAmount = input.totalAmount ?? null;
  if (has(input, 'currency')) scalar.currency = newCurrency;
  if (has(input, 'paymentStatus') && input.paymentStatus) scalar.paymentStatus = input.paymentStatus;
  if (has(input, 'specialRequest')) scalar.specialRequest = input.specialRequest ?? null;
  if (has(input, 'branchId')) {
    scalar.branch = input.branchId == null
      ? { disconnect: true }
      : { connect: { id: input.branchId } };
  }

  const revertToDraft = booking.status === 'READY';

  await prisma.$transaction(async (tx) => {
    await tx.booking.update({ where: { id: bookingId }, data: scalar });

    if (input.rooms) {
      // Replace the nested rows atomically (allowed only before dispatch).
      await tx.bookingRoom.deleteMany({ where: { bookingId } });
      for (const room of input.rooms) {
        await tx.bookingRoom.create({
          data: {
            bookingId,
            roomIndex: room.roomIndex,
            roomType: room.roomType ?? null,
            roomSubtotal: room.roomSubtotal ?? null,
            taxAmount: room.taxAmount ?? null,
            feeAmount: room.feeAmount ?? null,
            nights: {
              create: room.nights.map((night) => ({
                stayDate: toUtcDate(night.stayDate),
                amount: night.amount,
                currency: night.currency ?? newCurrency,
                manuallyCorrected: resolveManuallyCorrected(priorNight, room.roomIndex, night),
              })),
            },
          },
        });
      }
    }

    if (revertToDraft) {
      await tx.booking.update({ where: { id: bookingId }, data: { status: 'DRAFT' } });
      await tx.bookingStatusHistory.create({
        data: {
          bookingId,
          oldStatus: 'READY',
          newStatus: 'DRAFT',
          changedByUserId: adminUserId,
          note: 'Tự động trở về nháp do đơn được chỉnh sửa và cần xác thực lại.',
        },
      });
    }
  });

  // Rooms may have been replaced or the branch reassigned, so re-derive the
  // snapshots. Already-resolved rooms are skipped by the snapshot service, and
  // this only ever runs for a DRAFT/READY booking (guarded above) — a
  // dispatched booking's codes are never recalculated by an edit.
  await snapshotRoomClasses(bookingId);

  return loadBookingDetail(bookingId);
}

function resolveManuallyCorrected(
  prior: Map<string, { amount: number | null; manuallyCorrected: boolean }>,
  roomIndex: number,
  night: { stayDate: string; amount: number | null; manuallyCorrected?: boolean },
): boolean {
  if (night.manuallyCorrected !== undefined) return night.manuallyCorrected;
  const before = prior.get(`${roomIndex}|${night.stayDate}`);
  // Unchanged amount keeps its prior flag; a changed/new amount is a manual edit.
  if (before && before.amount === night.amount) return before.manuallyCorrected;
  return true;
}

function validateRoomStructure(
  rooms: UpdateBookingInput['rooms'] & object,
  checkIn: Date | null,
  checkOut: Date | null,
): void {
  const indices = new Set<number>();
  for (const room of rooms) {
    if (indices.has(room.roomIndex)) {
      throw ApiError.validation('Số thứ tự phòng bị trùng.', { roomIndex: room.roomIndex });
    }
    indices.add(room.roomIndex);

    const dates = room.nights.map((n) => n.stayDate);
    if (new Set(dates).size !== dates.length) {
      throw ApiError.validation('Một phòng có ngày lưu trú bị trùng.', { roomIndex: room.roomIndex });
    }
  }

  const ci = checkIn ? checkIn.toISOString().slice(0, 10) : null;
  const co = checkOut ? checkOut.toISOString().slice(0, 10) : null;
  if (ci === null || co === null || co <= ci) {
    // Without a valid range the expected-night set is undefined; scalar/date
    // validation elsewhere flags the bad range. Uniqueness is already checked.
    return;
  }

  const expected = generateStayDates(ci, co);
  const expectedSet = new Set(expected);
  for (const room of rooms) {
    const dateSet = new Set(room.nights.map((n) => n.stayDate));
    if (dateSet.has(co)) {
      throw ApiError.validation('Ngày trả phòng không được là một đêm lưu trú.', {
        roomIndex: room.roomIndex,
      });
    }
    const outside = [...dateSet].filter((d) => !expectedSet.has(d));
    if (outside.length > 0) {
      throw ApiError.validation('Có đêm lưu trú nằm ngoài khoảng thời gian ở.', {
        roomIndex: room.roomIndex,
        dates: outside,
      });
    }
    const missing = expected.filter((d) => !dateSet.has(d));
    if (missing.length > 0) {
      throw ApiError.validation('Thiếu một số đêm lưu trú theo khoảng thời gian ở.', {
        roomIndex: room.roomIndex,
        dates: missing,
      });
    }
  }
}
