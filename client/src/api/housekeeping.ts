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
  collectionStatus: RoomCollectionStatus;
  collectionStatusLabel: string;
  /** Null for Bộ phận buồng phòng, which sees THAT an issue was settled, not the money. */
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
}

export interface NewInspectionInput {
  roomNumber: string;
  staffName: string;
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
};
