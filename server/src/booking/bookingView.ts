import type { Prisma } from '@prisma/client';

/**
 * One place that defines how a booking is loaded for the operational APIs and
 * how it is projected onto the wire. Keeping the include and the serializers
 * together guarantees the response always has exactly the relations it reads.
 */
export const BOOKING_DETAIL_INCLUDE = {
  branch: true,
  rooms: { include: { nights: true } },
  warnings: true,
  sentBy: true,
  completedBy: true,
  reviewedBy: true,
  createdBy: true,
  proofs: {
    include: { submittedBy: true, reviewedBy: true },
    orderBy: { attemptNumber: 'asc' },
  },
  // Append-only corrections, loaded ONLY for the request provenance attached to
  // each one. The corrections themselves are no longer projected onto the wire
  // — 5.2d removed the edit-history table from every screen — but the requests
  // that produced them remain the Admin's audit trail, and they are reachable
  // only through this relation. The request context reaches ADMINS ONLY; the
  // ops serializer strips it.
  corrections: {
    include: { correctedBy: true, requestAudit: true },
    orderBy: { correctedAt: 'asc' },
  },
  receivedBy: true,
  checkedInBy: true,
  checkedOutBy: true,
  cancelledBy: true,
  claimedBy: true,
} satisfies Prisma.BookingInclude;

export type BookingDetail = Prisma.BookingGetPayload<{ include: typeof BOOKING_DETAIL_INCLUDE }>;

export const BOOKING_LIST_INCLUDE = {
  branch: true,
  sentBy: true,
  completedBy: true,
  reviewedBy: true,
  claimedBy: true,
  rooms: { include: { nights: true } },
  warnings: true,
  // Only the most recent proof attempt, for the list's status/reason display.
  proofs: { orderBy: { attemptNumber: 'desc' }, take: 1 },
} satisfies Prisma.BookingInclude;

export type BookingListItem = Prisma.BookingGetPayload<{ include: typeof BOOKING_LIST_INCLUDE }>;

type ActorUser = { id: number; username: string; fullName: string } | null;

