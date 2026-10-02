/**
 * The Admin OTA review API (Agoda and CTrip).
 *
 * The server is authoritative. This module carries the Admin's corrections up
 * and brings the resolved review back down; it deliberately reimplements NONE
 * of the business rules. The note shown on screen is the note the server
 * generated, the list of selectable PMS codes is the list the server said is
 * valid for the selected branch, and `canDispatch` is the server's answer — not
 * a conclusion the browser reached on its own.
 */
import { api } from './client';

/** The two platforms this review serves. Booking.com has its own flow. */
export type OtaReviewSource = 'AGODA' | 'CTRIP';

/** How the guest pays, as the operator words it. */
export type OtaPaymentMode = 'CN' | 'HOTEL_PAYMENT';

/** The exact Vietnamese wording, confirmed by the operator: "TẠI" is included. */
export const OTA_PAYMENT_LABEL: Record<OtaPaymentMode, string> = {
  CN: 'CN',
  HOTEL_PAYMENT: 'THANH TOÁN TẠI KHÁCH SẠN',
};

export const OTA_SOURCE_LABEL: Record<OtaReviewSource, string> = {
  AGODA: 'Agoda',
  CTRIP: 'CTrip',
};

export interface OtaReviewRoomLine {
  quantity: number;
  /** The name the branch mappings are keyed by. */
  otaRoomName: string | null;
  /** The name exactly as the platform printed it. Server-derived; sent back untouched. */
  rawOtaRoomName?: string | null;
  otaRoomTypeId: string | null;
  /** null while unresolved. Never free text — chosen from validPmsCodes. */
  pmsCode: string | null;
  requiresManualMapping: boolean;
  /** The nightly figure the source stated, covering every room on the line. */
  sourceNightlyTotal?: number | null;
  /** That figure divided by the room count, when the split is exact. */
  perRoomNightlyRate?: number | null;
}

export interface OtaReviewNightly {
  stayDate: string;
  amount: number | null;
  /** An exact per-room share of that night, when there is one. */
  perRoomAmount?: number | null;
}

export interface OtaReviewWarning {
  code: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
}

export interface OtaReview {
  source: OtaReviewSource;
  branchId: number | null;
  branchCode: string | null;
  branchAddress: string | null;
  requiresManualBranch: boolean;
  bookingCode: string | null;
  guestName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  rooms: OtaReviewRoomLine[];
  nightlyRates: OtaReviewNightly[];
  branchPrice: number | null;
  guestBookedPrice: number | null;
  breakfastIncluded: boolean | null;
  paymentMode: OtaPaymentMode;
  note: string | null;
  noteError: string | null;
  warnings: OtaReviewWarning[];
  canDispatch: boolean;
  blockingReasons: string[];
}

export interface OtaBranchOption {
  id: number;
  code: string;
  branchNumber: number;
  address: string;
  hotelName: string;
}

export interface OtaReviewResponse {
  review: OtaReview;
  branchOptions: OtaBranchOption[];
  /** Only these may be offered in the manual PMS-code selector. */
  validPmsCodes: string[];
  knownOtaRoomNames: { otaRoomName: string; pmsCode: string }[];
  /** Set when this reservation was already dispatched — amend, do not re-send. */
  existingBookingId: string | null;
}

/** The Admin's corrections. Only what changed needs sending. */
export interface OtaReviewOverrides {
  branchId?: number | null;
  bookingCode?: string | null;
  guestName?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
  rooms?: OtaReviewRoomLine[];
  branchPrice?: number | null;
  guestBookedPrice?: number | null;
  breakfastIncluded?: boolean | null;
  paymentMode?: OtaPaymentMode;
}

/** One field an amended reservation states differently. */
export interface AmendmentChange {
  field: string;
  label: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface AmendmentPreview {
  bookingId: string;
  review: OtaReview;
  /** Only the fields that DIFFER. An unchanged field never appears. */
  changes: AmendmentChange[];
  /** The platform says the reservation is cancelled. A warning, never an action. */
  otaCancelled: boolean;
  currentStatus: string;
  /** Concurrency token; returned with the apply so a stale tab loses. */
  expectedVersion: string;
}

export interface AmendmentResult {
  bookingId: string;
  applied: AmendmentChange[];
  rejected: AmendmentChange[];
  correctionIds: string[];
}

export interface OtaDispatchResponse {
  bookingId: string;
  /** False when this reservation had already been dispatched. */
  created: boolean;
  review: OtaReview;
}

export const otaReviewApi = {
  review: (source: OtaReviewSource, rawText: string, overrides?: OtaReviewOverrides) =>
    api.post<OtaReviewResponse>('/admin/ota/review', { source, rawText, overrides }),

  /**
   * Persists the reviewed reservation and sends it to its branch.
   *
   * Deliberately posts the SAME body as the review: the server rebuilds the
   * review from the pasted text and these corrections and dispatches that, so
   * the browser cannot submit a booking the review would have refused.
   */
  dispatch: (source: OtaReviewSource, rawText: string, overrides?: OtaReviewOverrides) =>
    api.post<OtaDispatchResponse>('/admin/ota/dispatch', { source, rawText, overrides }),

  /** Compares an amended mail with the dispatched booking. Writes nothing. */
  amendment: (source: OtaReviewSource, rawText: string, overrides?: OtaReviewOverrides) =>
    api.post<AmendmentPreview>('/admin/ota/amendment', { source, rawText, overrides }),

  /**
   * Applies the accepted changes. `acceptedFields` is always sent explicitly —
   * omitting it means "accept everything" on the server, which must never
   * happen by accident when a reviewer has deselected rows.
   */
  applyAmendment: (
    source: OtaReviewSource,
    rawText: string,
    acceptedFields: string[],
    expectedVersion?: string,
    overrides?: OtaReviewOverrides,
  ) =>
    api.post<AmendmentResult>('/admin/ota/amendment/apply', {
      source,
      rawText,
      overrides,
      acceptedFields,
      expectedVersion,
    }),
};
