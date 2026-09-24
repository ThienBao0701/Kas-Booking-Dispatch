import { api } from './client';
import type { RepairAttempt } from './issues';
import type { ShiftType } from './shifts';

export type ReportCategory =
  | 'PAYMENT'
  | 'GUEST_REQUEST'
  | 'FACILITY_ISSUE'
  | 'CUSTOMER_COMPLAINT'
  | 'ROOM_SERVICE';

export type PaymentMethod = 'CASH' | 'TRANSFER' | 'CARD';

export type RoomServiceType = 'ROOM_SALE' | 'UPGRADE' | 'SMOKING' | 'LAUNDRY' | 'OTHER';

/**
 * The labels come from the SERVER, not from a constant here.
 *
 * The same words appear on this screen, on the Admin drill-down, in the PDF and
 * in the XLSX — and two of those four are built on the server. A copy in React
 * is how the exported file and the screen it was exported from start disagreeing
 * about what a column is called.
 */
export interface ReportOptions {
  categories: { code: ReportCategory; label: string }[];
  paymentMethods: { code: PaymentMethod; label: string }[];
  roomServiceTypes: { code: RoomServiceType; label: string }[];
  guestRequestItems: string[];
}

export interface ReportAudit {
  id: string;
  action: 'EDIT' | 'VOID' | 'OPENING_CASH';
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  actor: { id: number; name: string };
  shiftType: ShiftType | null;
  createdAt: string;
}

export interface PaymentDetail {
  ezCode: string | null;
  source: string | null;
  guestName: string | null;
  roomNumber: string | null;
  method: PaymentMethod;
  methodLabel: string;
  amount: number;
  receivable: number;
  expense: number;
  note: string | null;
  /** Split by method on the server, so the three columns cannot drift. */
  cash: number;
  transfer: number;
  card: number;
}

export interface GuestRequestDetail {
  itemType: string;
  guestName: string;
  note: string | null;
  accepted: boolean;
  acceptedBy: { id: number; fullName: string } | null;
  acceptedByName: string | null;
  acceptedAt: string | null;
  acceptedShiftType: ShiftType | null;
  acceptedShiftName: string | null;
}

/** The LIVE incident, read through the reference — never a copy of it. */
export interface FacilityIssueDetail {
  issueId: string;
  issue: {
    id: string;
    locationLabel: string;
    category: string | null;
    description: string;
    status: 'NEW' | 'IN_PROGRESS' | 'COMPLETED';
    needsRework: boolean;
    technicianName: string | null;
    technicianPhone: string | null;
    acceptedAt: string | null;
    completedAt: string | null;
    durationLabel: string | null;
    cannotRepairCount: number;
    /**
     * Oldest first, and fully populated — the server runs the SAME
     * `serializeIssue` here as it does for the technical queue, so each attempt
     * carries its outcome, reason and duration. This was typed `unknown[]`,
     * which made the last attempt's result unreadable to anything that had only
     * a report in hand, and left the Admin monitor unable to say how a repair
     * ended without a second request.
     */
    attempts: RepairAttempt[];
    /**
     * The INCIDENT's own stamp, which moves when a technician works it — unlike
     * the report's `updatedAt`, which only moves when reception edits the
     * journal entry. "Cập nhật gần nhất" is this one.
     */
    updatedAt: string;
  };
}

export interface ComplaintDetail {
  guestName: string;
  location: string;
  description: string;
}

export interface RoomServiceDetail {
  serviceType: RoomServiceType;
  serviceTypeLabel: string;
  guestName: string;
  phone: string | null;
  roomNumber: string | null;
  roomClass: string | null;
  fromRoomClass: string | null;
  toRoomClass: string | null;
  serviceName: string | null;
  price: number;
  note: string | null;
}

export interface OperationalReport {
  id: string;
  category: ReportCategory;
  categoryLabel: string;
  branchId: number;
  branch: { id: number; code: string; hotelName: string; address: string; branchNumber: number } | null;
  shiftSessionId: string | null;
  shiftType: ShiftType | null;
  shiftName: string | null;
  shiftWindow: string | null;
  /**
   * "YYYY-MM-DD" — the HCM day the SHIFT belongs to, decided on the server
   * from the session. Ca C of the 22nd owns its 02:15 entries too, so this is
   * what an Admin view groups by; a record's own `createdAt` is not.
   */
  shiftDate: string;
  /** The receptionist ON the shift, as they checked in. Null without a session. */
  shiftReceptionistName: string | null;
  /**
   * Has the shift pressed "Kết thúc ca"? Only closed shifts are in the official
   * report for their business date; an open one is shown, and flagged.
   */
  shiftClosed: boolean;
  createdBy: { id: number; fullName: string } | null;
  /** The name the SHIFT recorded — never the account's current one. */
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  voided: boolean;
  voidedAt: string | null;
  voidedBy: { id: number; fullName: string } | null;
  voidedByName: string | null;
  voidReason: string | null;
  payment: PaymentDetail | null;
  guestRequest: GuestRequestDetail | null;
  facility: FacilityIssueDetail | null;
  complaint: ComplaintDetail | null;
  roomService: RoomServiceDetail | null;
  audits: ReportAudit[];
}

export type CategoryCounts = Record<ReportCategory, number>;

