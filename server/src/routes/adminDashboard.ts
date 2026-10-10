import { Router } from 'express';
import { prisma } from '../db/prisma';
import { requireAuth, requireAdmin, requirePasswordChanged } from '../middleware/auth';
import { getClock, hcmDateOnly } from '../lib/clock';
import { z } from 'zod';
import { computeStatistics } from '../booking/statistics';
import { NOT_DELETED } from '../booking/deleteBooking';
import { outstandingStatuses } from '../issue/issueLifecycle';

const HCM_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * An inclusive span of Asia/Ho_Chi_Minh calendar days, expressed in UTC as a
 * HALF-OPEN interval.
 *
 * Takes the days as strings rather than reading the clock, so the same function
 * serves "today", any date the Admin picks, and any range. The property's
 * timezone is what decides where a day starts — an operator asking for the 11th
 * means the 11th in Ho Chi Minh City, not in UTC.
 *
 * `to` is INCLUSIVE as a calendar day: the interval runs to the start of the day
 * AFTER it. A single day is simply `from === to`. Half-open is what keeps the
 * boundary exact — an order at 00:00:00.000 on `from` is in, and one at
 * 00:00:00.000 on the day after `to` is out, with no end-of-day millisecond to
 * get wrong.
 */
function hcmRange(from: string, to: string): { start: Date; end: Date } {
  const start = new Date(Date.parse(`${from}T00:00:00.000Z`) - HCM_OFFSET_MS);
  const lastDayStart = Date.parse(`${to}T00:00:00.000Z`) - HCM_OFFSET_MS;
  return { start, end: new Date(lastDayStart + 24 * 60 * 60 * 1000) };
}

function countByBranch(groups: { branchId: number | null; _count: { _all: number } }[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const g of groups) if (g.branchId != null) map.set(g.branchId, g._count._all);
  return map;
}

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The summary covers one day or an inclusive range of days.
 *
 * `date` is the original single-day parameter and still works exactly as it
 * did; `from`/`to` are the range form. Mixing them is refused rather than
 * resolved by precedence, because a request carrying both expresses two
 * different intentions and guessing which one wins is how a screen ends up
 * quietly showing a period nobody asked for.
 *
 * An inverted range is refused too. `{gte: start, lt: end}` with `from > to`
 * matches nothing, and Prisma runs it happily — so without this the operator
 * sees a page of zeroes and no reason for them.
 */
const summaryQuery = z
  .object({
    date: isoDay.optional(),
    from: isoDay.optional(),
    to: isoDay.optional(),
  })
  .refine((q) => !(q.date !== undefined && (q.from !== undefined || q.to !== undefined)), {
    message: 'Chọn một ngày hoặc một khoảng thời gian, không dùng cả hai.',
  })
  /*
    A range needs BOTH ends. Half a range was previously accepted and then
    completed from the clock, which quietly re-created the inverted scope the
    next refine exists to refuse: `?to=<a past day>` alone became
    from=today..to=<past day>, a self-contradictory window that matches nothing
    and returns a page of zeroes with a 200. Demanding both ends makes the
    inverted check below reachable in every case.
  */
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: 'Khoảng thời gian cần cả ngày bắt đầu và ngày kết thúc.',
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    // ISO days compare correctly as strings.
    message: 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.',
  });

/** Defaults to today when a range is not given. */
const statisticsQuery = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
  branchId: z.coerce.number().int().positive().optional(),
});

/**
 * The admin dashboard endpoints, so it never downloads all of history to count
 * things on the client. Everything is computed in the database, in the
 * property's timezone.
 */
