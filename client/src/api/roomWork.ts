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

export type RoomWorkState = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
export const ROOM_WORK_KEY = ['housekeeping', 'room-work'] as const;

export interface CatalogItem {
  code: string;
  label: string;
}

export interface RoomWorkCatalog {
  statusCodes: string[];
  states: Record<RoomWorkState, string>;
  linen: CatalogItem[];
  linenSizes: string[];
  quantities: CatalogItem[];
  replacements: CatalogItem[];
  maxQuantity: number;
}

export interface CleaningForm {
  linen: Record<string, string[]>;
  quantities: Record<string, number>;
  replaced: string[];
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

export interface RoomTask {
  id: string;
  branchId: number;
  branch: { id: number; code: string; hotelName: string; address: string; branchNumber: number };
  workDate: string;
  roomNumber: string;
  statusCode: string;
  priority: boolean;
  note: string | null;
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
  rooms: { total: number; notStarted: number; inProgress: number; completed: number; priority: number; unassigned: number };
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
  voided: number;
  notes: number;
}

export interface Period {
  from: string;
  to: string;
  branchId?: number;
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
  updateTask: (id: string, input: { statusCode?: string; priority?: boolean; note?: string | null }) =>
    api.patch<{ task: RoomTask }>(`/housekeeping/manager/tasks/${id}`, input),
  assign: (id: string, assigneeUserId: number | null) =>
    api.post<{ task: RoomTask }>(`/housekeeping/manager/tasks/${id}/assign`, { assigneeUserId }),
  voidTask: (id: string, reason?: string) =>
    api.post<{ voided: true }>(`/housekeeping/manager/tasks/${id}/void`, reason ? { reason } : {}),
  staff: () => api.get<{ staff: { id: number; fullName: string }[] }>('/housekeeping/manager/staff'),
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
  report: (p: Period) => api.get<{ from: string; to: string; rows: OperationsRow[] }>(`/housekeeping/manager/report${query({ ...p })}`),

  /* The worker */
  myTasks: (date: string) => api.get<{ tasks: RoomTask[] }>(`/housekeeping/work?date=${date}`),
  task: (id: string) => api.get<{ task: RoomTask }>(`/housekeeping/work/tasks/${id}`),
  open: (id: string) => api.post<{ task: RoomTask }>(`/housekeeping/work/tasks/${id}/open`, {}),
  inspect: (id: string, issues: { type: RoomIssueType; note?: string }[]) =>
    api.post<{ task: RoomTask }>(`/housekeeping/work/tasks/${id}/inspect`, { issues }),
  saveCleaning: (id: string, form: CleaningForm) => api.put<{ task: RoomTask }>(`/housekeeping/work/tasks/${id}/cleaning`, form),
  complete: (id: string, form: CleaningForm) => api.post<{ task: RoomTask }>(`/housekeeping/work/tasks/${id}/complete`, form),
  myKpi: (p: { from: string; to: string }) =>
    api.get<{ summary: KpiRow; findings: FindingLine[] }>(`/housekeeping/kpi/me${query({ ...p })}`),
};

/** The report files, opened as ordinary links. */
export function housekeepingReportUrl(kind: 'pdf' | 'xlsx', p: Period): string {
  return `/api/housekeeping/manager/report.${kind}${query({ ...p })}`;
}

/** "42 phút", "1 giờ 5 phút". */
export function formatMinutes(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} phút`;
  return `${Math.floor(minutes / 60)} giờ ${minutes % 60} phút`;
}
