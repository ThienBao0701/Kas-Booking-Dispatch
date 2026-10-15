/**
 * THE DAILY ROOM WORK, KPI AND REPORT — the client half of
 * \`server/src/routes/housekeepingWork.ts\`. Who may do what is the server's;
 * these are the shapes it answers with.
 */
import { api } from './client';
import type { RoomCollectionStatus, RoomIssueType } from './housekeeping';

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Chưa bắt đầu → Đã kiểm tra (chờ "Bắt đầu dọn") → Đang dọn → Hoàn thành. */
export type RoomWorkState = 'NOT_STARTED' | 'INSPECTED' | 'IN_PROGRESS' | 'COMPLETED';
export const ROOM_WORK_KEY = ['housekeeping', 'room-work'] as const;

export interface CatalogItem {
  code: string;
  label: string;
}

export interface RoomWorkCatalog {
  statusCodes: string[];
  states: Record<RoomWorkState, string>;
  linen: CatalogItem[];
  /** K / Q / T — shown as King / Queen / Twin. */
  linenSizes: CatalogItem[];
  quantities: CatalogItem[];
  replacements: CatalogItem[];
  /** "Ghi nhận đặc biệt": L/B, SO, DND, OOO, OS, LNL. */
  specialStatuses: (CatalogItem & { short: string })[];
  maxQuantity: number;
}

export interface CleaningForm {
  /** Per linen item: ONE type (K / Q / T) and how many — null only on a save from before counts. */
  linen: Record<string, { size: string; quantity: number | null }>;
  quantities: Record<string, number>;
  replaced: string[];
  /** The "Ghi nhận đặc biệt" ticked. */
  special: string[];
  note: string | null;
  savedAt?: string;
  savedByName?: string;
}

export interface TaskFinding {
  id: string;
  type: RoomIssueType;
  typeLabel: string;
  note: string | null;
  voided: boolean;
  /** Null for the worker: the money is on its own KPI screen. */
  collectionStatus: RoomCollectionStatus | null;
  collectionStatusLabel: string | null;
  amount: number | null;
  collectedByName: string | null;
  collectedAt: string | null;
}

