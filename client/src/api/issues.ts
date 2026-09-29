import { api } from './client';
import type { Branch } from '../auth/types';
import type { Actor, Pagination } from './bookings';

export type IssueCategory =
  | 'DOOR'
  | 'AIR_CONDITIONER'
  | 'TOILET'
  | 'TV'
  | 'WIFI'
  | 'ELECTRICITY'
  | 'WATER'
  | 'FURNITURE'
  | 'HOUSEKEEPING'
  | 'GUEST_REQUEST'
  | 'OTHER';

/**
 * The three workflow states. COMPLETED was called RESOLVED before the technical
 * department existed; the enum value itself was renamed in the database, so
 * there is no legacy literal to keep accepting here.
 */
export type IssueStatus = 'NEW' | 'IN_PROGRESS' | 'COMPLETED';

/** WHERE the incident is — the first thing the report form asks. */
export type IssueAreaCategory =
  | 'ROOM'
  | 'LOBBY'
  | 'HALLWAY'
  | 'STAIRCASE'
  | 'RESTAURANT'
  | 'ROOFTOP'
  | 'OTHER_AREA';

/** What is wrong in the lobby. */
export type IssueAreaSubtype =
  | 'RECEPTION_DESK'
  | 'SOFA'
  | 'FLOOR'
  | 'CEILING'
  | 'LIGHT_BULB'
  | 'CLOCK'
  | 'OTHER';

/** Vietnamese labels (dropdown/display order). */
export const ISSUE_CATEGORIES: { value: IssueCategory; label: string }[] = [
  { value: 'DOOR', label: 'Cửa' },
  { value: 'AIR_CONDITIONER', label: 'Máy lạnh' },
  { value: 'TOILET', label: 'Nhà vệ sinh' },
  { value: 'TV', label: 'TV' },
  { value: 'WIFI', label: 'Wifi' },
  { value: 'ELECTRICITY', label: 'Điện' },
  { value: 'WATER', label: 'Nước' },
  { value: 'FURNITURE', label: 'Nội thất' },
  { value: 'HOUSEKEEPING', label: 'Buồng phòng' },
  { value: 'GUEST_REQUEST', label: 'Yêu cầu của khách' },
  { value: 'OTHER', label: 'Khác' },
];

export const ISSUE_CATEGORY_LABEL: Record<IssueCategory, string> = Object.fromEntries(
  ISSUE_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<IssueCategory, string>;

export const ISSUE_AREAS: { value: IssueAreaCategory; label: string }[] = [
  { value: 'ROOM', label: 'Phòng' },
  { value: 'LOBBY', label: 'Khu Vực Sảnh' },
  { value: 'HALLWAY', label: 'Khu Vực Hành Lang' },
  { value: 'STAIRCASE', label: 'Khu Vực Cầu Thang' },
  { value: 'RESTAURANT', label: 'Khu Vực Nhà Hàng' },
  { value: 'ROOFTOP', label: 'Khu Vực Rooftop' },
  { value: 'OTHER_AREA', label: 'Các Khu Vực Còn Lại' },
];

export const ISSUE_AREA_LABEL: Record<IssueAreaCategory, string> = Object.fromEntries(
  ISSUE_AREAS.map((a) => [a.value, a.label]),
) as Record<IssueAreaCategory, string>;

export const ISSUE_AREA_SUBTYPES: { value: IssueAreaSubtype; label: string }[] = [
  { value: 'RECEPTION_DESK', label: 'Quầy lễ tân' },
  { value: 'SOFA', label: 'Sofa' },
  { value: 'FLOOR', label: 'Nền nhà' },
  { value: 'CEILING', label: 'Trần nhà' },
  { value: 'LIGHT_BULB', label: 'Bóng đèn' },
  { value: 'CLOCK', label: 'Đồng hồ' },
  { value: 'OTHER', label: 'Khác' },
];

export const ISSUE_AREA_SUBTYPE_LABEL: Record<IssueAreaSubtype, string> = Object.fromEntries(
  ISSUE_AREA_SUBTYPES.map((a) => [a.value, a.label]),
) as Record<IssueAreaSubtype, string>;

/** The workflow-state names, as the Technical tabs say them. */
export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  NEW: 'Sự cố khách sạn',
  IN_PROGRESS: 'Đang sửa',
  COMPLETED: 'Đã hoàn thành',
};

/**
 * WHICH FIELDS EACH AREA USES — the mirror of `server/src/issue/issueArea.ts`.
 *
 * This copy decides which inputs are RENDERED. It does not decide what is
 * VALID: the server re-derives the same rule and refuses a bad combination, so a
 * request that skips the form is refused too.
 */