export function createAdminDashboardRouter(): Router {
  const router = Router();
  router.use('/admin/dashboard', requireAuth, requirePasswordChanged, requireAdmin);

  router.get('/admin/dashboard/summary', (req, res, next) => {
    (async () => {
      /*
        EVERY NUMBER BELOW IS SCOPED TO ONE DAY, and which day is the Admin's
        choice. The filtering happens here in the database: the dashboard has
        never downloaded history to count it, and a date picker that re-filtered
        an already-loaded "today" payload could only ever show today.

        Omitting `date` keeps the endpoint's original behaviour exactly.
      */
      const query = summaryQuery.parse(req.query ?? {});
      const today = hcmDateOnly(getClock().now());
      const from = query.from ?? query.date ?? today;
      const to = query.to ?? query.date ?? from;
      const { start, end } = hcmRange(from, to);

      /*
        ══ ONE DATASET, AND EVERY NUMBER ON THE PAGE COMES OUT OF IT ══════════

        THE DEFECT THIS REPLACES. The four cards used to be counted on four
        different date axes: `waiting` was an open-ended backlog (`sentAt < end`
        with no lower bound), `confirmed` was scoped by `reviewedAt`, and
        `lastMinute` by `checkInDate` — only `sent` was scoped by `sentAt`. So
        "Tổng đơn gửi = 4" could sit beside a `waiting` of 40 counting orders
        dispatched weeks earlier, and the branch breakdown never summed to the
        total it was printed under. Four questions were being answered on one
        screen while looking like one.

        THE RULE NOW. The dashboard shows ONE population — the orders DISPATCHED
        inside the selected scope — and every counter is a property of that
        population. `sentAt` is the axis because dispatching is the act the
        dashboard is about; an order's check-in, review or creation date says
        when something else happened to it.

        Everything below therefore spreads `inScope`. A counter that needs a
        different date axis does not belong on this endpoint.
      */
      const inScope = { ...NOT_DELETED, sentAt: { gte: start, lt: end } };

      /*
        "Confirmed" counts PROOF APPROVALS, which is what it has always meant to
        an operator: the branch entered the reservation and an Admin verified it.
        It is deliberately NOT `status: COMPLETED` — since the two lifecycles
        were separated, COMPLETED means the guest's stay has ended, which is a
        different event days later.

        `reviewedAt: {not: null}` is what still carries that meaning now the
        window has moved to `sentAt`. It is not a tidy-up: a COMPLETED booking
        is APPROVED with no review behind it, so without this guard a finished
        stay would be counted as a proof somebody approved.
      */
      const confirmedInScope = {
        ...inScope,
        verificationStatus: 'APPROVED' as const,
        reviewedAt: { not: null },
      };
      /*
        Of the orders sent in this scope, the ones the BRANCH has still not
        created. An approved booking is no longer waiting for that — it is
        waiting to be received, which is reception's queue, not this counter.

        THIS IS A DELIBERATE CHANGE OF MEANING, and the operator-facing one.
        The card used to be a running backlog — every undelivered order ever
        dispatched — which is why it could read 40 under a "Tổng đơn gửi" of 4.
        It now answers "of what I sent in this period, what is still not done".
        The running backlog remains available in full on the "Chờ chi nhánh tạo"
        list itself, which is where an unbounded queue belongs.

        Note this reads TODAY's verificationStatus. Reconstructing what was still
        outstanding at midnight on a past date would mean replaying the audit
        log, which is a different and much heavier feature than a date picker.
      */
      const awaitingCreation = {
        ...inScope,
        status: 'NEW' as const,
        verificationStatus: { not: 'APPROVED' as const },
      };

      /*
        LAST MINUTE reads the STORED FLAG, not the check-in date.

        `isLastMinute` is stamped at dispatch (`lib/clock.ts`): the check-in date
        equalled the day the order was sent. That is precisely "of the orders
        sent in this scope, how many were last minute", and it is stable — a past
        day's figure cannot drift as the calendar moves.

        Comparing `checkInDate` to the scope instead would answer a different
        question (arrivals during the period, whenever they were sent) and is
        meaningless across a multi-day range. The old clause also carried
        `status: NEW`, so a last-minute order reception had already received
        silently stopped counting; membership of this population is decided by
        dispatch alone, so that filter is gone.
      */
      const lastMinute = { ...inScope, isLastMinute: true };

      const [
        branches,
        waitingGroups,
        confirmedGroups,
        lastMinuteGroups,
        sentGroups,
        waitingTotal,
        confirmedTotal,
        sentTotal,
        lastMinuteTotal,
        issuesReported,
        issuesStillOpen,
      ] = await Promise.all([
        prisma.branch.findMany({ where: { active: true }, orderBy: { id: 'asc' } }),
        prisma.booking.groupBy({ by: ['branchId'], where: awaitingCreation, _count: { _all: true }, orderBy: { branchId: 'asc' } }),
        prisma.booking.groupBy({ by: ['branchId'], where: confirmedInScope, _count: { _all: true }, orderBy: { branchId: 'asc' } }),
        prisma.booking.groupBy({ by: ['branchId'], where: lastMinute, _count: { _all: true }, orderBy: { branchId: 'asc' } }),
        /*
          The breakdown's own "đã gửi", from the same population as the total
          above it. Without it the section had no column that summed to "Tổng
          đơn gửi", so the two halves of the page could not be reconciled by
          eye — which is the discrepancy this whole change is about.
        */
        prisma.booking.groupBy({ by: ['branchId'], where: inScope, _count: { _all: true }, orderBy: { branchId: 'asc' } }),
        prisma.booking.count({ where: awaitingCreation }),
        prisma.booking.count({ where: confirmedInScope }),
        prisma.booking.count({ where: inScope }),
        prisma.booking.count({ where: lastMinute }),
        /*
          Issues REPORTED in the selected scope, and how many of those are still
          open — a genuinely scoped figure, unlike a running backlog total.

          `createdAt` and not `sentAt`: an issue is not dispatched and has no
          such column. It is the same QUESTION as the cards above — what happened
          in this period — measured on the only date an issue has, and it moves
          with the selected window so the two halves of the card agree.

          Counted here rather than by extending `computeIssueSummary`, which the
          sidebar badge and the Issues page both call and which must keep meaning
          "open right now". One shared function serving two different questions is
          how a badge starts disagreeing with the page it links to.
        */
        prisma.hotelIssue.count({ where: { voidedAt: null, createdAt: { gte: start, lt: end } } }),
        prisma.hotelIssue.count({
          where: { voidedAt: null, createdAt: { gte: start, lt: end }, status: { in: outstandingStatuses() } },
        }),
      ]);

      const waiting = countByBranch(waitingGroups);
      const confirmed = countByBranch(confirmedGroups);
      const lastMin = countByBranch(lastMinuteGroups);
      const sentPerBranch = countByBranch(sentGroups);

      res.json({
        /*
          The scope these numbers describe, resolved server-side and echoed back,
          so an operator can never be looking at one period and reading another's
          figures. `date` is kept as the first day of the scope: it is the
          original field, it is what a single-day request means, and existing
          callers reading it keep working.
        */
        date: from,
        range: { from, to },
        totals: {
          waiting: waitingTotal,
          confirmedToday: confirmedTotal,
          lastMinute: lastMinuteTotal,
          sentToday: sentTotal,
        },
        issues: { reported: issuesReported, stillOpen: issuesStillOpen },
        branches: branches.map((b) => ({
          branch: { id: b.id, code: b.code, hotelName: b.hotelName, address: b.address },
          waiting: waiting.get(b.id) ?? 0,
          confirmedToday: confirmed.get(b.id) ?? 0,
          lastMinute: lastMin.get(b.id) ?? 0,
          sent: sentPerBranch.get(b.id) ?? 0,
        })),
      });
    })().catch(next);
  });

  /**
   * GET /api/admin/dashboard/statistics — revenue and operational rates.
   *
   * A separate endpoint from the summary above, which answers "what needs
   * attention right now". This answers "how did a period go", so it takes a
   * range and is not recomputed on every dashboard poll.
   */
  router.get('/admin/dashboard/statistics', (req, res, next) => {
    (async () => {
      const today = hcmDateOnly(getClock().now());
      const query = statisticsQuery.parse(req.query);
      res.json(
        await computeStatistics({
          from: query.from ?? today,
          to: query.to ?? today,
          branchId: query.branchId,
        }),
      );
    })().catch(next);
  });

  return router;
}
