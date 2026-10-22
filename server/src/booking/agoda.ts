import { parseBooking } from './parser';
import { resolveAgodaBranch } from './branchMatcher';
import { resolveBranchIdentity, type IdentityBranch } from './identityResolver';
import {
  AGODA_PARTNER_PARSER_VERSION,
  buildAgodaPmsNote,
  isAgodaPartnerEmail,
  parseAgodaPartnerBooking,
  type AgodaPartnerBooking,
} from './agodaPartner';
import type { AgodaPartnerExtras, MatchableBranch, ParsedBooking, ParsedRoom } from './types';

/** Extraction-engine version stamped onto Agoda-sourced bookings. */
export const AGODA_PARSER_VERSION = 'agoda-1.0.0';

export { AGODA_PARTNER_PARSER_VERSION };

/**
 * Agoda raw-text parser adapter. Two Agoda documents are supported:
 *
 *  1. The **hotel-partner (YCS) booking email** — labelled reservation table plus
 *     commercial rows ("Reference sell rate", "Net rate", …). Detected first and
 *     handled by the dedicated deterministic extractor in `agodaPartner.ts`, which
 *     also produces the operator's exact two-line PMS note.
 *  2. The **guest-facing confirmation page** — the original format, which uses the
 *     same shapes the shared engine already handles (labelled fields, English room
 *     names, long dates, grouped VND). Behaviour here is unchanged.
 *
 * Both return the same normalized `ParsedBooking`, so downstream code is
 * source-agnostic; the partner path additionally fills the optional `agoda` field.
 */
export function parseAgodaBooking(
  rawText: string,
  branches: readonly MatchableBranch[],
): ParsedBooking {
  if (isAgodaPartnerEmail(rawText)) {
    return fromPartnerEmail(rawText, branches);
  }

  const cleaned = rawText
    // Remove crossed-out "originally VND x" hints so they cannot be read as a price.
    .replace(/\(?\s*originally\b[^\n)]*\)?/gi, ' ')
    .replace(/\(?\s*gia goc\b[^\n)]*\)?/gi, ' ');

  const parsed = parseBooking(cleaned, branches, 'AGODA');
  return { ...parsed, parserVersion: AGODA_PARSER_VERSION };
}

