/**
 * THE INCIDENT LIFECYCLE, AS EVERY SCREEN AND EXPORT SAYS IT.
 *
 *   RECEPTION        báo sự cố (Khu vực, Sự cố, Nguyên nhân — optional)
 *   TECHNICAL        Tiếp nhận → sửa → Hoàn thành (cause, result)
 *   TECHNICAL_MANAGER  Nghiệm thu: đạt → closed; không đạt → back to the queue,
 *                    and the next Tiếp nhận opens a new attempt
 *
 * Kept apart from `issueService` on purpose: the summary counters, the
 * handover's pending-work list and the exports all need the vocabulary, and
 * none of them should have to import the service (and its shift and storage
 * dependencies) to learn what "Cần sửa lại" means.
 */
import type { InspectionResult, IssueStatus, Prisma } from '@prisma/client';
import { env } from '../config/env';

/* ------------------------------------------------------------------ *
 * Inspection: implemented, and DORMANT until switched on
 * ------------------------------------------------------------------ */

let inspectionOverride: boolean | null = null;

/**
 * TESTS ONLY — lets the inspection suite exercise the dormant workflow without
 * a process-wide environment change. `null` returns to the configured value.
 */
export function setInspectionEnabledForTests(value: boolean | null): void {
  inspectionOverride = value;
}

/**
 * WHETHER "NGHIỆM THU" IS PART OF THE ACTIVE WORKFLOW.
 *
 * Off by default (`TECHNICAL_INSPECTION_ENABLED`). While off, the operational
 * workflow is the one the hotel uses today — Tiếp nhận → sửa → Hoàn thành or
 * Không sửa được — and a technician's "Hoàn thành" CLOSES the incident. The
 * inspection code, columns and tests stay in place for the day it is switched
 * on; nothing here deletes or rewrites what was recorded while it was tried.
 */
export function inspectionEnabled(): boolean {
  return inspectionOverride ?? env.TECHNICAL_INSPECTION_ENABLED;
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
 *   AWAITING_INSPECTION   the technician finished; the         "Chờ nghiệm thu"
 *                         Technical Manager has not judged it
 *   COMPLETED             inspection passed (or completed      "Đã hoàn thành"
 *                         before inspection existed)
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
  AWAITING_INSPECTION: 'Chờ nghiệm thu',
  COMPLETED: 'Đã hoàn thành',
};

/**
 * "Nghiệm thu", for the incident as a whole.
 *
 *   PENDING   nothing has been judged yet (or the work is still going on)
 *   PASSED    the last inspection passed — the incident is closed
 *   FAILED    the last inspection failed and the work is being redone
 *   NO_DATA   completed before inspection existed: there is no record, and
 *             none is invented
 */
export type InspectionState = 'PENDING' | 'PASSED' | 'FAILED' | 'NO_DATA';

export const INSPECTION_STATE_LABELS: Record<InspectionState, string> = {
  PENDING: 'Chưa nghiệm thu',
  PASSED: 'Đạt',
  FAILED: 'Không đạt',
  NO_DATA: 'Chưa có dữ liệu',
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
      ? last?.inspectionResult === 'PASSED'
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
