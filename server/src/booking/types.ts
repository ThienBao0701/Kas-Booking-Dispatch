export type ParsedPaymentStatus = 'PAY_BEFORE' | 'PAY_AFTER';

export type WarningSeverity = 'INFO' | 'WARNING' | 'ERROR';

/** How confidently a scalar field was extracted, for the admin preview. */
export type FieldConfidence = 'CONFIDENT' | 'AMBIGUOUS' | 'MISSING';

/** Which external platform a configured hotel-name alias belongs to. */
export type BranchAliasSourceKey = 'BOOKING_COM' | 'AGODA' | 'MANUAL' | 'OTHER';

/** How an alias is compared against the hotel name found in pasted text. */
export type BranchAliasMatchModeKey = 'EXACT' | 'SIMILARITY';

/** One configured platform hotel name, as the resolver needs it. */
export interface BranchAliasConfig {
  source: BranchAliasSourceKey;
  alias: string;
  matchMode: BranchAliasMatchModeKey;
  priority?: number;
}

/**
 * A branch as needed by the matcher (shape shared by the DB row and fixtures).
 *
 * `aliases` carries the Admin-configured platform names. When it is present the
 * resolver uses ONLY those; when it is absent (pure fixtures, or a branch whose
 * aliases have not been backfilled yet) the legacy in-code tables are used, so
 * behaviour is identical before and after the alias migration.
 */
export interface MatchableBranch {
  id: number;
  code: string;
  hotelName: string;
  address: string;
  /** Absent means "assume active" — only an explicit false blocks routing. */
  active?: boolean;
  aliases?: readonly BranchAliasConfig[];
}

/** How a hotel name found in pasted text was (or was not) resolved to a branch. */
export type BranchResolutionReason =
  | 'EXACT_ALIAS'
  | 'SIMILARITY'
  | 'AMBIGUOUS'
  | 'UNKNOWN'
  | 'NO_INPUT';

/** The resolver's full answer: identity, the alias that won, and why. */
export interface BranchResolution {
  branch: MatchableBranch | null;
  branchId: number | null;
  branchCode: string | null;
  address: string | null;
  /** The configured alias that matched, or null when unresolved. */
  sourceAlias: string | null;
  /** 0–100. */
  confidence: number;
  reason: BranchResolutionReason;
}

export interface ExtractWarning {
  code: string;
  message: string;
  severity: WarningSeverity;
}

/**
 * An operational *completeness* score for the extracted booking (0–100). It is
 * NOT an AI confidence: it is a deterministic weighted measure of how many of the
 * fields a receptionist needs were extracted cleanly, plus whether an admin must
 * re-check the booking before dispatch. Preview metadata only; never persisted.
 */
export interface ParserQuality {
  score: number;
  level: 'HIGH' | 'MEDIUM' | 'LOW';
  requiresAdminReview: boolean;
  missingCriticalFields: string[];
  warningCount: number;
}

export interface ParsedNight {
  /** ISO "YYYY-MM-DD". */
  stayDate: string;
  /** Whole VND, or null when Booking.com did not state a nightly amount. */
  amount: number | null;
  currency: string;
  /** The engine never estimates money, so this is always false here. */
  isEstimated: boolean;
}

export interface ParsedRoom {
  roomIndex: number;
  roomName: string | null;
  /** Whole VND room total when stated, else null. */
  roomTotal: number | null;
  nights: ParsedNight[];
}

export interface ParsedBooking {
  hotelName: string | null;
  guestName: string | null;
  phone: string | null;
  bookingCode: string | null;
  /** ISO "YYYY-MM-DD" or null when absent/unparseable. */
  checkIn: string | null;
  checkOut: string | null;
  currency: string;
  totalAmount: number | null;
  /** Operational arrival note distilled from the guest chat, or null. */
  specialRequest: string | null;
  paymentStatus: ParsedPaymentStatus;
  /**
   * Retained for backwards compatibility. The payment rule is authoritative and
   * always yields a definite answer, so this is always true.
   */
  paymentStatusKnown: boolean;
  rooms: ParsedRoom[];
  /** Best branch candidate (>= suggest threshold), even when not auto-assigned. */
  suggestedBranch: MatchableBranch | null;
  branchMatchScore: number;
  /** The branch match score on a stable 0–100 scale (round of branchMatchScore). */
  branchConfidence: number;
  /** True when the branch match is strong enough to auto-assign without review. */
  branchConfident: boolean;
  /** True when the admin must confirm the branch before dispatch. */
  requiresManualConfirmation: boolean;
  /** Per-field extraction confidence for the preview. */
  fieldConfidence: Record<string, FieldConfidence>;
  /** Operational completeness score + admin-review flag (preview metadata). */
  parserQuality: ParserQuality;
  warnings: ExtractWarning[];
  parserVersion: string;
  /**
   * Present only for an Agoda **hotel-partner** email: the structured partner
   * fields plus the operator's exact two-line PMS note. Optional and additive —
   * Booking.com and the Agoda guest-confirmation path leave it undefined.
   */
  agoda?: AgodaPartnerExtras;
  /**
   * Present only for a CTrip reservation: the structured fields read from the
   * labels CTrip actually supplies. Optional and additive — Booking.com and
   * Agoda leave it undefined, so no existing read path changes.
   */
  ctrip?: CtripExtras;
}