export interface AreaFields {
  roomNumber: boolean;
  floorNumber: boolean;
  areaSubtype: boolean;
  category: boolean;
}

export const AREA_FIELDS: Record<IssueAreaCategory, AreaFields> = {
  ROOM: { roomNumber: true, floorNumber: false, areaSubtype: false, category: true },
  LOBBY: { roomNumber: false, floorNumber: false, areaSubtype: true, category: false },
  HALLWAY: { roomNumber: false, floorNumber: true, areaSubtype: false, category: false },
  STAIRCASE: { roomNumber: false, floorNumber: true, areaSubtype: false, category: false },
  RESTAURANT: { roomNumber: false, floorNumber: false, areaSubtype: false, category: true },
  ROOFTOP: { roomNumber: false, floorNumber: false, areaSubtype: false, category: true },
  OTHER_AREA: { roomNumber: false, floorNumber: false, areaSubtype: false, category: true },
};

/** "Không có trong danh sách" always has to say which thing it is. */
export function requiresLocationDetail(
  area: IssueAreaCategory,
  subtype: IssueAreaSubtype | '',
): boolean {
  return area === 'OTHER_AREA' || (area === 'LOBBY' && subtype === 'OTHER');
}

/** How one technician's attempt at an incident ended. Null while it is open. */
export type RepairOutcome = 'COMPLETED' | 'CANNOT_REPAIR';

export const REPAIR_OUTCOME_LABEL: Record<RepairOutcome, string> = {
  COMPLETED: 'Hoàn thành',
  CANNOT_REPAIR: 'Không sửa được',
};

/**
 * One attempt at an incident — the audit trail the "Không sửa được" flow exists
 * to keep.
 *
 * `durationLabel` is built by the SERVER, not here: the same number has to read
 * identically on this card, on the Admin monitor and in the exported PDF, and
 * the PDF is built server-side.
 */
export interface RepairAttempt {
  id: string;
  attemptNumber: number;
  technicianName: string;
  technicianPhone: string;
  acceptedByName: string | null;
  acceptedAt: string;
  outcome: RepairOutcome | null;
  outcomeAt: string | null;
  reason: string | null;
  durationSeconds: number | null;
  durationLabel: string | null;
}

export interface Issue {
  id: string;
  branchId: number;
  branch: Branch | null;
  areaCategory: IssueAreaCategory | null;
  roomNumber: string | null;
  floorNumber: string | null;
  areaSubtype: IssueAreaSubtype | null;
  locationDetail: string | null;
  /** The place as one line, built by the server so every screen agrees. */
  locationLabel: string;
  category: IssueCategory | null;
  description: string;
  photoUrl: string | null;
  status: IssueStatus;
  reportedBy: Actor | null;
  reportedByName: string | null;
  acceptedBy: Actor | null;
  acceptedByName: string | null;
  acceptedAt: string | null;
  technicianName: string | null;
  technicianPhone: string | null;
  completedBy: Actor | null;
  completedByName: string | null;
  completedAt: string | null;
  /** Which shift reported it, when the reporter was on one. */
  shiftType: string | null;
  shiftReceptionistName: string | null;
  /** The CURRENT assignment's elapsed time — running while it is being worked. */
  durationSeconds: number | null;
  durationLabel: string | null;
  /** Every attempt anybody has made. Empty on incidents worked before attempts existed. */
  attempts: RepairAttempt[];
  cannotRepairCount: number;
  /**
   * Back in the queue after somebody tried and could not fix it.
   *
   * `status` alone cannot say this — a fresh report and a returned one are both
   * NEW — so the server derives the difference and the queue renders it as
   * "Cần xử lý lại".
   */
  needsRework: boolean;
  /** What the desk corrected after filing ("Sửa vấn đề"), oldest first. */
  edits: IssueEdit[];
  createdAt: string;
  updatedAt: string;
}

/** One corrected field: the words that were there, the words that replaced them, who and when. */
export interface IssueEdit {
  id: string;
  field: string;
  fieldLabel: string;
  oldValue: string | null;
  newValue: string | null;
  actorName: string;
  createdAt: string;
}

/** Every field "Sửa vấn đề" may change; anything not sent is left alone. */
export interface UpdateIssueInput {
  areaCategory?: IssueAreaCategory;
  roomNumber?: string | null;
  floorNumber?: string | null;
  areaSubtype?: IssueAreaSubtype | null;
  locationDetail?: string | null;
  category?: IssueCategory | null;
  description?: string;
}