/** Public, non-sensitive view of a user acting on a booking (never the hash). */
function actor(user: ActorUser): { id: number; fullName: string } | null {
  return user ? { id: user.id, fullName: user.fullName } : null;
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function isoDate(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * The branch fields every booking-scoped response carries.
 *
 * `breakfastIncluded` is part of this shape because it is OPERATIONAL data the
 * receptionist's PMS note depends on. It used to be absent, which forced both
 * the client note builder and the server proof-comparison to hardcode a set of
 * branch codes — so an Admin toggling breakfast in branch management changed
 * nothing. The database column is the single source of truth for every branch.
 */
function branchView(branch: BookingDetail['branch']) {
  return branch
    ? {
        id: branch.id,
        code: branch.code,
        hotelName: branch.hotelName,
        address: branch.address,
        branchNumber: branch.branchNumber,
        breakfastIncluded: branch.breakfastIncluded,
      }
    : null;
}

function roomsView(rooms: BookingDetail['rooms']) {
  return [...rooms]
    .sort((a, b) => a.roomIndex - b.roomIndex)
    .map((room) => ({
      id: room.id,
      roomIndex: room.roomIndex,
      roomType: room.roomType,
      roomSubtotal: room.roomSubtotal,
      taxAmount: room.taxAmount,
      feeAmount: room.feeAmount,
      // Immutable branch room-class snapshot (C.3.8). The note builders use
      // `roomClassPmsCode` when present and fall back to the legacy keyword
      // abbreviation only for rooms that predate the mapping or are still
      // unresolved — so a historical note can never change.
      roomClassId: room.roomClassId,
      roomClassVersionId: room.roomClassVersionId,
      roomClassDisplayName: room.roomClassDisplayName,
      roomClassPmsCode: room.roomClassPmsCode,
      roomClassSourceText: room.roomClassSourceText,
      roomClassStatus: room.roomClassStatus,
      nights: [...room.nights]
        .sort((a, b) => a.stayDate.getTime() - b.stayDate.getTime())
        .map((night) => ({
          id: night.id,
          stayDate: isoDate(night.stayDate),
          amount: night.amount,
          currency: night.currency,
          manuallyCorrected: night.manuallyCorrected,
          isEstimated: night.isEstimated,
        })),
    }));
}

function warningsView(warnings: BookingDetail['warnings']) {
  return warnings.map((w) => ({ code: w.code, message: w.message, severity: w.severity }));
}

/** The authenticated image endpoint for a proof — never a filesystem path. */
export function proofImageUrl(bookingId: string, proofId: string): string {
  return `/api/bookings/${bookingId}/proofs/${proofId}/image`;
}

type ProofRow = BookingDetail['proofs'][number];

/** A single proof attempt on the wire (never exposes the stored path). */
export function proofView(bookingId: string, proof: ProofRow) {
  return {
    id: proof.id,
    attemptNumber: proof.attemptNumber,
    status: proof.status,
    originalFileName: proof.originalFileName,
    mimeType: proof.mimeType,
    fileSize: proof.fileSize,
    submissionNote: proof.submissionNote,
    submittedBy: actor(proof.submittedBy),
    submittedAt: proof.submittedAt.toISOString(),
    /**
     * Who created the order, and on which shift — resolved by the server at
     * submission. Null on attempts made before shifts existed, where
     * `submissionNote` is the only (typed, unverified) record of the name.
     */
    receptionistName: proof.receptionistNameSnapshot,
    shiftType: proof.shiftType,
    shiftSessionId: proof.shiftSessionId,
    reviewedBy: actor(proof.reviewedBy),
    reviewedAt: iso(proof.reviewedAt),
    reviewReasonCode: proof.reviewReasonCode,
    reviewNote: proof.reviewNote,
    imageUrl: proofImageUrl(bookingId, proof.id),
  };
}

function proofsView(bookingId: string, proofs: BookingDetail['proofs']) {
  return [...proofs]
    .sort((a, b) => a.attemptNumber - b.attemptNumber)
    .map((p) => proofView(bookingId, p));
}

/**
 * The one thing a screen still reads from what the OTA said.
 *
 * This block used to carry twelve fields — rate plan, cancellation policy,
 * country of residence, website language, property id, build hashes. None of
 * them was ever acted on: a receptionist creates the reservation from the
 * guest, the dates, the rooms and the note, and an Admin who needs the rest
 * reads the original mail. 5.2d removed the card that displayed them, so the
 * server stops sending them.
 *
 * `paymentType` survives because it is still displayed: it is the mail's own
 * payment wording, and it is the fallback in the payment field for OTA bookings
 * dispatched before `reviewedPaymentMode` was stored. Nothing here is derived,
 * and the COLUMNS all remain — only the projection shrank.
 */
function otaMetadataView(booking: BookingDetail) {
  return {
    paymentType: booking.paymentType,
  };
}

/** What actually happened during the stay, beside what was expected. */
function operationalView(booking: BookingDetail) {
  return {
    receivedAt: iso(booking.receivedAt),
    receivedBy: actor(booking.receivedBy),
    actualCheckInAt: iso(booking.actualCheckInAt),
    checkedInBy: actor(booking.checkedInBy),
    actualCheckOutAt: iso(booking.actualCheckOutAt),
    checkedOutBy: actor(booking.checkedOutBy),
    cancelledAt: iso(booking.cancelledAt),
    cancelledBy: actor(booking.cancelledBy),
    cancellationReason: booking.cancellationReason,
  };
}

/**
 * The request context behind each recorded change. ADMIN ONLY.
 *
 * IP, user agent and session identify a device, not a booking. A receptionist
 * needs none of it to serve a guest, and spreading it to every branch terminal
 * would turn an audit record into ambient surveillance of colleagues.
 */
function adminAuditView(booking: BookingDetail) {
  const seen = new Map<string, ReturnType<typeof auditRow>>();
  for (const c of booking.corrections) {
    if (c.requestAudit && !seen.has(c.requestAudit.id)) {
      seen.set(c.requestAudit.id, auditRow(c.requestAudit));
    }
  }
  return {
    parserCommit: booking.parserCommit,
    reviewBuildId: booking.reviewBuildId,
    requests: [...seen.values()],
  };
}

function auditRow(audit: NonNullable<BookingDetail['corrections'][number]['requestAudit']>) {
  return {
    id: audit.id,
    correlationId: audit.correlationId,
    route: audit.route,
    ipAddress: audit.ipAddress,
    userAgent: audit.userAgent,
    sessionId: audit.sessionId,
    occurredAt: audit.occurredAt.toISOString(),
  };
}

/** The full booking detail an Admin sees (includes rawText). */
export function serializeAdminBookingDetail(booking: BookingDetail) {
  return {
    ...claimView(booking),
    /*
      Whether this order may be sent back to its branch.

      DERIVED FROM THE ROW, and from exactly the same three conditions the server
      enforces on the write — so the button and the endpoint cannot disagree.
      Computing it here rather than in the browser means one rule, in one place,
      that a screen cannot get wrong.

      APPROVED is excluded because that status asserts the reservation already
      exists in the hotel system; offering to send it back would be offering to
      create a duplicate. See `redispatchDeletedBooking`.
    */
    canRedispatch:
      booking.sentAt !== null &&
      booking.deletedAt !== null &&
      booking.verificationStatus !== 'APPROVED',
    deletedAt: iso(booking.deletedAt),
    id: booking.id,
    status: booking.status,
    sourcePlatform: booking.sourcePlatform,
    verificationStatus: booking.verificationStatus,
    businessType: booking.businessType,
    businessTypeConfidence: booking.businessTypeConfidence,
    businessTypeManuallyConfirmed: booking.businessTypeManuallyConfirmed,
    businessTypeDetectionSource: booking.businessTypeDetectionSource,
    hotelName: booking.hotelName,
    branch: branchView(booking.branch),
    branchId: booking.branchId,
    customerName: booking.customerName.length > 0 ? booking.customerName : null,
    phone: booking.phone,
    bookingCode: booking.bookingCode.length > 0 ? booking.bookingCode : null,
    checkInDate: isoDate(booking.checkInDate),
    checkOutDate: isoDate(booking.checkOutDate),
    checkInTime: booking.checkInTime,
    checkOutTime: booking.checkOutTime,
    totalAmount: booking.totalAmount,
    currency: booking.currency,
    paymentStatus: booking.paymentStatus,
    specialRequest: booking.specialRequest,
    rawText: booking.rawText,
    parserVersion: booking.parserVersion,
    isLastMinute: booking.isLastMinute,
    rooms: roomsView(booking.rooms),
    warnings: warningsView(booking.warnings),
    proofs: proofsView(booking.id, booking.proofs),
    createdBy: actor(booking.createdBy),
    sentBy: actor(booking.sentBy),
    completedBy: actor(booking.completedBy),
    reviewedBy: actor(booking.reviewedBy),
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    sentAt: iso(booking.sentAt),
    completedAt: iso(booking.completedAt),
    completionNote: booking.completionNote,
    reviewedAt: iso(booking.reviewedAt),

    // The PMS note as it was produced at dispatch and stored, and the payment
    // mode the Admin accepted. Null for Booking.com, which generates its note
    // from the booking itself, and for everything dispatched before these
    // columns existed.
    adminPmsNote: booking.adminPmsNote,
    reviewedPaymentMode: booking.reviewedPaymentMode,

    // Phase 5 operational record, all of it already stored.
    ota: otaMetadataView(booking),
    operational: operationalView(booking),
    // ADMIN ONLY — stripped for reception below.
    requestAudit: adminAuditView(booking),
  };
}

/**
 * The booking detail for the operational endpoints. Receptionists get the same
 * structured data minus rawText, so raw Booking.com personal data is not spread
 * further than it needs to be.
 */
export function serializeOpsBookingDetail(booking: BookingDetail, isAdmin: boolean) {
  const full = serializeAdminBookingDetail(booking);
  // An Admin on an operational route sees exactly what the admin route serves.
  // This flag is the CALLER ROLE, not a display preference: it gates raw text
  // AND request metadata together, so it can never be flipped on to reveal one
  // without knowingly revealing the other.
  if (isAdmin) return full;
  // Receptionists see the final persisted business type only — never the raw
  // text nor the internal detection debug (confidence / detection source).
  const {
    rawText: _omitRaw,
    businessTypeConfidence: _omitConf,
    businessTypeDetectionSource: _omitSource,
    // Request metadata identifies a DEVICE, not a booking. A receptionist
    // needs none of it to serve a guest, and spreading IP, user agent and
    // session to every branch terminal would turn an audit record into
    // ambient surveillance of colleagues.
    requestAudit: _omitAudit,
    ...rest
  } = full;
  return rest;
}

function missingNightlyCount(rooms: BookingListItem['rooms']): number {
  let count = 0;
  for (const room of rooms) for (const night of room.nights) if (night.amount === null) count += 1;
  return count;
}

/**
 * A compact "room type (count)" summary for a booking, aggregated by the
 * persisted room type. Types differing only by whitespace/case are merged, the
 * first-seen readable name is kept, and no type is ever listed twice, e.g.
 * "Superior Giường Đôi (2)" or "Superior Giường Đôi (1) | Deluxe Giường Đôi (1)".
 * Count comes from physical room records, never the guest count.
 */
export function roomSummary(rooms: BookingListItem['rooms']): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  const display = new Map<string, string>();
  for (const room of rooms) {
    const readable = (room.roomType ?? '').trim().replace(/\s+/g, ' ') || 'Chưa rõ hạng phòng';
    const key = readable.toLowerCase();
    if (!counts.has(key)) {
      order.push(key);
      display.set(key, readable);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return order.map((k) => `${display.get(k)} (${counts.get(k)})`).join(' | ');
}

function latestProof(booking: BookingListItem) {
  return booking.proofs[0] ?? null;
}

/** Compact row for the receptionist "Đơn mới" inbox and review lists. */
export function serializeNewListItem(booking: BookingListItem) {
  const proof = latestProof(booking);
  return {
    id: booking.id,
    bookingCode: booking.bookingCode.length > 0 ? booking.bookingCode : null,
    customerName: booking.customerName.length > 0 ? booking.customerName : null,
    phone: booking.phone,
    branch: branchView(booking.branch),
    sourcePlatform: booking.sourcePlatform,
    businessType: booking.businessType,
    verificationStatus: booking.verificationStatus,
    checkInDate: isoDate(booking.checkInDate),
    checkOutDate: isoDate(booking.checkOutDate),
    numberOfRooms: booking.rooms.length,
    roomSummary: roomSummary(booking.rooms),
    totalAmount: booking.totalAmount,
    currency: booking.currency,
    paymentStatus: booking.paymentStatus,
    isLastMinute: booking.isLastMinute,
    sentAt: iso(booking.sentAt),
    sentBy: actor(booking.sentBy),
    status: booking.status,
    missingNightlyPriceCount: missingNightlyCount(booking.rooms),
    warningCount: booking.warnings.length,
    latestAttemptNumber: proof?.attemptNumber ?? 0,
    latestRejectionReason: proof?.status === 'REJECTED' ? proof.reviewReasonCode : null,
    submittedAt: iso(proof?.submittedAt ?? null),
    reviewedAt: iso(booking.reviewedAt),
    ...claimView(booking),
  };
}

/**
 * The claim ("CUT") fields the client needs.
 *
 * `claimExpiresAt` is sent as the ABSOLUTE server instant and the client
 * subtracts a server-supplied `now` from it. Sending "seconds remaining"
 * instead would bake the latency of this response into the deadline and let a
 * slow network quietly extend the window; sending the instant means a refresh,
 * a second tab and a wound-back PC clock all render the same countdown.
 */
export function claimView(booking: {
  claimedByUserId: number | null;
  claimedAt: Date | null;
  claimExpiresAt: Date | null;
  claimCycle: number;
  claimedBy?: ActorUser;
}) {
  return {
    claimedBy: actor(booking.claimedBy ?? null),
    claimedByUserId: booking.claimedByUserId,
    claimedAt: iso(booking.claimedAt),
    claimExpiresAt: iso(booking.claimExpiresAt),
    claimCycle: booking.claimCycle,
  };
}

/** Compact row for the "Đã xác nhận đúng" list. */
export function serializeCompletedListItem(booking: BookingListItem) {
  return {
    id: booking.id,
    customerName: booking.customerName.length > 0 ? booking.customerName : null,
    bookingCode: booking.bookingCode.length > 0 ? booking.bookingCode : null,
    branch: branchView(booking.branch),
    sourcePlatform: booking.sourcePlatform,
    businessType: booking.businessType,
    verificationStatus: booking.verificationStatus,
    checkInDate: isoDate(booking.checkInDate),
    roomSummary: roomSummary(booking.rooms),
    totalAmount: booking.totalAmount,
    currency: booking.currency,
    isLastMinute: booking.isLastMinute,
    completedAt: iso(booking.completedAt),
    completedBy: actor(booking.completedBy),
    completionNote: booking.completionNote,
    reviewedBy: actor(booking.reviewedBy),
    reviewedAt: iso(booking.reviewedAt),
  };
}

/** Compact row for the history list. */
export function serializeHistoryListItem(booking: BookingListItem) {
  return {
    id: booking.id,
    bookingCode: booking.bookingCode.length > 0 ? booking.bookingCode : null,
    customerName: booking.customerName.length > 0 ? booking.customerName : null,
    phone: booking.phone,
    branch: branchView(booking.branch),
    sourcePlatform: booking.sourcePlatform,
    businessType: booking.businessType,
    status: booking.status,
    verificationStatus: booking.verificationStatus,
    paymentStatus: booking.paymentStatus,
    checkInDate: isoDate(booking.checkInDate),
    checkOutDate: isoDate(booking.checkOutDate),
    roomSummary: roomSummary(booking.rooms),
    totalAmount: booking.totalAmount,
    currency: booking.currency,
    isLastMinute: booking.isLastMinute,
    sentAt: iso(booking.sentAt),
    sentBy: actor(booking.sentBy),
    completedAt: iso(booking.completedAt),
    completedBy: actor(booking.completedBy),
    reviewedBy: actor(booking.reviewedBy),
    reviewedAt: iso(booking.reviewedAt),
    createdAt: booking.createdAt.toISOString(),
    reviewedPaymentMode: booking.reviewedPaymentMode,
  };
}