export interface TaskEvent {
  id: string;
  type: string;
  label: string;
  actorName: string;
  actorRole: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

/** Where a work item is: a room, a shared area of a floor, or the Rooftop. */
export type WorkAreaKind = 'ROOM' | 'HALLWAY' | 'STAIRCASE' | 'OTHER' | 'ROOFTOP';

/**
 * Where a work item stands — the order the work goes in. Computed by the server
 * (`workAreas.workPhase`) from the record, so every screen says the same.
 */
export type WorkPhase =
  | 'UNCLAIMED'
  | 'ACCEPTED'
  | 'INSPECTING'
  | 'AWAITING_CLEANING'
  | 'CLEANING'
  | 'COMPLETED'
  | 'NO_CLEAN_PENDING'
  | 'NO_CLEAN'
  | 'VOIDED';

export const WORK_PHASE_ORDER: WorkPhase[] = [
  'UNCLAIMED',
  'ACCEPTED',
  'INSPECTING',
  'AWAITING_CLEANING',
  'CLEANING',
  'COMPLETED',
  'NO_CLEAN_PENDING',
  'NO_CLEAN',
];

/** "Việc cần làm" of a place: OUT / OC / VC (one at most) and/or "Khác". */
export type WorkTaskCode = 'OUT' | 'OC' | 'VC' | 'OTHER';

export interface RoomTask {
  id: string;
  branchId: number;
  branch: { id: number; code: string; hotelName: string; address: string; branchNumber: number };
  workDate: string;
  roomNumber: string;
  statusCode: string;
  priority: boolean;
  note: string | null;
  /* The work item (absent on an older server). */
  itemKey?: string;
  areaKind?: WorkAreaKind;
  areaKindLabel?: string;
  floor?: string | null;
  /** "Khu vực": "Phòng - 502", "Hành lang - Tầng 5". */
  areaLabel?: string;
  taskName?: string | null;
  /** "Việc cần làm": "OC", "Dọn lối đi". */
  taskLabel?: string;
  groupId?: string | null;
  /** The ticked codes (OUT / OC / VC and/or OTHER); an older item: its one code. */
  taskCodes?: string[];
  /** "Công việc N" — null for an item created before work groups existed. */
  workGroup?: { id: string; number: number; name: string | null } | null;
  /** "Không cần dọn": the housekeeper's request and the manager's decision. */
  noClean?: {
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    reason: string | null;
    requestedAt: string | null;
    requestedByName: string | null;
    decidedAt: string | null;
    decidedByName: string | null;
    decisionNote: string | null;
  } | null;
  phase?: WorkPhase;
  phaseLabel?: string;
  acceptedAt?: string | null;
  inspectionStartedAt?: string | null;
  inspectedAt?: string | null;
  inspectionNote?: string | null;
  assignee: { id: number; name: string } | null;
  state: RoomWorkState;
  stateLabel: string;
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  elapsedSeconds: number | null;
  inspection: {
    id: string;
    createdAt: string;
    inspectorId: number;
    inspectorName: string;
    findings: TaskFinding[];
  } | null;
  cleaning: CleaningForm | null;
  cleanedBy: { id: number; name: string } | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  voided: boolean;
  voidedAt: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  events: TaskEvent[];
  /** 1, 2, … — this room's cleaning cycle that business day. */
  cycleNumber: number;
  /** "Cần dọn lại": the failed cycle this one repeats, and the manager's reason. */
  reclean: { taskId: string; cycleNumber: number; reason: string | null; reviewedByName: string | null; reviewedAt: string | null } | null;
  /** Null before "Hoàn thành"; PENDING = "Chờ đánh giá"; then PASSED / FAILED, once. */
  review: {
    status: 'PENDING' | 'PASSED' | 'FAILED';
    label: string;
    reviewedAt: string | null;
    reviewedByName: string | null;
    failureReason: string | null;
    recleanRequested: boolean;
  } | null;
  /** The re-clean this cycle's "Không đạt" opened. */
  nextCycleId: string | null;
}

/** "Chọn khu vực": the branch's floors and rooms, from its own catalog. */
export interface WorkAreas {
  branchId: number;
  hasRoomCatalog: boolean;
  hasFloorCatalog: boolean;
  floors: { floor: string; label: string; rooms: string[] }[];
  /** Rooms no floor can be read for — listed, never hidden. */
  unplacedRooms: string[];
  unplacedLabel: string;
  sharedAreas: { kind: 'HALLWAY' | 'STAIRCASE' | 'OTHER'; label: string }[];
  /** Only the branches that have one. */
  hasRooftop?: boolean;
  rooftopLabel?: string;
  roomTaskCodes: { code: string; label: string }[];
}

/** One room / area of a work group as the form sends it. */
export interface GroupItemInput {
  areaKind: WorkAreaKind;
  roomNumber?: string;
  floor?: string;
  taskCodes: WorkTaskCode[];
  note?: string;
  priority?: boolean;
}

/** "Công việc N" — one or many rooms / areas, given out and accepted together. */
export interface WorkGroup {
  id: string;
  branchId: number;
  branch: { id: number; code: string; hotelName: string; address: string; branchNumber: number };
  workDate: string;
  number: number;
  title: string;
  name: string | null;
  assignee: { id: number; name: string } | null;
  acceptedAt: string | null;
  status: { code: 'UNASSIGNED' | 'ACCEPTED' | 'IN_PROGRESS' | 'DONE'; label: string };
  floors: string[];
  counts: { items: number; completed: number; noCleanPending: number };
  /** Every place, removed ones included (`voided`). */
  items: RoomTask[];
  createdByName: string;
  createdAt: string;
}

export interface WorkerHistory {
  workDate: string;
  items: RoomTask[];
  totals: { completed: number; noClean: number };
  shifts: WorkShiftLite[];
}

export interface ReviewInput {
  result: 'PASSED' | 'FAILED';
  reason?: string;
  reclean?: boolean;
  /** The re-clean's worker (of the branch); null = not assigned yet; omitted = this cycle's. */
  assigneeUserId?: number | null;
}

export interface KpiRow {
  userId: number;
  fullName: string;
  inspections: number;
  findings: number;
  collectedCount: number;
  pendingCount: number;
  uncollectibleCount: number;
  collectedAmount: number;
  pendingAmount: number;
}

export interface FindingLine {
  id: string;
  inspectionId: string;
  branch: { id: number; code: string; address: string; branchNumber: number };
  roomNumber: string;
  inspectorName: string;
  type: RoomIssueType;
  typeLabel: string;
  note: string | null;
  createdAt: string;
  collectionStatus: RoomCollectionStatus;
  collectionStatusLabel: string;
  amount: number | null;
  collectedByName: string | null;
  collectedAt: string | null;
}

export interface StaffProgressRow extends KpiRow {
  assigned: number;
  notStarted: number;
  /** "Đã kiểm tra" — inspected, cleaning not started. */
  inspected: number;
  inProgress: number;
  completed: number;
  completionRate: number;
}

export interface WorkShiftLite {
  id: string;
  user: { id: number; fullName: string };
  startedAt: string;
  endedAt: string | null;
  segments: { id: string; branch: { address: string; branchNumber: number }; staffName: string; startedAt: string; endedAt: string | null }[];
}

export interface Overview {
  workDate: string;
  rooms: { total: number; notStarted: number; inspected: number; inProgress: number; completed: number; priority: number; unassigned: number };
  working: { userId: number; name: string; branch: { address: string; branchNumber: number }; since: string }[];
  employees: { userId: number; name: string; assigned: number; inProgress: number; completed: number }[];
  inspections: number;
  findings: number;
  collectedAmount: number;
  pendingCollections: number;
}

export interface OperationsRow {
  branchLabel: string;
  workDate: string;
  employee: string;
  assigned: number;
  completed: number;
  completionRate: number;
  inspections: number;
  findings: number;
  avgCleaningSeconds: number | null;
  collectedAmount: number;
  pendingAmount: number;
  pendingCount: number;
  /** Findings marked "Không thu được" — a count: no amount is recorded for them. */
  uncollectibleCount: number;
  voided: number;
  notes: number;
}

export interface Period {
  from: string;
  to: string;
  branchId?: number;
}

/** "Loại báo cáo": the rooms' work and the inspections, or one of the two. */
export type ReportType = 'ALL' | 'CLEANING' | 'INSPECTION';

export const REPORT_TYPE_OPTIONS: { value: ReportType; label: string }[] = [
  { value: 'ALL', label: 'Tổng hợp vận hành' },
  { value: 'CLEANING', label: 'Công việc dọn phòng' },
  { value: 'INSPECTION', label: 'Kiểm phòng & thu tiền' },
];

/** The report's filters — applied by the server, to the screen and to both files alike. */
export interface ReportQuery extends Period {
  userId?: number;
  type?: ReportType;
  /** A room / area, a worker's name, or a finding's id. */
  q?: string;
}

export const roomWorkApi = {
  catalog: () => api.get<RoomWorkCatalog>('/housekeeping/catalog'),

  /* The manager (and the Admin, with a branch) */
  tasks: (p: { date: string; branchId?: number; includeVoided?: boolean }) =>
    api.get<{ tasks: RoomTask[] }>(`/housekeeping/manager/tasks${query({ ...p, includeVoided: p.includeVoided ? 'true' : undefined })}`),
  createTasks: (input: {
    branchId?: number;
    workDate: string;
    roomNumbers: string[];
    statusCode: string;
    priority?: boolean;
    note?: string;
    assigneeUserId?: number | null;
  }) => api.post<{ created: number; skipped: string[] }>('/housekeeping/manager/tasks', input),
  updateTask: (id: string, input: { statusCode?: string; taskCodes?: WorkTaskCode[]; priority?: boolean; note?: string | null }) =>
    api.patch<{ task: RoomTask }>(`/housekeeping/manager/tasks/${id}`, input),
  assign: (id: string, assigneeUserId: number | null) =>
    api.post<{ task: RoomTask }>(`/housekeeping/manager/tasks/${id}/assign`, { assigneeUserId }),
  /** "Đạt" / "Không đạt" (+ reason, + "Yêu cầu dọn lại"). */
  review: (id: string, input: ReviewInput) =>
    api.post<{ task: RoomTask; reclean: RoomTask | null }>(`/housekeeping/manager/tasks/${id}/review`, input),
  /** Every cleaning cycle of the room that business day, in order. */
  history: (id: string) => api.get<{ cycles: RoomTask[] }>(`/housekeeping/manager/tasks/${id}/history`),
  /** "Chọn khu vực". */
  areas: (p: { branchId?: number }) => api.get<{ areas: WorkAreas }>(`/housekeeping/manager/areas${query({ ...p })}`),
  /** The day's work groups ("Công việc 1, 2, …") of the branch. */
  workGroups: (p: { date: string; branchId?: number }) =>
    api.get<{ groups: WorkGroup[] }>(`/housekeeping/manager/work-groups${query({ ...p })}`),
  /** "Tạo công việc": one group, its places; `requestId` makes a repeat harmless. */
  createWorkGroup: (input: { branchId?: number; workDate: string; requestId: string; name?: string; items: GroupItemInput[] }) =>
    api.post<{ duplicate: boolean; group: WorkGroup }>('/housekeeping/manager/work-groups', input),
  renameWorkGroup: (id: string, name: string | null) => api.patch<{ group: WorkGroup }>(`/housekeeping/manager/work-groups/${id}`, { name }),
  addWorkGroupItems: (id: string, items: GroupItemInput[]) =>
    api.post<{ group: WorkGroup }>(`/housekeeping/manager/work-groups/${id}/items`, { items }),
  assignWorkGroup: (id: string, assigneeUserId: number | null) =>
    api.post<{ group: WorkGroup }>(`/housekeeping/manager/work-groups/${id}/assign`, { assigneeUserId }),
  /** "Không cần dọn": approve (the place leaves the work) or reject (back to work). */
  decideNoClean: (id: string, approve: boolean, note?: string) =>
    api.post<{ task: RoomTask }>(`/housekeeping/manager/tasks/${id}/no-clean-decision`, note ? { approve, note } : { approve }),
  /** "Các công việc trong ngày" for the reception managers (their branches). */
  workOrders: (p: { date: string; branchId?: number }) =>
    api.get<{ tasks: RoomTask[] }>(`/housekeeping/work-orders${query({ ...p })}`),
  workOrderStaff: (branchId: number) =>
    api.get<{ staff: { id: number; fullName: string }[] }>(`/housekeeping/work-orders/staff?branchId=${branchId}`),
  /** "Giao lại" an item inspected and waiting for cleaning. */
  reassign: (id: string, input: { assigneeUserId: number; reason?: string }) =>
    api.post<{ task: RoomTask }>(`/housekeeping/work-orders/${id}/reassign`, input),
  voidTask: (id: string, reason?: string) =>
    api.post<{ voided: true }>(`/housekeeping/manager/tasks/${id}/void`, reason ? { reason } : {}),
  /** The branch's own Buồng phòng accounts (the Admin without a branch: all of them). */
  staff: (p: { branchId?: number } = {}) =>
    api.get<{ staff: { id: number; fullName: string }[] }>(`/housekeeping/manager/staff${query({ ...p })}`),
  overview: (p: { date: string; branchId?: number }) => api.get<Overview>(`/housekeeping/manager/overview${query({ ...p })}`),
  staffProgress: (p: Period) => api.get<{ rows: StaffProgressRow[] }>(`/housekeeping/manager/staff-progress${query({ ...p })}`),
  staffDetail: (userId: number, p: Period) =>
    api.get<{
      employee: { id: number; fullName: string };
      kpi: KpiRow;
      tasks: RoomTask[];
      findings: FindingLine[];
      shifts: WorkShiftLite[];
    }>(`/housekeeping/manager/staff/${userId}${query({ ...p })}`),
  kpi: (p: Period & { userId?: number; status?: RoomCollectionStatus }) =>
    api.get<{ rows: KpiRow[]; totals: Omit<KpiRow, 'userId' | 'fullName'>; findings: FindingLine[] }>(
      `/housekeeping/manager/kpi${query({ ...p })}`,
    ),
  report: (p: ReportQuery) =>
    api.get<{
      from: string;
      to: string;
      filters: { type: ReportType; typeLabel: string; employee: string | null; q: string | null };
      rows: OperationsRow[];
      findings: FindingLine[];
    }>(`/housekeeping/manager/report${query({ ...p, type: p.type === 'ALL' ? undefined : p.type })}`),

  /* The worker */
  myTasks: (date: string) => api.get<{ tasks: RoomTask[] }>(`/housekeeping/work?date=${date}`),
  /** The items of the open shift's branch: one's own and the unclaimed. `working` false: no shift yet. */
  workItems: (date: string) => api.get<{ working: boolean; tasks: RoomTask[] }>(`/housekeeping/work/items?date=${date}`),
  /** The day's work groups at the shift's branch, and who holds each. `working` false: no shift. */
  workerGroups: (date: string) => api.get<{ working: boolean; groups: WorkGroup[] }>(`/housekeeping/work/groups?date=${date}`),
  /** "Nhận công việc": the whole group. */
  acceptGroup: (id: string) => api.post<{ group: WorkGroup }>(`/housekeeping/work/groups/${id}/accept`, {}),
  /** "Không cần dọn" for one room, with the reason. */
  requestNoClean: (id: string, reason: string) => api.post<{ task: RoomTask }>(`/housekeeping/work/tasks/${id}/no-clean`, { reason }),
  /** The housekeeper's own finished work of a day. */
  workerHistory: (date: string) => api.get<WorkerHistory>(`/housekeeping/work/history?date=${date}`),
  /** "Nhận" (an item created before work groups): exactly these items, all or none. */
  claim: (taskIds: string[]) => api.post<{ tasks: RoomTask[] }>('/housekeeping/work/claim', { taskIds }),
  /** "Kiểm tra": the inspection begins. */
  beginInspection: (id: string) => api.post<{ task: RoomTask }>(`/housekeeping/work/tasks/${id}/begin-inspection`, {}),
  task: (id: string) => api.get<{ task: RoomTask }>(`/housekeeping/work/tasks/${id}`),
  open: (id: string) => api.post<{ task: RoomTask }>(`/housekeeping/work/tasks/${id}/open`, {}),
  inspect: (id: string, issues: { type: RoomIssueType; note?: string }[], note?: string) =>
    api.post<{ task: RoomTask }>(`/housekeeping/work/tasks/${id}/inspect`, note ? { issues, note } : { issues }),
  /** "Bắt đầu dọn" — the one action that starts the cleaning time. */
  start: (id: string) => api.post<{ task: RoomTask }>(`/housekeeping/work/tasks/${id}/start`, {}),
  saveCleaning: (id: string, form: CleaningForm) => api.put<{ task: RoomTask }>(`/housekeeping/work/tasks/${id}/cleaning`, form),
  complete: (id: string, form: CleaningForm) => api.post<{ task: RoomTask }>(`/housekeeping/work/tasks/${id}/complete`, form),
  myKpi: (p: { from: string; to: string }) =>
    api.get<{ summary: KpiRow; findings: FindingLine[] }>(`/housekeeping/kpi/me${query({ ...p })}`),
};

/** The report files, opened as ordinary links — with the very filters the screen shows. */
export function housekeepingReportUrl(kind: 'pdf' | 'xlsx', p: ReportQuery): string {
  return `/api/housekeeping/manager/report.${kind}${query({ ...p, type: p.type === 'ALL' ? undefined : p.type })}`;
}

/** "42 phút", "1 giờ 5 phút". */
export function formatMinutes(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} phút`;
  return `${Math.floor(minutes / 60)} giờ ${minutes % 60} phút`;
}
