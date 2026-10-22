/**
 * THE INCIDENT LIFECYCLE, AS EVERY SCREEN AND EXPORT SAYS IT.
 *
 *   RECEPTION        báo sự cố (Khu vực, Sự cố, Nguyên nhân — optional)
 *   TECHNICAL        Tiếp nhận → sửa → Hoàn thành (cause, result)
 *   A MANAGER        Xác nhận hoàn thành → closed; không đạt → back to the
 *                    queue, and the next Tiếp nhận opens a new attempt. Any one
 *                    of Admin, Tổng quản lý / Quản lý lễ tân, Quản lý / Tổng
 *                    quản lý kỹ thuật (capability `technical.confirmCompletion`)
 *
 * Kept apart from `issueService` on purpose: the summary counters, the
 * handover's pending-work list and the exports all need the vocabulary, and
 * none of them should have to import the service (and its shift and storage
 * dependencies) to learn what "Cần sửa lại" means.
 */
import type { InspectionResult, IssueStatus, Prisma } from '@prisma/client';

/* ------------------------------------------------------------------ *
 * Confirmation: always part of the workflow
 * ------------------------------------------------------------------ */

/**
 * WHETHER "XÁC NHẬN HOÀN THÀNH" IS PART OF THE WORKFLOW — it always is.
 *
 * A technician's "Hoàn thành" moves the incident to AWAITING_INSPECTION
 * ("Đã hoàn thành chờ quản lý xác nhận"), never to COMPLETED: the incident is
 * finally completed only when a manager confirms it, so the person who did the
 * work never signs it off. This used to be the dormant "Nghiệm thu" behind
 * `TECHNICAL_INSPECTION_ENABLED`; the flag is retired, and the function stays
 * as the single place every queue, counter and export asks — and what the API
 * tells a client (`inspectionEnabled`), so an older client still shows it.
 */
export function inspectionEnabled(): boolean {
  return true;
}

export const INSPECTION_RESULT_LABELS: Record<InspectionResult, string> = {
  PASSED: 'Đạt',
  FAILED: 'Không đạt',
};

/**
 * WHERE AN INCIDENT STANDS — one vocabulary, computed once, here.
 *
 *   WAITING               NEW, never worked                   "Chờ kỹ thuật"
 *   REWORK                NEW after an attempt (a failed       "Cần sửa lại"
 *                         inspection or a "Không sửa được")
 *   IN_PROGRESS           a technician is on it                "Đang sửa"
 *   AWAITING_INSPECTION   the technician finished; no manager  "Chờ quản lý xác nhận"
 *                         has confirmed it yet
 *   COMPLETED             a manager confirmed it (or it was    "Đã hoàn thành"
 *                         closed before confirmation existed)
 *
 * REWORK IS NOT A STATUS COLUMN. It is NEW in the database — the incident is
 * back in the queue for anyone to pick up — and it is told apart by its
 * history, which is the only honest source for "somebody already tried".
 */
export type IssueStage = 'WAITING' | 'REWORK' | 'IN_PROGRESS' | 'AWAITING_INSPECTION' | 'COMPLETED';

export const ISSUE_STAGE_LABELS: Record<IssueStage, string> = {
  WAITING: 'Chờ kỹ thuật',
  REWORK: 'Cần sửa lại',
  IN_PROGRESS: 'Đang sửa',
  AWAITING_INSPECTION: 'Chờ quản lý xác nhận',
  COMPLETED: 'Đã hoàn thành',
};

/**
 * "Xác nhận hoàn thành", for the incident as a whole.
 *
 *   PENDING   nothing has been confirmed yet (or the work is still going on)
 *   PASSED    a manager confirmed it — the incident is closed
 *   FAILED    a manager sent it back and the work is being redone
 *   NO_DATA   closed before confirmation existed: there is no record, and
 *             none is invented
 */
export type InspectionState = 'PENDING' | 'PASSED' | 'FAILED' | 'NO_DATA';

export const INSPECTION_STATE_LABELS: Record<InspectionState, string> = {
  PENDING: 'Chờ quản lý xác nhận',
  PASSED: 'Đã xác nhận',
  FAILED: 'Không đạt',
  NO_DATA: 'Không có dữ liệu',
};

