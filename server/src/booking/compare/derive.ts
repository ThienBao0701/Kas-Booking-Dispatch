/**
 * Derives the compare engine's typed inputs from real data: `ExpectedBooking`
 * from the persisted booking (what the Admin dispatched) and `DetectedProof` from
 * a COMPLETED OCR analysis's structured fields. No comparison happens here.
 */
import type { BookingDetail } from '../bookingView';
import type { ProofExtractedData } from '../ocr/types';
import type { DetectedProof, ExpectedBooking } from './engine';
import type { DetectedConfidences } from './enrich';

function isoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function nightsBetween(checkIn: Date | null, checkOut: Date | null): number {
  if (!checkIn || !checkOut) return 0;
  const a = Date.parse(isoDate(checkIn) + 'T00:00:00Z');
  const b = Date.parse(isoDate(checkOut) + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** A short arrival note (only when a time is clearly present), else ''. */
function arrivalOf(specialRequest: string | null): string {
  if (!specialRequest) return '';
  const t = /\b\d{1,2}:\d{2}\b/.exec(specialRequest);
  return t ? t[0] : '';
}

export function deriveExpected(booking: BookingDetail): ExpectedBooking {
  const checkIn = booking.checkInDate ?? null;
  const checkOut = booking.checkOutDate ?? null;
  const fromDates = nightsBetween(checkIn, checkOut);
  const nights = fromDates > 0 ? fromDates : booking.rooms.reduce((m, r) => Math.max(m, r.nights.length), 0);

  // Representative nightly prices (first room's nights) — OCR rarely reads these.
  const firstRoom = booking.rooms[0];
  const nightlyPrices = (firstRoom?.nights ?? [])
    .filter((n) => n.stayDate)
    .map((n) => ({ date: isoDate(n.stayDate)!, amount: n.amount ?? null }));

  return {
    bookingCode: booking.bookingCode || null,
    checkInDate: isoDate(checkIn),
    checkOutDate: isoDate(checkOut),
    totalAmount: booking.totalAmount ?? null,
    currency: booking.currency,
    roomQuantity: booking.rooms.length,
    customerName: booking.customerName || null,
    roomTypes: booking.rooms.map((r) => r.roomType ?? ''),
    paymentStatus: booking.paymentStatus,
    nights,
    nightlyPrices,
    note: {
      bookingCode: booking.bookingCode || null,
      nights,
      total: booking.totalAmount ?? null,
      payment: booking.paymentStatus,
      partner: booking.businessType === 'PARTNER',
      // Same database-backed source as the client's PMS note: the branch's own
      // Branch.breakfastIncluded, for every branch. Never a hardcoded code set —
      // the expectation must follow the Admin's configuration, or the comparison
      // would flag a correct note as a mismatch after a breakfast change.
      breakfast: booking.branch?.breakfastIncluded === true,
      arrival: arrivalOf(booking.specialRequest),
    },
  };
}

export function deriveDetected(fields: ProofExtractedData, extractedText: string | null): DetectedProof {
  return {
    bookingCode: fields.bookingCode?.value ?? null,
    checkInDate: fields.checkInDate?.value ?? null,
    checkOutDate: fields.checkOutDate?.value ?? null,
    totalAmount: fields.totalAmount?.value ?? null,
    roomQuantity: fields.roomQuantity?.value ?? null,
    customerName: fields.customerName?.value ?? null,
    roomTypes: fields.roomTypes.map((r) => ({ value: r.value, quantity: r.quantity })),
    paymentStatus: fields.paymentStatus?.value ?? null,
    nights: fields.nights?.value ?? null,
    nightlyPrices: [], // the current OCR extractor does not expose nightly prices
    note: {
      bookingCode: fields.bookingCode?.value ?? null,
      total: fields.totalAmount?.value ?? null,
      payment: fields.paymentStatus?.value ?? null,
      nights: fields.nights?.value ?? null,
      noteText: fields.note?.value ?? extractedText ?? null,
    },
  };
}

/** Per-field OCR confidence (0–100), for the C.3.5 confidence explanation. */
export function deriveConfidences(fields: ProofExtractedData): DetectedConfidences {
  return {
    bookingCode: fields.bookingCode?.confidence,
    checkIn: fields.checkInDate?.confidence,
    checkOut: fields.checkOutDate?.confidence,
    total: fields.totalAmount?.confidence,
    roomQuantity: fields.roomQuantity?.confidence,
    customerName: fields.customerName?.confidence,
    roomType: fields.roomTypes[0]?.confidence,
    payment: fields.paymentStatus?.confidence,
    nights: fields.nights?.confidence,
    note: fields.note?.confidence,
  };
}