/** Technical's "Thống kê" — counts over the incidents that exist, nothing else. */
export interface IncidentStatistics {
  period: { days: number; from: string; to: string };
  totals: { total: number; newCount: number; inProgressCount: number; completedCount: number; needsReworkCount: number };
  outstanding: { total: number; newCount: number; inProgressCount: number };
  byStatus: { status: IssueStatus; label: string; count: number }[];
  byArea: { key: string; label: string; count: number }[];
  byCategory: { key: string; label: string; count: number }[];
  byBranch: {
    branchId: number;
    branchNumber: number;
    address: string;
    hotelName: string;
    total: number;
    open: number;
    completed: number;
  }[];
  workload: {
    attempts: number;
    completedAttempts: number;
    cannotRepairAttempts: number;
    openAttempts: number;
    averageSeconds: number | null;
    averageLabel: string | null;
    byTechnician: { name: string; attempts: number; completed: number; cannotRepair: number }[];
  };
  trend: { date: string; reported: number; completed: number }[];
}

/** The fault type, or an em dash for the areas that are not asked for one. */
export function issueCategoryLabel(issue: Pick<Issue, 'category'>): string {
  return issue.category ? ISSUE_CATEGORY_LABEL[issue.category] : '—';
}

export interface IssueListResponse {
  issues: Issue[];
  pagination: Pagination;
}

/** Unresolved (NEW + IN_PROGRESS) counters for one branch. */
export interface BranchIssueSummary {
  branchId: number;
  code: string;
  address: string;
  hotelName: string;
  newCount: number;
  inProgressCount: number;
  totalUnresolved: number;
}

/** Unresolved-issue summary within the caller's branch scope. */
export interface IssueSummary {
  totalUnresolved: number;
  newCount: number;
  inProgressCount: number;
  byBranch: BranchIssueSummary[];
}

/** The three queue totals, counted server-side across every branch. */
export interface TechnicalCounts {
  newCount: number;
  inProgressCount: number;
  completedCount: number;
}

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export interface NewIssueInput {
  areaCategory: IssueAreaCategory;
  description: string;
  category?: IssueCategory;
  roomNumber?: string;
  floorNumber?: string;
  areaSubtype?: IssueAreaSubtype;
  locationDetail?: string;
  photo?: File;
}

export interface AcceptIssueInput {
  technicianName: string;
  technicianPhone: string;
}

export const issuesApi = {
  /**
   * `from`/`to` and `outstanding` are OMITTED unless the caller asks for them,
   * and `query()` drops undefined keys — so the default request is byte for byte
   * the one this endpoint has always received.
   */
  list: (
    params: {
      branchId?: number;
      status?: IssueStatus;
      areaCategory?: IssueAreaCategory;
      from?: string;
      to?: string;
      outstanding?: boolean;
      page?: number;
      pageSize?: number;
    } = {},
  ) => {
    const { outstanding, ...rest } = params;
    return api.get<IssueListResponse>(
      `/issues${query({ ...rest, outstanding: outstanding ? 'true' : undefined })}`,
    );
  },

  detail: (id: string) => api.get<{ issue: Issue }>(`/issues/${id}`),

  create: (input: NewIssueInput) => {
    const form = new FormData();
    form.append('areaCategory', input.areaCategory);
    form.append('description', input.description);
    // Only the fields this area actually uses are sent; the server drops any
    // that do not belong to it anyway.
    if (input.category) form.append('category', input.category);
    if (input.roomNumber?.trim()) form.append('roomNumber', input.roomNumber.trim());
    if (input.floorNumber?.trim()) form.append('floorNumber', input.floorNumber.trim());
    if (input.areaSubtype) form.append('areaSubtype', input.areaSubtype);
    if (input.locationDetail?.trim()) form.append('locationDetail', input.locationDetail.trim());
    if (input.photo) form.append('image', input.photo);
    return api.postForm<{ issue: Issue }>('/issues', form);
  },

  /** "Sửa vấn đề" — corrects an open incident; the server keeps the old words. */
  update: (id: string, input: UpdateIssueInput) => api.put<{ issue: Issue }>(`/issues/${id}`, input),

  statistics: (params: { days?: number; branchId?: number } = {}) =>
    api.get<{ statistics: IncidentStatistics }>(`/issues/statistics${query(params)}`),

  accept: (id: string, input: AcceptIssueInput) =>
    api.post<{ issue: Issue }>(`/issues/${id}/accept`, input),

  complete: (id: string) => api.post<{ issue: Issue }>(`/issues/${id}/complete`, {}),

  /** "Không sửa được" — back to the queue, with a reason that is required. */
  cannotRepair: (id: string, input: { reason: string }) =>
    api.post<{ issue: Issue }>(`/issues/${id}/cannot-repair`, input),

  summary: () => api.get<{ summary: IssueSummary }>('/issues/summary'),

  counts: (params: { branchId?: number } = {}) =>
    api.get<{ counts: TechnicalCounts }>(`/issues/counts${query(params)}`),
};
