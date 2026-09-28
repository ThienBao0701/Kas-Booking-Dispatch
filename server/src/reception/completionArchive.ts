/**
 * "HOÀN THÀNH VẤN ĐỀ" — the 12-hour completion archive, as a QUERY.
 *
 * Categories II (Request), III (facility incident) and IV (service quality)
 * follow one rule, decided by the server clock and nothing else:
 *
 *   not completed                          → ACTIVE, however old
 *   completed, received < 12 hours ago     → ACTIVE
 *   completed, received ≥ 12 hours ago     → ARCHIVE ("Hoàn thành vấn đề")
 *
 * "Received" is the ORIGINAL Reception timestamp — the journal row's
 * server-stamped `createdAt` (the incident's own `createdAt` for III) — never a
 * technician's acceptance or completion, a shift start or a browser clock.
 *
 * NOTHING MOVES. No row is copied, deleted or rewritten when it crosses the
 * line; it is simply matched by the other query. Its report time, completion,
 * employee, resolution, repair history and audit trail are exactly as they were.
 *
 * CROSS-SHIFT ON PURPOSE. The active set is the BRANCH's, not the open shift's:
 * a request taken on Ca A and still open on Ca B is Ca B's problem too, and a
 * completion from the last shift stays in view until it is 12 hours old. Branch
 * isolation is untouched — every query here starts from the caller's scope.
 *
 * Categories I (payments) and V (room service) are not part of this rule; they
 * stay scoped to the shift that recorded them.
 */
import type { IssueStatus, Prisma } from '@prisma/client';
import { completedStatuses, outstandingStatuses } from '../issue/issueLifecycle';

export const COMPLETION_ARCHIVE_HOURS = 12;

/** The instant a completed record received at or before it belongs in the archive. */
export function archiveCutoff(now: Date): Date {
  return new Date(now.getTime() - COMPLETION_ARCHIVE_HOURS * 60 * 60 * 1000);
}

/** The journal categories the rule applies to (III lives on HotelIssue). */
export const ARCHIVABLE_CATEGORIES = ['GUEST_REQUEST', 'CUSTOMER_COMPLAINT'] as const;

/** A request or a service-quality report whose completion is stamped. */
const completedJournal: Prisma.ReceptionOperationalReportWhereInput = {
  OR: [
    { guestRequest: { is: { completedAt: { not: null } } } },
    { complaint: { is: { completedAt: { not: null } } } },
  ],
};

const unfinishedJournal: Prisma.ReceptionOperationalReportWhereInput = {
  OR: [
    { guestRequest: { is: { completedAt: null } } },
    { complaint: { is: { completedAt: null } } },
  ],
};

/**
 * II and IV, ACTIVE: every live record of the branch that is unfinished, or was
 * received within the last 12 hours.
 *
 * Plus the OPEN SHIFT's withdrawn rows, so a receptionist who voids an entry
 * still sees it struck through where it was — exactly as before — rather than
 * watching it vanish. "The open shift's" means both the rows it CREATED and
 * the rows it VOIDED: the active set is cross-shift, so Ca B can withdraw a
 * request Ca A recorded, and the void is Ca B's act even though the row's own
 * `shiftSessionId` stays Ca A's. The VOID audit row carries the shift the
 * void was made on. Other shifts' withdrawn rows are not the desk's business
 * any more and stay in the journal and the Admin's view.
 */
export function activeJournalWhere(
  scope: Prisma.ReceptionOperationalReportWhereInput,
  now: Date,
  currentShiftSessionId?: string | null,
): Prisma.ReceptionOperationalReportWhereInput {
  const cutoff = archiveCutoff(now);
  return {
    AND: [
      scope,
      { category: { in: [...ARCHIVABLE_CATEGORIES] } },
      {
        OR: [
          { voidedAt: null, OR: [unfinishedJournal, { createdAt: { gt: cutoff } }] },
          ...(currentShiftSessionId
            ? [
                {
                  voidedAt: { not: null },
                  OR: [
                    { shiftSessionId: currentShiftSessionId },
                    { audits: { some: { action: 'VOID' as const, shiftSessionId: currentShiftSessionId } } },
                  ],
                },
              ]
            : []),
        ],
      },
    ],
  };
}

/**
 * The days a record was RECEIVED on — half-open [start, end) over Vietnamese
 * calendar days (`hcmRange`). It narrows the archive; it never widens it.
 */
export interface ReceivedWindow {
  start: Date;
  end: Date;
}

/**
 * II and IV, ARCHIVED: live, completed, and received at least 12 hours ago —
 * optionally only those RECEIVED within `received`. The window is ANDed onto
 * the eligibility rule, so a date can narrow the archive but can never admit a
 * record the 12-hour rule keeps active; and it is the original reception time
 * that is matched, never the completion.
 */
export function archivedJournalWhere(
  scope: Prisma.ReceptionOperationalReportWhereInput,
  now: Date,
  received?: ReceivedWindow | null,
): Prisma.ReceptionOperationalReportWhereInput {
  return {
    AND: [
      scope,
      { category: { in: [...ARCHIVABLE_CATEGORIES] } },
      { voidedAt: null, createdAt: { lte: archiveCutoff(now) } },
      completedJournal,
      ...(received ? [{ createdAt: { gte: received.start, lt: received.end } }] : []),
    ],
  };
}

/**
 * III, the same rule over the incidents themselves: outstanding at any age, or
 * finished and reported within the last 12 hours — "finished" meaning the
 * technician's "Hoàn thành" (or, when inspection is switched on, a pass).
 */
export function activeIssueWhere(now: Date): Prisma.HotelIssueWhereInput {
  return {
    OR: [
      { status: { in: outstandingStatuses() } },
      { status: { in: completedStatuses() }, createdAt: { gt: archiveCutoff(now) } },
    ],
  };
}

export function archivedIssueWhere(now: Date): Prisma.HotelIssueWhereInput {
  const finished: IssueStatus[] = completedStatuses();
  return { status: { in: finished }, createdAt: { lte: archiveCutoff(now) } };
}

/** How many archived rows one section returns — newest first; the total says if there are more. */
export const ARCHIVE_PAGE_SIZE = 200;

/**
 * How many ACTIVE rows one category returns — newest first. Unfinished rows
 * never age out, so the set has no natural bound; past this many, the response
 * carries each category's full count and the screen says how many it is not
 * showing, rather than dropping the oldest unfinished records silently.
 */
export const ACTIVE_PAGE_SIZE = 500;
