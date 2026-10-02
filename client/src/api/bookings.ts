import { api } from './client';
import type { Branch } from '../auth/types';

/**
 * The dispatch states plus the five operational states added in Phase 5. The
 * two halves are one enum on the server and must stay one here — a status the
 * client does not know about renders as a raw enum name to the receptionist.
 */
export type BookingStatus =
  | 'DRAFT'
  | 'READY'
  | 'NEW'
  | 'COMPLETED'
  | 'ARCHIVED'
  | 'RECEIVED'
  | 'CHECKED_IN'
  | 'CHECKED_OUT'
  | 'CANCELLED'
  | 'NO_SHOW';
export type PaymentStatus = 'PAY_BEFORE' | 'PAY_AFTER';
export type BookingSource = 'BOOKING_COM' | 'AGODA' | 'CTRIP';
export type BusinessType = 'DIRECT' | 'PARTNER' | 'UNKNOWN';
export type VerificationStatus = 'NOT_SUBMITTED' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
export type ProofStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
export type ProofReviewReason =
  | 'WRONG_CUSTOMER_NAME'
  | 'WRONG_BOOKING_CODE'
  | 'WRONG_DATES'
  | 'WRONG_ROOM_COUNT'
  | 'WRONG_ROOM_TYPE'
  | 'WRONG_PRICE'
  | 'MISSING_ROOM'
  | 'UNCLEAR_IMAGE'
  | 'OTHER';

/** Vietnamese labels for the rejection reasons (order = display order). */
export const REVIEW_REASONS: { code: ProofReviewReason; label: string }[] = [
  { code: 'WRONG_CUSTOMER_NAME', label: 'Sai tên khách' },
  { code: 'WRONG_BOOKING_CODE', label: 'Sai mã Booking' },
  { code: 'WRONG_DATES', label: 'Sai ngày check-in/check-out' },
  { code: 'WRONG_ROOM_COUNT', label: 'Sai số lượng phòng' },
  { code: 'WRONG_ROOM_TYPE', label: 'Sai hạng phòng' },
  { code: 'WRONG_PRICE', label: 'Sai giá' },
  { code: 'MISSING_ROOM', label: 'Thiếu phòng' },
  { code: 'UNCLEAR_IMAGE', label: 'Ảnh không rõ' },
  { code: 'OTHER', label: 'Khác' },
];

export const REVIEW_REASON_LABEL: Record<ProofReviewReason, string> = Object.fromEntries(
  REVIEW_REASONS.map((r) => [r.code, r.label]),
) as Record<ProofReviewReason, string>;

/**
 * How each platform is named to an operator.
 *
 * The enum value stays `BOOKING_COM` — it is stored on every existing booking
 * and renaming it would be a migration for a label. Only the display text
 * changes, so history, badges and the source filter all follow automatically.
 */
export const SOURCE_LABEL: Record<BookingSource, string> = {
  BOOKING_COM: 'Booking',
  AGODA: 'Agoda',
  CTRIP: 'CTrip',
};

export interface ProofView {
  id: string;
  attemptNumber: number;
  status: ProofStatus;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  submissionNote: string | null;
  submittedBy: Actor | null;
  submittedAt: string;
  reviewedBy: Actor | null;
  reviewedAt: string | null;
  reviewReasonCode: ProofReviewReason | null;
  reviewNote: string | null;
  imageUrl: string;
}

