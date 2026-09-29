/**
 * The lifecycle fields the SERVER derives for every incident (see
 * `server/src/issue/issueLifecycle.ts`), filled in for test fixtures.
 *
 * The server always sends `stage`, `stageLabel`, `inspectionState`,
 * `inspectionLabel`, `cause`, `reportedCause`, `repairerName` and
 * `reporterName`; a fixture that omits them describes a response the API
 * cannot produce. This mirrors the server's rule so a fixture written with just
 * a `status` still reads like a real response — and any field a test sets
 * explicitly wins.
 *
 * INSPECTION IS DORMANT BY DEFAULT, as it is on the server
 * (`TECHNICAL_INSPECTION_ENABLED` off): an AWAITING_INSPECTION row then reads
 * as "Đã hoàn thành". A fixture sets `inspectionEnabled: true` to describe the
 * server with inspection switched on.
 */
const STAGE_LABELS: Record<string, string> = {
  WAITING: 'Chờ kỹ thuật',
  REWORK: 'Cần sửa lại',
  IN_PROGRESS: 'Đang sửa',
  AWAITING_INSPECTION: 'Chờ nghiệm thu',
  COMPLETED: 'Đã hoàn thành',
};

const INSPECTION_LABELS: Record<string, string> = {
  PENDING: 'Chưa nghiệm thu',
  PASSED: 'Đạt',
  FAILED: 'Không đạt',
  NO_DATA: 'Chưa có dữ liệu',
};

interface FixtureAttempt {
  technicianName?: string;
  cause?: string | null;
  inspection?: { result: string } | null;
}

export function withLifecycle<T extends Record<string, unknown>>(issue: T) {
  const status = issue.status as string;
  const inspectionEnabled = (issue.inspectionEnabled as boolean | undefined) ?? false;
  const attempts = ((issue.attempts as FixtureAttempt[] | undefined) ?? []).map((a) => ({
    cause: null,
    result: null,
    inspection: null,
    ...a,
  }));
  const last = attempts[attempts.length - 1];
  const lastJudged = [...attempts].reverse().find((a) => a.inspection);

  const stage =
    (issue.stage as string | undefined) ??
    (status === 'NEW'
      ? attempts.length > 0 || issue.needsRework
        ? 'REWORK'
        : 'WAITING'
      : status === 'AWAITING_INSPECTION' && !inspectionEnabled
        ? 'COMPLETED'
        : status);
  const inspectionState =
    (issue.inspectionState as string | undefined) ??
    (status === 'COMPLETED'
      ? last?.inspection?.result === 'PASSED'
        ? 'PASSED'
        : 'NO_DATA'
      : status === 'AWAITING_INSPECTION'
        ? 'PENDING'
        : lastJudged?.inspection?.result === 'FAILED'
          ? 'FAILED'
          : 'PENDING');
  const reportedCause = (issue.reportedCause as string | null | undefined) ?? null;

  return {
    inspectionEnabled,
    reportedCause,
    cause: [...attempts].reverse().find((a) => a.cause)?.cause ?? reportedCause,
    repairerName: last?.technicianName ?? (issue.technicianName as string | null | undefined) ?? null,
    reporterName:
      (issue.shiftReceptionistName as string | null | undefined) ??
      (issue.reportedByName as string | null | undefined) ??
      null,
    ...issue,
    attempts,
    stage,
    stageLabel: (issue.stageLabel as string | undefined) ?? STAGE_LABELS[stage],
    inspectionState,
    inspectionLabel: (issue.inspectionLabel as string | undefined) ?? INSPECTION_LABELS[inspectionState],
  };
}