/**
 * The drawer. `openingCash` and `endingCash` are NULLABLE, and null means
 * "chưa kiểm đếm" rather than zero — an uncounted drawer and an empty one are
 * different facts, and only one of them lets the ending figure be trusted.
 */
export interface CashSummary {
  openingCash: number | null;
  cashCollected: number;
  transferCollected: number;
  cardCollected: number;
  receivable: number;
  cashExpense: number;
  endingCash: number | null;
  paymentCount: number;
  voidedCount: number;
}

export interface NewPaymentInput {
  ezCode?: string;
  source?: string;
  guestName?: string;
  roomNumber?: string;
  method: PaymentMethod;
  amount: number;
  receivable?: number;
  expense?: number;
  note?: string;
}

export interface NewGuestRequestInput {
  itemType: string;
  guestName: string;
  note?: string;
}

export interface NewComplaintInput {
  guestName: string;
  location: string;
  description: string;
}

export interface NewRoomServiceInput {
  serviceType: RoomServiceType;
  guestName: string;
  phone?: string;
  roomNumber?: string;
  roomClass?: string;
  fromRoomClass?: string;
  toRoomClass?: string;
  serviceName?: string;
  price: number;
  note?: string;
}

/**
 * A discriminated union, mirroring the server's own schema: a report is exactly
 * one category, and a body carrying two is refused rather than resolved.
 */
export type NewReportInput =
  | { category: 'PAYMENT'; payment: NewPaymentInput }
  | { category: 'GUEST_REQUEST'; guestRequest: NewGuestRequestInput }
  | { category: 'FACILITY_ISSUE'; facility: { issueId: string } }
  | { category: 'CUSTOMER_COMPLAINT'; complaint: NewComplaintInput }
  | { category: 'ROOM_SERVICE'; roomService: NewRoomServiceInput };

export interface UpdateReportInput {
  payment?: Partial<NewPaymentInput>;
  guestRequest?: Partial<NewGuestRequestInput>;
  complaint?: Partial<NewComplaintInput>;
  roomService?: Partial<NewRoomServiceInput>;
  reason?: string;
}

interface ListResponse {
  reports: OperationalReport[];
  counts: CategoryCounts;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const reportsApi = {
  options: () => api.get<ReportOptions>('/reception/reports/options'),

  list: (params: { category?: ReportCategory; shiftSessionId?: string; from?: string; to?: string } = {}) =>
    api.get<ListResponse>(`/reception/reports${query(params)}`),

  create: (input: NewReportInput) =>
    api.post<{ report: OperationalReport }>('/reception/reports', input),

  update: (id: string, patch: UpdateReportInput) =>
    api.patch<{ report: OperationalReport }>(`/reception/reports/${id}`, patch),

  /**
   * "Xóa", implemented as a withdrawal. NOT a DELETE: the row keeps its place in
   * the journal with the reason attached, and drops out of every total.
   */
  void: (id: string, reason: string) =>
    api.post<{ report: OperationalReport }>(`/reception/reports/${id}/void`, { reason }),

  accept: (id: string) =>
    api.post<{ report: OperationalReport }>(`/reception/reports/${id}/accept`, {}),

  cash: () => api.get<{ cash: CashSummary }>('/reception/shifts/cash'),

  setOpeningCash: (openingCash: number) =>
    api.put<{ cash: CashSummary }>('/reception/shifts/cash', { openingCash }),
};

/* ---------------------------- Admin drill-down ---------------------------- */

export interface AdminOperationalResponse {
  reports: OperationalReport[];
  counts: CategoryCounts;
  /** Null for an all-branch view: a drawer belongs to one desk. */
  cash: CashSummary | null;
  /**
   * The HCM days `cash` covers — today when no period was asked for.
   *
   * Carried so the panel can NAME the period. An unlabelled cash figure on a
   * screen whose record list is unfiltered reads as "the cash position", and
   * there is no such number.
   */
  cashPeriod: { from: string; to: string } | null;
  /** Every matching record, however many were returned. */
  total: number;
  /** True when the list was cut short — stated, never silent. */
  truncated: boolean;
  /** Shifts of the period that have not pressed "Kết thúc ca" yet. */
  openShifts: OpenShiftNotice[];
  /** The server's own sentence for them, so every surface says the same thing. */
  openShiftWarning: string;
}

export interface OpenShiftNotice {
  sessionId: string;
  branchId: number;
  branchAddress: string;
  businessDate: string;
  shiftName: string;
  shiftWindow: string;
  receptionistName: string;
}

export const adminReportsApi = {
  operational: (params: { branchId?: number; category?: ReportCategory; from?: string; to?: string }) =>
    api.get<AdminOperationalResponse>(`/admin/reports/operational${query(params)}`),
};

/**
 * Export URLs, opened as ordinary links rather than fetched.
 *
 * The browser's own download handling gets the file name from
 * Content-Disposition and the bytes straight to disk; fetching into memory to
 * build a blob would hold a multi-megabyte workbook in the tab for no gain.
 */
/** The export's scope — the same three filters the screen uses. */
export interface OperationalExportScope {
  from: string;
  to: string;
  branchId?: number;
  category?: ReportCategory;
}

export function operationalPdfUrl(params: OperationalExportScope): string {
  return `/api/admin/reports/operational.pdf${query({ ...params })}`;
}

export function operationalXlsxUrl(params: OperationalExportScope): string {
  return `/api/admin/reports/operational.xlsx${query({ ...params })}`;
}
