/**
 * "Buồng phòng" — room inspections and the collection Reception makes on them.
 *
 * The labels come from the server (`/housekeeping/options`) for the reason every
 * label list here does; the constants below are the fallback for the moment
 * before the request has answered, and the server refuses anything outside them.
 */
import { api } from './client';

export type RoomIssueType =
  | 'SMOKING'
  | 'ODOR'
  | 'DAMAGED_FACILITY'
  | 'LOST_ITEM'
  | 'UNREGISTERED_GUEST'
  | 'OTHER';

export type RoomCollectionStatus = 'PENDING' | 'COLLECTED' | 'UNCOLLECTIBLE';
export type RoomCollectionMethod = 'CASH' | 'TRANSFER' | 'CARD';

export const ROOM_ISSUE_TYPES: { code: RoomIssueType; label: string }[] = [
  { code: 'SMOKING', label: 'Hút thuốc' },
  { code: 'ODOR', label: 'Phòng có mùi' },
  { code: 'DAMAGED_FACILITY', label: 'Cơ sở vật chất hư hỏng' },
  { code: 'LOST_ITEM', label: 'Khách quên đồ' },
  { code: 'UNREGISTERED_GUEST', label: 'Phòng có khách nhưng hệ thống không có' },
  { code: 'OTHER', label: 'Vấn đề khác' },
];

export const ROOM_COLLECTION_STATUSES: { code: RoomCollectionStatus; label: string }[] = [
  { code: 'PENDING', label: 'Chưa thu' },
  { code: 'COLLECTED', label: 'Đã thu' },
  { code: 'UNCOLLECTIBLE', label: 'Không thu được' },
];

export const ROOM_COLLECTION_METHODS: { code: RoomCollectionMethod; label: string }[] = [
  { code: 'CASH', label: 'Tiền mặt' },
  { code: 'TRANSFER', label: 'Chuyển khoản' },
  { code: 'CARD', label: 'Cà thẻ' },
];

export interface RoomIssueCollection {
  amount: number;
  status: RoomCollectionStatus;
  method: RoomCollectionMethod | null;
  methodLabel: string | null;
  reason: string | null;
  note: string | null;
  recordedByName: string;
  updatedAt: string;
}

export interface RoomIssue {
  id: string;
  inspectionId: string;
  branchId: number;
  branch: { id: number; code: string; hotelName: string; address: string; branchNumber: number };
  roomNumber: string;
  /** Người dọn / người kiểm tra. */
  staffName: string;
  recordedByName: string;
  type: RoomIssueType;
  typeLabel: string;
  note: string | null;
  createdAt: string;
  voided: boolean;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  /**
   * NULL FOR BỘ PHẬN BUỒNG PHÒNG: the collection state ("Đã thu / Chưa thu") is
   * the front desk's, and the server does not send it to Housekeeping at all.
   */
  collectionStatus: RoomCollectionStatus | null;
  collectionStatusLabel: string | null;
  /** Null for Bộ phận buồng phòng, which is sent nothing about the money. */
  collection: RoomIssueCollection | null;
  history: {
    id: string;
    amount: number;
    status: RoomCollectionStatus;
    statusLabel: string;
    methodLabel: string | null;
    reason: string | null;
    note: string | null;
    actorName: string;
    createdAt: string;
  }[];
}

export interface RoomIssueSummary {
  total: number;
  byStatus: Record<RoomCollectionStatus, number>;
  byType: { type: RoomIssueType; label: string; count: number }[];
  collectedByMethod: Record<RoomCollectionMethod, number>;
  collectedTotal: number;
  pendingAmount: number;
  uncollectibleAmount: number;
}

export interface RoomIssueList {
  issues: RoomIssue[];
  total: number;
  truncated: boolean;
  /** Null for Bộ phận buồng phòng. */
  summary: RoomIssueSummary | null;
  /** The facts of the inspections — for every role, and nothing about money. */
  inspectionSummary?: InspectionSummary;
}

/** Inspections, findings and rooms in the filter — never an amount or a collection state. */
export interface InspectionSummary {
  inspections: number;
  issues: number;
  rooms: number;
  byType: { type: RoomIssueType; label: string; count: number }[];
}

export interface NewInspectionInput {
  roomNumber: string;
  /** Optional: the shift's cleaner ("Tên người dọn buồng") is used when absent. */
  staffName?: string;
  issues: { type: RoomIssueType; note?: string }[];
}

export interface CollectionInput {
  status: RoomCollectionStatus;
  amount?: number;
  method?: RoomCollectionMethod;
  reason?: string;
  note?: string;
}

export interface RoomIssueFilter {
  branchId?: number;
  type?: RoomIssueType;
  /** One room of the branch. */
  roomNumber?: string;
  status?: RoomCollectionStatus;
  from?: string;
  to?: string;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const ROOM_ISSUES_KEY = ['housekeeping', 'issues'] as const;
export const HOUSEKEEPING_SHIFT_KEY = ['housekeeping', 'shift'] as const;

/** One branch within a workday — where, who cleaned, when, and what was found. */
export interface WorkSegment {
  id: string;
  branch: { id: number; code: string; hotelName: string; address: string; branchNumber: number };
  staffName: string;
  startedAt: string;
  endedAt: string | null;
  rooms: number;
  inspections: number;
  issues: number;
  byType: { type: RoomIssueType; label: string; count: number }[];
}

/** A housekeeping workday: "Vào ca" → segments (one per branch) → "Kết thúc ca". */
export interface WorkShift {
  id: string;
  user: { id: number; fullName: string };
  startedAt: string;
  endedAt: string | null;
  segments: WorkSegment[];
  /** Where the account works now; null once the day has ended. */
  current: WorkSegment | null;
  totals: { rooms: number; inspections: number; issues: number; byType: WorkSegment['byType'] };
}

export const housekeepingApi = {
  createInspection: (input: NewInspectionInput) =>
    api.post<{ inspection: { id: string; roomNumber: string; issues: RoomIssue[] } }>(
      '/housekeeping/inspections',
      input,
    ),

  issues: (filter: RoomIssueFilter = {}) =>
    api.get<RoomIssueList>(`/housekeeping/issues${query({ ...filter })}`),

  saveCollection: (issueId: string, input: CollectionInput) =>
    api.put<{ issue: RoomIssue }>(`/housekeeping/issues/${issueId}/collection`, input),

  voidIssue: (issueId: string, reason: string) =>
    api.post<{ issue: RoomIssue }>(`/housekeeping/issues/${issueId}/void`, { reason }),

  /** The account's open workday, or null. */
  shift: () => api.get<{ shift: WorkShift | null }>('/housekeeping/shift'),
  /** "Vào ca" — at the account's branch; the server decides it. */
  startShift: () => api.post<{ shift: WorkShift }>('/housekeeping/shift/start', {}),
  /** "Kết thúc ca": the day's summary comes back. */
  endShift: () => api.post<{ shift: WorkShift }>('/housekeeping/shift/end', {}),
  /** Workdays on record: one's own, or a supervisor's scope. */
  shifts: (filter: { from?: string; to?: string; branchId?: number } = {}) =>
    api.get<{ shifts: WorkShift[] }>(`/housekeeping/shifts${query({ ...filter })}`),
};