/**
 * Structured CTrip details surfaced alongside a parsed booking.
 *
 * The two prices are deliberately separate fields with unambiguous names: CTrip
 * shows three amounts and confusing them would misstate either what the hotel
 * is owed or what the guest paid.
 */
export interface CtripExtras {
  reservationCode: string | null;
  /** Absent means the Admin must choose the branch — it is never guessed. */
  propertyName: string | null;
  guestName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  roomType: string | null;
  roomQuantity: number | null;
  /** "Your payout" — what the branch receives. */
  branchPrice: number | null;
  /** "Original room rate" — what the guest booked at. */
  guestBookedPrice: number | null;
  /** "Final room rate" — kept for review only; never used as a price. */
  finalRoomRate: number | null;
  /** Null when CTrip did not state it, rather than assumed. */
  breakfastIncluded: boolean | null;
  /** Always empty: CTrip states no per-night breakdown, and none is derived. */
  nightlyRates: { stayDate: string; amount: number | null }[];
}

/** Structured Agoda partner details surfaced alongside a parsed booking. */
export interface AgodaPartnerExtras {
  bookingId: string | null;
  /** The OTA's public property name — a branch-lookup value kept for review only. */
  sourceHotelName: string | null;
  /** The resolved branch's exact stored address (the operational "Khách sạn"). */
  branchAddress: string | null;
  /** The resolved branch's stable code / id, or null when unresolved. */
  branchCode: string | null;
  branchId: number | null;
  /** Primary customer (First + Last), for the Admin preview. */
  customerFullName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  /** The room row verbatim, including Agoda's trailing "(2)" style marker. */
  roomTypeOriginal: string | null;
  /** The same name without that marker — the key the mappings are looked up by. */
  roomTypeNormalized: string | null;
  /** Every room row the reservation states. The fields above describe the first. */
  roomLines: {
    roomTypeOriginal: string | null;
    roomTypeNormalized: string | null;
    quantity: number;
    occupancy: string | null;
    extraBeds: number | null;
  }[];
  roomCode: string | null;
  roomTypeKnown: boolean;
  roomQuantity: number | null;
  occupancy: string | null;
  extraBeds: number | null;
  netRate: number | null;
  referenceSellRate: number | null;
  payment: string | null;
  ratePlan: string | null;
  cancellationPolicy: string | null;
  countryOfResidence: string | null;
  /** Descriptive fields kept for the booking record; never used to decide anything. */
  sourcePropertyId: string | null;
  bookingStatus: 'CONFIRMED' | 'AMENDED' | 'CANCELLED' | null;
  websiteLanguage: string | null;
  paymentType: string | null;
  benefitsIncluded: string | null;
  specialRequests: string | null;
  customerPhone: string | null;
  /**
   * Agoda's own per-night rows (diagnostics only — not the debt schedule).
   * `amount` is what Agoda printed and may cover every room that night;
   * `perRoomAmount` is an exact per-room share when one exists.
   */
  nightlyRates: { stayDate: string; amount: number | null; perRoomAmount?: number | null }[];
  /** Total hotel receivable = the Agoda Net rate. */
  totalDebtAmount: number | null;
  /** Net rate split evenly per stay night; sums exactly to totalDebtAmount. */
  nightlyDebt: { stayDate: string; amount: number | null }[];
  /** The exact two-line note, or null when required data is missing. */
  pmsNote: string | null;
  pmsNoteError: string | null;
}
