/**
 * Editing the two values an Admin owns after dispatch.
 *
 * Only the PMS creator note and the reviewed payment mode. Everything else on a
 * dispatched booking is either what the platform said (never editable) or what
 * the branch did (theirs to record) — this is the narrow slice a human typed
 * and may have typed wrongly.
 *
 * NOTHING IS OVERWRITTEN SILENTLY. Every change writes an immutable
 * BookingCorrection carrying the old value, the new value, who made it, when,
 * and the request it came from — the same row shape the amendment flow writes,
 * so one history reads uniformly however a change arrived.
 *
 * The update and its correction rows share one transaction: a booking is never
 * left holding a new value with no record of the old one.
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { recordRequestOrigin, type RequestOrigin } from './requestAudit';

/** The fields this endpoint may change, named as the corrections record them. */
export const EDITABLE_FIELDS = ['adminPmsNote', 'reviewedPaymentMode'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface OtaFieldEdit {
  /** Absent means "leave alone"; a value means "set to this". */
  adminPmsNote?: string;
  reviewedPaymentMode?: 'CN' | 'HOTEL_PAYMENT';
}

export interface EditActor {
  id: number;
  origin?: RequestOrigin | null;
}

export interface EditResult {
  bookingId: string;
  /** Which fields actually changed. A no-op edit reports none. */
  changed: EditableField[];
  correctionIds: string[];
}

/**
 * Applies an edit, recording every real change.
 *
 * A field submitted with the value it already holds is NOT a change: writing a
 * correction row for it would fill the history with entries that record nothing
 * and bury the ones that matter.
 */
export async function editOtaFields(
  bookingId: string,
  edit: OtaFieldEdit,
  actor: EditActor,
  client: PrismaClient = defaultPrisma,
  clock: Clock = getClock(),
): Promise<EditResult> {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, adminPmsNote: true, reviewedPaymentMode: true, sentAt: true },
  });
  if (!booking) throw ApiError.notFound('Không tìm thấy đơn đặt phòng.');

  const now = clock.now();
  const changes: { field: EditableField; oldValue: string | null; newValue: string }[] = [];

  if (edit.adminPmsNote !== undefined) {
    const next = edit.adminPmsNote.trim();
    if (next !== (booking.adminPmsNote ?? '')) {
      changes.push({ field: 'adminPmsNote', oldValue: booking.adminPmsNote, newValue: next });
    }
  }
  if (edit.reviewedPaymentMode !== undefined) {
    if (edit.reviewedPaymentMode !== booking.reviewedPaymentMode) {
      changes.push({
        field: 'reviewedPaymentMode',
        oldValue: booking.reviewedPaymentMode,
        newValue: edit.reviewedPaymentMode,
      });
    }
  }

  if (changes.length === 0) return { bookingId, changed: [], correctionIds: [] };

  const correctionIds = await client.$transaction(async (tx) => {
    const requestAuditId = actor.origin
      ? await recordRequestOrigin(tx as Prisma.TransactionClient, actor.origin, now)
      : null;

    const data: Prisma.BookingUpdateInput = {};
    for (const change of changes) {
      if (change.field === 'adminPmsNote') data.adminPmsNote = change.newValue;
      else data.reviewedPaymentMode = change.newValue;
    }
    await tx.booking.update({ where: { id: bookingId }, data });

    const created = await tx.bookingCorrection.createManyAndReturn({
      select: { id: true },
      data: changes.map((change) => ({
        bookingId,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        correctedByUserId: actor.id,
        correctedAt: now,
        requestAuditId,
      })),
    });
    return created.map((row) => row.id);
  });

  return { bookingId, changed: changes.map((c) => c.field), correctionIds };
}
