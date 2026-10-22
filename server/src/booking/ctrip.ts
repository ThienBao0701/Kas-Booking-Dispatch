/**
 * CTrip (Trip.com) raw-text intake adapter.
 *
 * ARCHITECTURE — and its deliberate limits.
 *
 * This is a thin adapter over the SHARED extraction engine (`parseBooking`),
 * exactly as `parseAgodaBooking` is. The engine already handles the shapes that
 * are common to every OTA confirmation page: labelled fields, values that wrap
 * onto the next line, long and numeric dates, grouped VND amounts, room
 * sections and per-night tables. The adapter's job is only to (a) strip the
 * source-specific noise that would otherwise be misread as data, (b) stamp the
 * parser version, and (c) route hotel recognition through OtaPlatform.CTRIP.
 *
 * WHAT THIS ADAPTER DOES NOT DO, AND WHY:
 * there are no real or sanitized CTrip documents in this repository, so no
 * CTrip-specific field grammar has been written. Inventing regexes from
 * assumptions is how a parser silently mis-reads a price or a date, and a wrong
 * total or check-in date reaches a real guest. Instead this adapter extracts
 * only what the generic engine can support, and every field it cannot find is
 * surfaced as a warning for the Admin to correct — with the critical ones
 * blocking dispatch through the existing validation. When real CTrip samples
 * arrive, the place to add their grammar is here, behind fixtures.
 *
 * The intake source is preserved as CTRIP everywhere downstream (storage,
 * history, preview, filters, audit, notifications). A CTrip booking is never
 * recorded as Agoda, even though the two platforms currently share property
 * names — they are independent identities and either may be renamed alone.
 */
import { parseBooking } from './parser';
import { extractCtripFields, nightsBetween } from './ctripFields';
import type { IdentityBranch } from './identityResolver';
import type { MatchableBranch, ParsedBooking } from './types';

/** Extraction-engine version stamped onto CTrip-sourced bookings. */
export const CTRIP_PARSER_VERSION = 'ctrip-1.0.0';

/**
 * Boilerplate that appears around copied CTrip/Trip.com content and carries no
 * booking data. Removed BEFORE parsing so a navigation crumb or a marketing
 * line can never be mistaken for the hotel name or a money value.
 *
 * Kept deliberately small and literal: each entry is chrome, never a field.
 */
const NOISE_PATTERNS: readonly RegExp[] = [
  // Site chrome / navigation.
  /^\s*(Trip\.com|Ctrip|携程)\s*$/gim,
  /^\s*(Home|My Bookings|Sign in|Log in|Help Center|Customer Service)\s*$/gim,
  // Marketing / legal footers.
  /^\s*(Download the app|Terms and Conditions|Privacy Policy|Copyright.*)\s*$/gim,
  // Loyalty noise that contains numbers and could be read as money.
  /^\s*(Trip Coins|Earn .* Trip Coins|You earned .*)\s*$/gim,
];

/**
 * Strikethrough "original price" hints. CTrip, like Agoda, shows a crossed-out
 * pre-discount amount; reading it as the total would overstate what the hotel
 * is owed, so it is removed rather than ranked below the real price.
 */
const STRUCK_PRICE_PATTERNS: readonly RegExp[] = [
  /\(?\s*was\s+(VND|₫)?\s*[\d.,]+\s*\)?/gi,
  /\(?\s*original(ly)?\b[^\n)]*\)?/gi,
  /\(?\s*gia goc\b[^\n)]*\)?/gi,
];

/**
 * Removes CTrip chrome and struck-through prices. Pure and conservative: it
 * only ever DELETES text it recognises as noise, and never rewrites, reorders
 * or normalises a value the engine will later read.
 */
export function normalizeCtripText(rawText: string): string {
  let cleaned = rawText;
  for (const pattern of NOISE_PATTERNS) cleaned = cleaned.replace(pattern, '');
  for (const pattern of STRUCK_PRICE_PATTERNS) cleaned = cleaned.replace(pattern, ' ');
  return cleaned;
}

/**
 * Parses pasted CTrip text into the same normalized `ParsedBooking` every other
 * source produces, so nothing downstream is source-aware.
 *
 * Branch recognition resolves against the branch's CURRENT CTrip identity (then
 * its internal name), and — as on every platform — only an EXACT match assigns
 * a branch. An unknown or ambiguous property name leaves the booking
 * unassigned, warns, and blocks dispatch until an Admin confirms.
 */
export function parseCtripBooking(
  rawText: string,
  branches: readonly MatchableBranch[],
): ParsedBooking {
  const cleaned = normalizeCtripText(rawText);
  const parsed = parseBooking(cleaned, branches as readonly IdentityBranch[], 'CTRIP');
  const fields = extractCtripFields(rawText);

  // The structured CTrip labels are authoritative where they are present: the
  // generic engine reads a page heuristically, whereas these are the labels the
  // operator confirmed. Each one is applied ONLY when CTrip actually stated it,
  // so a field the engine found is never overwritten with nothing.
  const checkIn = fields.checkIn ?? parsed.checkIn;
  const checkOut = fields.checkOut ?? parsed.checkOut;
  const nights = nightsBetween(checkIn, checkOut);

  // CTrip prints the night count beside the stay period. When it disagrees with
  // the dates, the DATES are kept — they are what the stay actually is — and the
  // Admin is told, because one of the two is wrong and the parser cannot know
  // which.
  const warnings = [...parsed.warnings];
  if (fields.statedNights != null && nights != null && fields.statedNights !== nights) {
    warnings.push({
      code: 'CTRIP_NIGHTS_MISMATCH',
      message: `CTrip ghi ${fields.statedNights} đêm nhưng khoảng ngày là ${nights} đêm — vui lòng kiểm tra.`,
      severity: 'ERROR',
    });
  }

  return {
    ...parsed,
    warnings,
    bookingCode: fields.reservationCode ?? parsed.bookingCode,
    guestName: fields.guestName ?? parsed.guestName,
    checkIn,
    checkOut,
    // The BRANCH price. "Your payout" is what the hotel receives; the guest's
    // own price lives in `ctrip.guestBookedPrice` and is never confused with it.
    totalAmount: fields.payout ?? parsed.totalAmount,
    parserVersion: CTRIP_PARSER_VERSION,
    ctrip: {
      reservationCode: fields.reservationCode,
      propertyName: fields.propertyName,
      guestName: fields.guestName,
      checkIn: fields.checkIn,
      checkOut: fields.checkOut,
      nights,
      roomType: fields.roomType,
      roomQuantity: fields.roomQuantity,
      branchPrice: fields.payout,
      // "Original room rate" — never replaced by "Final room rate", which is
      // the post-discount figure rather than what the guest booked at.
      guestBookedPrice: fields.originalRoomRate,
      finalRoomRate: fields.finalRoomRate,
      breakfastIncluded: fields.breakfastIncluded,
      // CTrip states no per-night breakdown. This stays empty rather than
      // holding the payout divided by the nights: a derived figure would be
      // copied into the PMS as if CTrip had stated it.
      nightlyRates: [],
    },
  };
}