/** Projects the partner extraction onto the shared ParsedBooking shape. */
function fromPartnerEmail(rawText: string, branches: readonly MatchableBranch[]): ParsedBooking {
  const p = parseAgodaPartnerBooking(rawText);
  const note = buildAgodaPmsNote(p);

  // Branch resolution goes through the same branch configuration and text
  // normalisation as Booking.com (`branchMatcher`), using the configured Agoda
  // property-name map. The public hotel name is ONLY a lookup value; an unknown or
  // incomplete name is never assigned to a default branch — the Admin picks it.
  // Resolved against the branch's CURRENT Agoda identity (then its internal
  // name), exactly like every other platform. `resolveAgodaBranch` remains as
  // the fallback for fixtures that carry no identities at all.
  const identity = resolveBranchIdentity(
    p.sourceHotelName,
    'AGODA',
    branches as readonly IdentityBranch[],
  );
  const suggestedBranch =
    identity.branchId !== null
      ? (branches.find((b) => b.id === identity.branchId) ?? null)
      : resolveAgodaBranch(p.sourceHotelName, branches);
  // An exact configured name is a certain match; anything else is unresolved.
  const matchScore = suggestedBranch ? 1 : 0;
  const branchConfident = suggestedBranch !== null;
  if (!suggestedBranch) {
    p.warnings.push({
      code: 'AGODA_BRANCH_UNRESOLVED',
      message: 'Không xác định được địa chỉ chi nhánh từ tên khách sạn Agoda.',
      severity: 'ERROR',
    });
  }

  const rooms: ParsedRoom[] = buildRooms(p);
  const missingCritical: string[] = [];
  if (!p.bookingId) missingCritical.push('bookingCode');
  if (!p.checkIn) missingCritical.push('checkIn');
  if (!p.checkOut) missingCritical.push('checkOut');
  if (p.netRate == null) missingCritical.push('totalAmount');
  if (!p.roomTypeKnown) missingCritical.push('roomType');

  const errorCount = p.warnings.filter((w) => w.severity === 'ERROR').length;
  const score = Math.max(0, 100 - errorCount * 20 - (p.warnings.length - errorCount) * 5);

  const extras: AgodaPartnerExtras = {
    bookingId: p.bookingId,
    sourceHotelName: p.sourceHotelName,
    branchAddress: suggestedBranch?.address ?? null,
    branchCode: suggestedBranch?.code ?? null,
    branchId: suggestedBranch?.id ?? null,
    customerFullName: p.customerFullName,
    checkIn: p.checkIn,
    checkOut: p.checkOut,
    nights: p.nights,
    roomTypeOriginal: p.roomTypeOriginal,
    roomTypeNormalized: p.roomTypeNormalized,
    roomLines: p.roomLines,
    roomCode: p.roomCode,
    roomTypeKnown: p.roomTypeKnown,
    roomQuantity: p.roomQuantity,
    occupancy: p.occupancy,
    extraBeds: p.extraBeds,
    netRate: p.netRate,
    referenceSellRate: p.referenceSellRate,
    payment: p.payment,
    ratePlan: p.ratePlan,
    cancellationPolicy: p.cancellationPolicy,
    countryOfResidence: p.countryOfResidence,
    sourcePropertyId: p.sourcePropertyId,
    bookingStatus: p.bookingStatus,
    websiteLanguage: p.websiteLanguage,
    paymentType: p.paymentType,
    benefitsIncluded: p.benefitsIncluded,
    specialRequests: p.specialRequests,
    customerPhone: p.customerPhone,
    nightlyRates: p.nightlyRates,
    // The authoritative schedule: Net rate split evenly, summing to the total.
    totalDebtAmount: p.netRate,
    nightlyDebt: p.nightlyDebt,
    pmsNote: note.ok ? note.text! : null,
    pmsNoteError: note.ok ? null : (note.error ?? null),
  };

  return {
    // Like Booking.com, the operational "Khách sạn" value is the configured branch
    // ADDRESS — never the OTA's public property name (kept in `agoda` for review).
    hotelName: suggestedBranch ? suggestedBranch.address : null,
    guestName: p.customerFullName,
    phone: p.customerPhone,
    bookingCode: p.bookingId,
    checkIn: p.checkIn,
    checkOut: p.checkOut,
    currency: 'VND',
    // The hotel's own amount for this reservation is the Agoda **Net rate**; the
    // guest-facing price is kept separately in `agoda.referenceSellRate`.
    totalAmount: p.netRate,
    specialRequest: p.customerNotes,
    // Agoda partner bookings are settled with Agoda, never collected at the desk.
    paymentStatus: 'PAY_BEFORE',
    paymentStatusKnown: true,
    rooms,
    suggestedBranch,
    branchMatchScore: matchScore,
    branchConfidence: suggestedBranch ? Math.round(matchScore * 100) : 0,
    branchConfident,
    requiresManualConfirmation: !branchConfident || missingCritical.length > 0,
    fieldConfidence: {
      bookingCode: p.bookingId ? 'CONFIDENT' : 'MISSING',
      guestName: p.customerFullName ? 'CONFIDENT' : 'MISSING',
      checkIn: p.checkIn ? 'CONFIDENT' : 'MISSING',
      checkOut: p.checkOut ? 'CONFIDENT' : 'MISSING',
      totalAmount: p.netRate != null ? 'CONFIDENT' : 'MISSING',
      roomType: p.roomTypeKnown ? 'CONFIDENT' : p.roomTypeOriginal ? 'AMBIGUOUS' : 'MISSING',
      paymentStatus: 'CONFIDENT',
    },
    parserQuality: {
      score,
      level: score >= 80 ? 'HIGH' : score >= 50 ? 'MEDIUM' : 'LOW',
      requiresAdminReview: errorCount > 0 || !branchConfident,
      missingCriticalFields: missingCritical,
      warningCount: p.warnings.length,
    },
    warnings: p.warnings,
    parserVersion: AGODA_PARTNER_PARSER_VERSION,
    agoda: extras,
  };
}

/**
 * Expands "No. of Rooms" into that many physical rooms, all of the stated type.
 *
 * The nightly values are the generated **debt schedule** (total Net rate split
 * evenly across the stay nights, summing exactly to the total) — matching the
 * Booking.com `nightPrices` semantics of one row per stay date. The booking-level
 * total is never divided by rooms, guests, occupancy or extra beds, so with
 * several rooms the per-room split is not stated and the amounts stay null.
 */
function buildRooms(p: AgodaPartnerBooking): ParsedRoom[] {
  const count = p.roomQuantity && p.roomQuantity > 0 ? p.roomQuantity : 1;
  const single = count === 1;
  return Array.from({ length: count }, (_, i) => ({
    roomIndex: i + 1,
    roomName: p.roomTypeOriginal,
    roomTotal: single ? p.netRate : null,
    nights: p.nightlyDebt.map((n) => ({
      stayDate: n.stayDate,
      amount: single ? n.amount : null,
      currency: 'VND',
      isEstimated: false,
    })),
  }));
}