export interface Actor {
  id: number;
  fullName: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface NightPrice {
  id: string;
  stayDate: string | null;
  amount: number | null;
  currency: string;
  manuallyCorrected: boolean;
  isEstimated: boolean;
}

export type RoomClassResolutionStatus = 'RESOLVED' | 'MANUAL' | 'UNRESOLVED' | 'LEGACY';

export interface RoomView {
  id: string;
  roomIndex: number;
  roomType: string | null;
  roomSubtotal: number | null;
  taxAmount: number | null;
  feeAmount: number | null;
  /**
   * Immutable branch room-class snapshot taken when the booking was created
   * (C.3.8). Optional because bookings created before that phase have none.
   * `roomClassPmsCode` is what the note prints — it is never recomputed, so
   * activating a new room-class mapping cannot change an existing booking.
   */
  roomClassId?: string | null;
  roomClassVersionId?: string | null;
  roomClassDisplayName?: string | null;
  roomClassPmsCode?: string | null;
  roomClassSourceText?: string | null;
  roomClassStatus?: RoomClassResolutionStatus | null;
  nights: NightPrice[];
}

export interface WarningView {
  code: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
}


/**
 * The one thing still read from what the OTA said.
 *
 * The rest of the block — rate plan, cancellation policy, country, language,
 * property id, build hashes — went with the card that displayed it: none of it
 * was ever acted on at a branch. `paymentType` stays because the payment field
 * falls back to it for OTA bookings dispatched before `reviewedPaymentMode`
 * existed. The server sends exactly this shape.
 */
export interface OtaMetadata {
  paymentType: string | null;
}

/** What actually happened during the stay, beside what was expected. */
export interface OperationalRecord {
  receivedAt: string | null;
  receivedBy: Actor | null;
  actualCheckInAt: string | null;
  checkedInBy: Actor | null;
  actualCheckOutAt: string | null;
  checkedOutBy: Actor | null;
  cancelledAt: string | null;
  cancelledBy: Actor | null;
  cancellationReason: string | null;
}

/**
 * Request provenance. ADMIN ONLY — the server omits this key entirely for a
 * receptionist, so its absence is the permission boundary, not a UI choice.
 */
export interface RequestAuditView {
  parserCommit: string | null;
  reviewBuildId: string | null;
  requests: {
    id: string;
    correlationId: string | null;
    route: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    sessionId: string | null;
    occurredAt: string;
  }[];
}

/** The full operational booking (admin form also includes rawText). */
export interface BookingDetail extends ClaimFields {
  /**
   * Fields this receptionist has already CẮT in the current claim cycle.
   *
   * Always empty for an Admin — the server never hides anything from them. The
   * values themselves are still present on this payload either way; CẮT decides
   * what reception is shown, not what the booking contains.
   */
  cutFields?: CutField[];
  /**
   * Whether this order may be sent back to its branch — true only when it was
   * sent once AND is currently withdrawn. Derived server-side from the same
   * conditions the endpoint enforces. Admin payloads only.
   */
  canRedispatch?: boolean;
  deletedAt?: string | null;
  id: string;
  status: BookingStatus;
  sourcePlatform: BookingSource;
  verificationStatus: VerificationStatus;
  businessType: BusinessType;
  businessTypeConfidence?: number | null;
  businessTypeManuallyConfirmed: boolean;
  businessTypeDetectionSource?: string | null;
  hotelName: string | null;
  branch: Branch | null;
  branchId: number | null;
  customerName: string | null;
  phone: string | null;
  bookingCode: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  totalAmount: number | null;
  currency: string;
  paymentStatus: PaymentStatus;
  specialRequest: string | null;
  rawText?: string;
  parserVersion: string | null;
  isLastMinute: boolean;
  rooms: RoomView[];
  warnings: WarningView[];
  proofs: ProofView[];
  createdBy: Actor | null;
  sentBy: Actor | null;
  completedBy: Actor | null;
  reviewedBy: Actor | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  completedAt: string | null;
  completionNote: string | null;
  reviewedAt: string | null;
  /**
   * The PMS note exactly as it was generated and stored at dispatch. Null for
   * Booking.com, whose note is built from the booking itself, and for every OTA
   * booking dispatched before the note was stored.
   */
  adminPmsNote: string | null;
  /** The payment mode the Admin accepted at dispatch. */
  reviewedPaymentMode: string | null;
  ota: OtaMetadata;
  operational: OperationalRecord;
  /** Absent for receptionists — the server strips it. */
  requestAudit?: RequestAuditView;
}

/**
 * Claim ("CUT") state carried by every dispatched-order payload.
 *
 * `claimExpiresAt` is an ABSOLUTE server instant. The countdown is rendered as
 * (claimExpiresAt - serverNow), never from a duration the server computed, so a
 * refresh, a second tab or a wound-back PC clock all show the same deadline.
 */
export interface ClaimFields {
  claimedBy: Actor | null;
  claimedByUserId: number | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  claimCycle: number;
}

/**
 * The three values a receptionist takes off an order one at a time.
 *
 * Naming the fields rather than sending an index means the server validates
 * what was cut, and a reordered UI cannot silently cut the wrong thing.
 */
export const CUT_FIELDS = ['CUSTOMER_NAME', 'TOTAL_AMOUNT', 'PMS_NOTE'] as const;
export type CutField = (typeof CUT_FIELDS)[number];

export interface NewListItem extends ClaimFields {
  /**
   * When this order was most recently put in front of reception — the start of
   * the response SLA.
   *
   * Usually the dispatch instant, but later than `sentAt` for an order that was
   * resent, because a resend restarts the response window. Resolved server-side;
   * see the `/bookings/new` handler.
   */
  slaStartedAt?: string | null;
  id: string;
  bookingCode: string | null;
  customerName: string | null;
  phone: string | null;
  branch: Branch | null;
  sourcePlatform: BookingSource;
  businessType: BusinessType;
  verificationStatus: VerificationStatus;
  checkInDate: string | null;
  checkOutDate: string | null;
  numberOfRooms: number;
  roomSummary: string;
  totalAmount: number | null;
  currency: string;
  paymentStatus: PaymentStatus;
  isLastMinute: boolean;
  sentAt: string | null;
  sentBy: Actor | null;
  status: BookingStatus;
  missingNightlyPriceCount: number;
  warningCount: number;
  latestAttemptNumber: number;
  latestRejectionReason: ProofReviewReason | null;
  submittedAt: string | null;
  reviewedAt: string | null;
}

export interface HistoryListItem {
  id: string;
  bookingCode: string | null;
  customerName: string | null;
  phone: string | null;
  branch: Branch | null;
  sourcePlatform: BookingSource;
  businessType: BusinessType;
  status: BookingStatus;
  verificationStatus: VerificationStatus;
  paymentStatus: PaymentStatus;
  checkInDate: string | null;
  checkOutDate: string | null;
  roomSummary: string;
  totalAmount: number | null;
  currency: string;
  isLastMinute: boolean;
  sentAt: string | null;
  sentBy: Actor | null;
  completedAt: string | null;
  completedBy: Actor | null;
  reviewedBy: Actor | null;
  reviewedAt: string | null;
  createdAt: string;
  reviewedPaymentMode: string | null;
}

export interface ListResponse<T> {
  bookings: T[];
  pagination: Pagination;
}

export interface ParserQuality {
  score: number;
  level: 'HIGH' | 'MEDIUM' | 'LOW';
  requiresAdminReview: boolean;
  missingCriticalFields: string[];
  warningCount: number;
}

/**
 * Structured Agoda **hotel-partner** details, present only when the pasted text
 * was an Agoda partner (YCS) booking email. `pmsNote` is the exact two-line note
 * the receptionist copies.
 */
export interface AgodaPartnerExtras {
  bookingId: string | null;
  /** The OTA's public property name — a branch-lookup value, kept for review. */
  sourceHotelName: string | null;
  /** The resolved branch's exact stored address (the operational "Khách sạn"). */
  branchAddress: string | null;
  branchCode: string | null;
  branchId: number | null;
  /** Primary customer (First + Last), for the Admin preview. */
  customerFullName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  nights: number | null;
  roomTypeOriginal: string | null;
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
  /** Agoda's own per-night rows (diagnostics only). */
  nightlyRates: { stayDate: string; amount: number | null }[];
  /** Total hotel receivable = the Agoda Net rate. */
  totalDebtAmount: number | null;
  /** Net rate split evenly per stay night; sums exactly to totalDebtAmount. */
  nightlyDebt: { stayDate: string; amount: number | null }[];
  pmsNote: string | null;
  pmsNoteError: string | null;
}

/** One room of an extraction preview — no id, because nothing was stored. */
export interface PreviewRoom {
  roomIndex: number;
  roomName: string | null;
  roomTotal: number | null;
  nights: { stayDate: string; amount: number | null; currency: string; isEstimated: boolean }[];
}

/**
 * What the extraction endpoint returns for BOOKING.COM.
 *
 * `persisted: false` is the contract, not a detail: nothing was written, so
 * there is no `id` to fetch, patch or send. The review lives in the browser
 * until the Admin presses Gửi, which posts the whole thing to
 * `bookingsApi.dispatchBookingCom`.
 */
export interface ExtractResponse {
  persisted: false;
  booking: {
    bookingCode: string | null;
    hotelName: string | null;
    sourcePlatform: BookingSource;
    guestName: string | null;
    phone: string | null;
    checkIn: string | null;
    checkOut: string | null;
    currency: string;
    totalAmount: number | null;
    paymentStatus: PaymentStatus;
    specialRequest: string | null;
    parserVersion: string;
  };
  suggestedBranch: Branch | null;
  branchConfidence: number;
  branchConfident: boolean;
  requiresManualConfirmation: boolean;
  parserQuality: ParserQuality;
  businessType: BusinessType;
  businessTypeConfidence: number;
  businessTypeRequiresAdminConfirmation: boolean;
  businessTypeMatchedRules: string[];
  rooms: PreviewRoom[];
  warnings: WarningView[];
  /** Null unless the source was an Agoda hotel-partner email. */
  agoda: AgodaPartnerExtras | null;
}

/** The complete reviewed reservation, sent in one request at Gửi. */
export interface BookingComDispatchPayload {
  rawText: string;
  branchId: number;
  hotelName: string | null;
  customerName: string;
  phone: string | null;
  bookingCode: string;
  checkInDate: string | null;
  checkOutDate: string | null;
  totalAmount: number | null;
  paymentStatus: PaymentStatus;
  specialRequest: string | null;
  rooms: {
    roomIndex: number;
    roomType: string | null;
    roomSubtotal: number | null;
    /** The internal class the Admin picked; null lets the server resolve it. */
    roomClassId: string | null;
    nights: { stayDate: string; amount: number | null }[];
  }[];
  /** Only when the Admin explicitly chose it on the review screen. */
  businessType?: 'DIRECT' | 'PARTNER';
  acknowledgedWarningCodes: string[];
}

/** Vietnamese label + tone for a business type. */
export const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = {
  DIRECT: 'Đơn thường',
  PARTNER: 'Đơn đối tác',
  UNKNOWN: 'Chưa xác định',
};

function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const bookingsApi = {
  extract: (rawText: string, source: BookingSource = 'BOOKING_COM') =>
    api.post<ExtractResponse>('/bookings/extract', { rawText, source }),

  /**
   * Creates and sends a reviewed Booking.com reservation in ONE call.
   *
   * Replaces update-draft → mark-ready → send. There is no booking to update
   * beforehand: the server creates it, already NEW, inside one transaction, and
   * a failure leaves nothing behind for the Admin to clean up. The review state
   * stays in the browser so a rejected send can be corrected and retried.
   */
  dispatchBookingCom: (payload: BookingComDispatchPayload) =>
    api.post<{ booking: BookingDetail }>('/admin/bookings/dispatch', payload),

  /*
    THE DRAFT LIFECYCLE IS GONE FROM THIS CLIENT.

    Six wrappers used to live here — adminDetail, update, confirmBusinessType,
    markReady, send and setRoomClass. Together they were the Booking.com review:
    extract wrote a DRAFT, each of these edited it, and send flipped it to NEW.
    Every one of them existed to mutate a booking nobody had decided to create.

    `dispatchBookingCom` above replaces all six. They are removed rather than
    left unused because a dead wrapper is an invitation to write through it
    again, and reviving any of them would put an unsent reservation back in the
    database — the exact thing this change removed.

    THE SERVER ENDPOINTS THEY CALLED STILL EXIST and are unchanged:
    `/admin/bookings/:id` (GET/PUT), `/business-type`, `/ready`, `/send` and
    `/bookings/:id/rooms/:n/room-class`. They operate on bookings that ALREADY
    EXIST and remain covered by the server suite. What was retired is
    Booking.com's use of them, not the capability.
  */

  detail: (id: string) =>
    api.get<{ booking: BookingDetail; serverNow?: string }>(`/bookings/${id}`),

  // --- Proof verification -------------------------------------------------
  /**
   * The image, and nothing else.
   *
   * There is no creator-name parameter any more: the server resolves who created
   * the order from the receptionist's open shift. `note` stays on the server's
   * schema so old rows keep their meaning, but the client no longer sends one —
   * a name in the request body is exactly the thing that could be forged.
   */
  submitProof: (id: string, file: File) => {
    const form = new FormData();
    form.append('image', file);
    return api.postForm<{ booking: BookingDetail }>(`/bookings/${id}/proofs`, form);
  },
  approveProof: (id: string, proofId: string) =>
    api.post<{ booking: BookingDetail }>(`/bookings/${id}/proofs/${proofId}/approve`, {}),
  rejectProof: (id: string, proofId: string, reasonCode: ProofReviewReason, reviewNote?: string) =>
    api.post<{ booking: BookingDetail }>(`/bookings/${id}/proofs/${proofId}/reject`, { reasonCode, reviewNote }),

  // --- Dispatch claim ("CUT") ---------------------------------------------
  /** Take ownership of a dispatched order. Server-atomic; 409 when already held. */
  claim: (id: string) =>
    api.post<{ claimedAt: string; claimExpiresAt: string; claimCycle: number; serverNow: string }>(
      `/bookings/${id}/claim`,
      {},
    ),
  /**
   * CẮT one field off the order.
   *
   * The FIRST call also claims the booking and starts the three minutes; later
   * calls in the same cycle return the same `claimExpiresAt` untouched, which is
   * why three buttons never produce three timers.
   */
  cut: (id: string, field: CutField) =>
    api.post<{
      claimedAt: string;
      claimExpiresAt: string;
      claimCycle: number;
      cutFields: CutField[];
      serverNow: string;
    }>(`/bookings/${id}/cut`, { field }),
  /** Admin: orders whose claim ran out and which were never completed. */
  listExpiredClaims: (params: { branchId?: number; page?: number; pageSize?: number } = {}) =>
    api.get<ListResponse<NewListItem> & { serverNow: string }>(
      `/bookings/expired-claims${query(params)}`,
    ),
  /** Admin: release an expired claim so reception can take it again. */
  resend: (id: string) => api.post<{ success: true; claimCycle: number }>(`/bookings/${id}/resend`, {}),
  /**
   * Admin: send a WITHDRAWN order back to its branch.
   *
   * Distinct from `resend` above: that releases a lapsed claim on an order still
   * with reception, this revives one the Admin deleted. The server refuses
   * unless the order was sent once and is currently deleted.
   */
  redispatch: (id: string) =>
    api.post<{ booking: BookingDetail }>(`/admin/bookings/${id}/redispatch`, {}),

  listNew: (params: { branchId?: number; page?: number; pageSize?: number } = {}) =>
    api.get<ListResponse<NewListItem> & { serverNow?: string }>(`/bookings/new${query(params)}`),
  listPendingReview: (params: { branchId?: number; page?: number; pageSize?: number } = {}) =>
    api.get<ListResponse<NewListItem>>(`/bookings/pending-review${query(params)}`),
  listRejected: (params: { branchId?: number; page?: number; pageSize?: number } = {}) =>
    api.get<ListResponse<NewListItem>>(`/bookings/rejected${query(params)}`),
  history: (params: Record<string, string | number | boolean | undefined>) =>
    api.get<ListResponse<HistoryListItem>>(`/bookings/history${query(params)}`),

  /**
   * One operational transition. The server owns which transitions are legal —
   * the client hides buttons it believes are unavailable, but a stale tab that
   * posts anyway gets a 409 rather than a wrong write.
   */
  /** Admin-only. Soft delete: the booking leaves every queue, audit survives. */
  remove: (id: string) => api.del<{ bookingId: string; deletedAt: string }>(`/admin/bookings/${id}`),

  lifecycle: (id: string, action: LifecycleAction, reason?: string) =>
    api.post<LifecycleResult>(`/bookings/${id}/${LIFECYCLE_PATH[action]}`, reason ? { reason } : {}),
};

export type LifecycleAction = 'RECEIVE' | 'CHECK_IN' | 'CHECK_OUT' | 'COMPLETE' | 'CANCEL' | 'NO_SHOW';

export interface LifecycleResult {
  bookingId: string;
  oldStatus: BookingStatus;
  newStatus: BookingStatus;
}

const LIFECYCLE_PATH: Record<LifecycleAction, string> = {
  RECEIVE: 'receive',
  CHECK_IN: 'check-in',
  CHECK_OUT: 'check-out',
  COMPLETE: 'complete',
  CANCEL: 'cancel',
  NO_SHOW: 'no-show',
};

/**
 * Which action each status offers, mirroring the server's ALLOWED_FROM.
 *
 * Duplicated deliberately and kept minimal: the client needs it to decide what
 * to DRAW, and it is not a permission check. The server re-validates every
 * transition, so a wrong entry here can only hide or offer a button — never
 * permit an illegal write.
 */
export const LIFECYCLE_NEXT: Partial<Record<BookingStatus, LifecycleAction[]>> = {
  NEW: ['RECEIVE', 'CANCEL'],
  RECEIVED: ['CHECK_IN', 'NO_SHOW', 'CANCEL'],
  CHECKED_IN: ['CHECK_OUT'],
  CHECKED_OUT: ['COMPLETE'],
};

export const LIFECYCLE_LABEL: Record<LifecycleAction, string> = {
  RECEIVE: 'Nhận đơn',
  CHECK_IN: 'Khách nhận phòng',
  CHECK_OUT: 'Khách trả phòng',
  COMPLETE: 'Hoàn tất',
  CANCEL: 'Huỷ đơn',
  NO_SHOW: 'Khách không đến',
};

/** The two that cost the hotel money, and so ask before they act. */
export const LIFECYCLE_DESTRUCTIVE: LifecycleAction[] = ['CANCEL', 'NO_SHOW'];

export const branchesApi = {
  list: () => api.get<{ branches: Branch[] }>('/branches'),
  /**
   * The branch's room catalog — the ONE list every room selector reads.
   * `rooms: null` means the branch has no catalog: the form falls back to a typed room.
   */
  /** The branch's room and floor catalog (floors read as "Tầng <value>"). */
  rooms: (branchId: number) =>
    api.get<{ branchId: number; rooms: string[] | null; floors?: string[] | null }>(`/branches/${branchId}/rooms`),
};

export interface DashboardSummary {
  /** The first day of the scope (YYYY-MM-DD). For a single day, that day. */
  date: string;
  /** The inclusive scope these figures describe, resolved by the server. */
  range: { from: string; to: string };
  /**
   * Every figure is a property of ONE population: the orders DISPATCHED inside
   * the scope. `waiting`/`confirmedToday`/`lastMinute` are subsets of
   * `sentToday`, never wider than it — the server counts them from a single
   * `sentAt` window so the cards and the branch rows cannot disagree.
   */
  totals: { waiting: number; confirmedToday: number; lastMinute: number; sentToday: number };
  branches: {
    branch: Branch;
    waiting: number;
    confirmedToday: number;
    lastMinute: number;
    /** This branch's share of `totals.sentToday`; the rows sum to it. */
    sent: number;
  }[];
  /** Issues REPORTED in the scope, and how many of those are still open. */
  issues: { reported: number; stillOpen: number };
}

/** A metric the server refuses to compute, with the reason it gives. */
export interface Unavailable {
  value: null;
  reason: string;
}

export interface StatBreakdown {
  key: string;
  label: string;
  bookings: number;
  revenue: number;
  share: number;
}

/**
 * The 7b statistics. `adr`, `occupancy` and `revPar` are always
 * `{ value: null, reason }` until a room inventory exists — the server will not
 * invent a denominator, and the client must not invent one either.
 */
export interface BookingStatistics {
  range: { from: string; to: string };
  bookingCount: number;
  revenue: number;
  stayNights: number;
  averageRevenuePerStayNight: number | null;
  averageStayNights: number | null;
  adr: Unavailable;
  occupancy: Unavailable;
  revPar: Unavailable;
  cancelledCount: number;
  noShowCount: number;
  cancellationRate: number | null;
  noShowRate: number | null;
  byOta: StatBreakdown[];
  byBranch: StatBreakdown[];
}

export const dashboardApi = {
  /**
   * One day (`date`) or an inclusive range (`from`..`to`), both YYYY-MM-DD.
   * Omitting everything means today, exactly as before. Sending `date`
   * alongside `from`/`to` is refused by the server rather than resolved by
   * precedence — see `summaryQuery`.
   */
  summary: (params: { date?: string; from?: string; to?: string } = {}) =>
    api.get<DashboardSummary>(`/admin/dashboard/summary${query(params)}`),
  statistics: (params: { from?: string; to?: string; branchId?: number } = {}) =>
    api.get<BookingStatistics>(`/admin/dashboard/statistics${query(params)}`),
};