/**
 * Everything not finished: the technician's queue — plus the manager's, when
 * inspection is part of the workflow.
 */
export function outstandingStatuses(): IssueStatus[] {
  return inspectionEnabled() ? ['NEW', 'IN_PROGRESS', 'AWAITING_INSPECTION'] : ['NEW', 'IN_PROGRESS'];
}

/**
 * Everything finished. While inspection is dormant, an incident a technician
 * finished during the trial of the inspection workflow (AWAITING_INSPECTION)
 * is finished too — the technician's "Hoàn thành" is the final word again, and
 * such a row must not sit forever in a queue nobody works.
 */
export function completedStatuses(): IssueStatus[] {
  return inspectionEnabled() ? ['COMPLETED'] : ['COMPLETED', 'AWAITING_INSPECTION'];
}

/**
 * Where-clause for one stage. WAITING and REWORK are both NEW in the database
 * and are told apart the only honest way — by whether anybody has worked it.
 */
export function stageWhere(stage: IssueStage): Prisma.HotelIssueWhereInput {
  switch (stage) {
    case 'WAITING':
      return { status: 'NEW', attempts: { none: {} } };
    case 'REWORK':
      return { status: 'NEW', attempts: { some: {} } };
    case 'COMPLETED':
      return { status: { in: completedStatuses() } };
    case 'AWAITING_INSPECTION':
      // No such queue while inspection is dormant — matches nothing.
      return inspectionEnabled() ? { status: 'AWAITING_INSPECTION' } : { id: { in: [] } };
    default:
      return { status: stage };
  }
}

export interface LifecycleInput {
  status: IssueStatus;
  /** "Nguyên nhân" as reported. */
  cause: string | null;
  /** The current assignment's technician — the only record on legacy rows. */
  technicianName: string | null;
  /** When a manager confirmed the finished repair; null before confirmation existed. */
  completionConfirmedAt?: Date | null;
  attempts: {
    attemptNumber: number;
    cause: string | null;
    inspectionResult: InspectionResult | null;
    technicianNameSnapshot: string;
  }[];
}

export function issueLifecycle(issue: LifecycleInput) {
  const attempts = [...issue.attempts].sort((a, b) => a.attemptNumber - b.attemptNumber);
  const last = attempts[attempts.length - 1];
  const lastInspected = [...attempts].reverse().find((a) => a.inspectionResult !== null);

  const stage: IssueStage =
    issue.status === 'NEW'
      ? attempts.length > 0
        ? 'REWORK'
        : 'WAITING'
      : issue.status === 'AWAITING_INSPECTION' && !inspectionEnabled()
        ? 'COMPLETED'
        : issue.status;

  const inspectionState: InspectionState =
    issue.status === 'COMPLETED'
      ? issue.completionConfirmedAt || last?.inspectionResult === 'PASSED'
        ? 'PASSED'
        : 'NO_DATA'
      : issue.status === 'AWAITING_INSPECTION'
        ? 'PENDING'
        : lastInspected?.inspectionResult === 'FAILED'
          ? 'FAILED'
          : 'PENDING';

  /*
    ONE CANONICAL CAUSE, READ — NEVER OVERWRITTEN. The latest technician's
    determination wins; until there is one, the reported cause stands. Both
    stay on file: the report on the incident, each determination on its attempt.
  */
  const determined = [...attempts].reverse().find((a) => a.cause?.trim());
  const cause = determined?.cause?.trim() || issue.cause?.trim() || null;

  return {
    stage,
    stageLabel: ISSUE_STAGE_LABELS[stage],
    inspectionState,
    inspectionLabel: INSPECTION_STATE_LABELS[inspectionState],
    cause,
    /**
     * "Người sửa": the latest attempt's technician, from the attempt itself —
     * or, on an incident worked before attempts existed (none were backfilled),
     * the technician its own columns name.
     */
    repairerName: last?.technicianNameSnapshot ?? issue.technicianName ?? null,
  };
}
