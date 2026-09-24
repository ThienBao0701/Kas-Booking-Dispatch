import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { getClock } from '../lib/clock';
import { requireAuth, requireAdmin, requirePasswordChanged } from '../middleware/auth';
import {
  buildRecreationReport,
  hcmRange,
  serializeRecreationRow,
} from '../booking/recreationReport';
import { buildRecreationReportPdf, recreationReportFileName } from '../report/recreationPdf';
import { buildIncidentReportPdf, incidentReportFileName } from '../report/incidentPdf';
import { contentDisposition } from '../report/format';
import { buildHandoverReportPdf, handoverReportFileName } from '../report/handoverPdf';
import { buildChatReportPdf, chatReportFileName } from '../report/chatPdf';
import { ISSUE_INCLUDE, serializeIssue } from '../issue/issueService';
import { computeIncidentRangeSummary } from '../issue/issueSummary';
import { countHandovers, listHandovers, serializeHandover } from '../shift/handoverService';
import {
  countHandoverNotes,
  listHandoverNotes,
  serializeHandoverNote,
} from '../shift/handoverNoteService';
import { listConversations } from '../chat/chatService';
import { operationalReport } from '../reception/operationalReport';
import { countByCategory, countReports, listReports, serializeReport } from '../reception/reportService';
import { sessionsCashSummary } from '../reception/cashService';
import {
  OPEN_SHIFT_WARNING,
  openShiftNotices,
  sessionsForBusinessDates,
} from '../reception/businessDate';
import { hcmDateOnly } from '../lib/clock';
import { buildOperationalReportPdf } from '../report/operationalPdf';
import { buildOperationalReportWorkbook } from '../report/operationalExcel';
import type { Response } from 'express';

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải theo định dạng YYYY-MM-DD.');

/**
 * Both reports take the SAME range shape as the dashboard and History, so an
 * operator never has to learn a second way of asking for a period. `from <= to`
 * is refused rather than silently swapped: an inverted range matches nothing,
 * and a report that is blank for that reason is indistinguishable from a period
 * in which nothing happened.
 */
const rangeQuery = z
  .object({
    from: isoDay,
    to: isoDay,
    branchId: z.coerce.number().int().positive().optional(),
  })
  .refine((q) => q.from <= q.to, {
    message: 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.',
    path: ['from'],
  });

const recreationQuery = rangeQuery.and(
  z.object({
    shiftType: z.enum(['A', 'B', 'C', 'A4', 'C4']).optional(),
    receptionistUserId: z.coerce.number().int().positive().optional(),
    source: z.enum(['BOOKING_COM', 'AGODA', 'CTRIP']).optional(),
  }),
);

/*
  The incident report reads the SAME payload the incident screens do.

  This used to be a second, hand-copied include. The two were identical the day
  it was written and silently diverged the moment a relation was added to one of
  them — the report then type-checked against a shape the database no longer
  returned it, and lost the repair history without failing.
*/

/** The chat audit view narrows by what a category and a submission mode are. */
const chatQuery = rangeQuery.and(
  z.object({
    category: z.enum(['ROOM', 'WORK_ENVIRONMENT', 'INTERNAL']).optional(),
    anonymous: z.enum(['true', 'false']).optional(),
  }),
);

/**
 * The four PDF headers, written once.
 *
 * `no-store` because these files name people and say what they did; `nosniff`
 * so a stored report cannot be coerced into executing as something else.
 */
const reportCategory = z.enum([
  'PAYMENT',
  'GUEST_REQUEST',
  'FACILITY_ISSUE',
  'CUSTOMER_COMPLAINT',
  'ROOM_SERVICE',
]);

/**
 * The export's scope: the same period, branch and category the screen shows.
 *
 * The category used to be absent here, so a PDF exported while looking at
 * "Theo dõi thanh toán" contained every category — a file that disagreed with
 * the screen it was exported from.
 */
const operationalExportQuery = rangeQuery.and(z.object({ category: reportCategory.optional() }));

/**
 * The Admin drill-down: khoảng thời gian · chi nhánh · danh mục → bản ghi.
 *
 * DELIBERATELY FEW FILTERS. No employee filter, no status filter, no source
 * filter, no query builder — a period, a branch, a category and then every
 * record. Each extra control is one more way to be looking at a subset while
 * believing you are looking at everything.
 */
const drillDownQuery = z
  .object({
    branchId: z.coerce.number().int().positive().optional(),
    category: reportCategory.optional(),
    from: isoDay.optional(),
    to: isoDay.optional(),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: 'Cần chọn cả ngày bắt đầu và ngày kết thúc.',
    path: ['to'],
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.',
    path: ['from'],
  });

function operationalFileName(from: string, to: string, ext: 'pdf' | 'xlsx'): string {
  return `KAS-bao-cao-van-de-le-tan-${from}-${to}.${ext}`;
}

function sendPdf(res: Response, pdf: Buffer, fileName: string): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDisposition(fileName));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(pdf);
}

/**
 * The period's handovers and notes, WITH the true totals beside them.
 *
 * The lists are capped at 1000 rows, and the cap used to be invisible: the
 * report printed `rows.length` as the period's total, so a quarterly audit said
 * "Tổng số bàn giao: 1000" while omitting everything older than the thousandth
 * newest row. The counts come from their own queries so the figure is right even
 * when the listing is not the whole story, and `truncated` lets the report say
 * so out loud rather than pretending.
 */
const REPORT_ROW_CAP = 1000;

async function loadHandovers(q: { from: string; to: string; branchId?: number }) {
  const { start, end } = hcmRange(q.from, q.to);
  // An Admin actor, so the branch filter is the query's rather than an
  // account's — this router is admin-gated on its prefix.
  const adminActor = { id: 0, role: 'ADMIN' as const, branchId: null, fullName: '' };
  const range = { start, end, branchId: q.branchId };
  const [handovers, notes, handoverTotal, noteTotal] = await Promise.all([
    listHandovers({ ...range, take: REPORT_ROW_CAP }),
    listHandoverNotes(adminActor, { ...range, take: REPORT_ROW_CAP }),
    countHandovers(range),
    countHandoverNotes(adminActor, range),
  ]);
  return {
    handovers,
    notes,
    handoverTotal,
    noteTotal,
    truncated: handoverTotal > handovers.length || noteTotal > notes.length,
  };
}

/**
 * Chat threads in the period, filtered in JavaScript over the SERIALIZED views.
 *
 * Deliberately not a database filter on the raw rows: `listConversations` is
 * what applies the anonymity rule, and going around it to build a report would
 * be exactly the second read path that rule cannot afford. The Admin's list is
 * a few hundred threads at most, so the cost of filtering after serialization is
 * nothing next to the cost of a report that forgot to suppress a name.
 */
async function loadChat(q: {
  from: string;
  to: string;
  branchId?: number;
  category?: string;
  anonymous?: string;
}) {
  const { start, end } = hcmRange(q.from, q.to);
  const all = await listConversations({ id: 0, role: 'ADMIN', branchId: null });
  return all.filter((c) => {
    const at = Date.parse(c.createdAt);
    if (at < start.getTime() || at >= end.getTime()) return false;
    if (q.branchId !== undefined && c.branch?.id !== q.branchId) return false;
    if (q.category && c.category !== q.category) return false;
    if (q.anonymous !== undefined && c.anonymous !== (q.anonymous === 'true')) return false;
    return true;
  });
}

async function scopeLabel(branchId: number | undefined): Promise<string> {
  if (branchId === undefined) return 'Tất cả chi nhánh';
  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  return branch ? `${branch.code} — ${branch.address}` : `Chi nhánh #${branchId}`;
}

/**
 * Admin reporting: the "Cần tạo lại" accountability report and the hotel
 * incident report, each as JSON for the screen and PDF for the file.
 *
 * MONITORING ONLY. Nothing in this router mutates anything — an Admin reads and
 * exports, and never performs a technical transition. That rule is enforced by
 * there being no write endpoint here at all, not merely by hiding a button.
 */
export function createAdminReportsRouter(): Router {
  const router = Router();

  router.use('/admin/reports', requireAuth, requirePasswordChanged, requireAdmin);

  // GET /api/admin/reports/recreations — JSON for the screen.
  router.get('/admin/reports/recreations', (req, res, next) => {
    (async () => {
      const q = recreationQuery.parse(req.query);
      const report = await buildRecreationReport(q);
      res.json({
        range: report.range,
        rows: report.rows.map(serializeRecreationRow),
        totals: {
          total: report.totals.total,
          byBranch: Object.fromEntries(report.totals.byBranch),
          byShift: Object.fromEntries(report.totals.byShift),
          byReceptionist: Object.fromEntries(report.totals.byReceptionist),
        },
      });
    })().catch(next);
  });

  // GET /api/admin/reports/recreations.pdf — the same data, as a file.
  router.get('/admin/reports/recreations.pdf', (req, res, next) => {
    (async () => {
      const q = recreationQuery.parse(req.query);
      const report = await buildRecreationReport(q);
      const pdf = await buildRecreationReportPdf(
        report,
        await scopeLabel(q.branchId),
        getClock().now(),
      );
      sendPdf(res, pdf, recreationReportFileName(q.from, q.to));
    })().catch(next);
  });

  // GET /api/admin/reports/incidents — JSON for the screen.
  router.get('/admin/reports/incidents', (req, res, next) => {
    (async () => {
      const q = rangeQuery.parse(req.query);
      const issues = await loadIssues(q);
      res.json({ range: { from: q.from, to: q.to }, issues: issues.map((issue) => serializeIssue(issue)) });
    })().catch(next);
  });

  /*
    GET /api/admin/reports/incidents/summary — the counts behind the screen.

    A SEPARATE ENDPOINT from /issues/counts, which feeds the Technical tabs. That
    one answers "how big is each queue right now" and has no period at all; this
    one answers "what happened between these two dates". One function serving
    both is how a tab badge starts disagreeing with the report beside it.

    Declared before "/incidents.pdf" is irrelevant — the paths do not overlap —
    but it is grouped with the incident routes so the three are read together.
  */
  router.get('/admin/reports/incidents/summary', (req, res, next) => {
    (async () => {
      const q = rangeQuery.parse(req.query);
      const { start, end } = hcmRange(q.from, q.to);
      const summary = await computeIncidentRangeSummary({ start, end, branchId: q.branchId });
      res.json({ range: { from: q.from, to: q.to }, summary });
    })().catch(next);
  });

  // GET /api/admin/reports/handovers — shift changes and handover notes.
  router.get('/admin/reports/handovers', (req, res, next) => {
    (async () => {
      const q = rangeQuery.parse(req.query);
      const loaded = await loadHandovers(q);
      res.json({
        range: { from: q.from, to: q.to },
        handovers: loaded.handovers.map(serializeHandover),
        notes: loaded.notes.map(serializeHandoverNote),
        // The period's real sizes, which the arrays above may not reach.
        totals: { handovers: loaded.handoverTotal, notes: loaded.noteTotal },
        truncated: loaded.truncated,
      });
    })().catch(next);
  });

  // GET /api/admin/reports/handovers.pdf — the same data, as a file.
  router.get('/admin/reports/handovers.pdf', (req, res, next) => {
    (async () => {
      const q = rangeQuery.parse(req.query);
      const loaded = await loadHandovers(q);
      const pdf = await buildHandoverReportPdf({
        from: q.from,
        to: q.to,
        scope: await scopeLabel(q.branchId),
        handovers: loaded.handovers,
        notes: loaded.notes,
        handoverTotal: loaded.handoverTotal,
        noteTotal: loaded.noteTotal,
        truncated: loaded.truncated,
        generatedAt: getClock().now(),
      });
      sendPdf(res, pdf, handoverReportFileName(q.from, q.to));
    })().catch(next);
  });

  // GET /api/admin/reports/chat — internal reports, anonymous ones included.
  router.get('/admin/reports/chat', (req, res, next) => {
    (async () => {
      const q = chatQuery.parse(req.query);
      res.json({ range: { from: q.from, to: q.to }, conversations: await loadChat(q) });
    })().catch(next);
  });

  // GET /api/admin/reports/chat.pdf — the same data, as a file.
  router.get('/admin/reports/chat.pdf', (req, res, next) => {
    (async () => {
      const q = chatQuery.parse(req.query);
      const pdf = await buildChatReportPdf({
        from: q.from,
        to: q.to,
        scope: await scopeLabel(q.branchId),
        conversations: await loadChat(q),
        generatedAt: getClock().now(),
      });
      sendPdf(res, pdf, chatReportFileName(q.from, q.to));
    })().catch(next);
  });

  // GET /api/admin/reports/incidents.pdf — the same data, as a file.
  router.get('/admin/reports/incidents.pdf', (req, res, next) => {
    (async () => {
      const q = rangeQuery.parse(req.query);
      const issues = await loadIssues(q);
      const { start, end } = hcmRange(q.from, q.to);
      const pdf = await buildIncidentReportPdf({
        from: q.from,
        to: q.to,
        scope: await scopeLabel(q.branchId),
        issues,
        generatedAt: getClock().now(),
        // The same query the screen's summary cards read, so the file and the
        // table it was printed from cannot report different figures.
        summary: await computeIncidentRangeSummary({ start, end, branchId: q.branchId }),
      });
      sendPdf(res, pdf, incidentReportFileName(q.from, q.to));
    })().catch(next);
  });

  /*
    GET /api/admin/reports/operational — "Báo cáo vấn đề", the drill-down.

    RETURNS THE ROWS, NOT COUNTS. The counts are beside them for the category
    buttons; the records themselves are the answer to the only question this
    screen exists for — what did the desk actually record. A summary that
    replaces the table is the failure mode the specification names outright.

    Reads go through `listReports`, so an Admin and a receptionist are filtered
    by the same function. There is no privileged second query path.
  */
  router.get('/admin/reports/operational', (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const q = drillDownQuery.parse(req.query);
      const now = getClock().now();
      const admin = { id: user.id, role: user.role, branchId: user.branchId, fullName: user.fullName };

      /*
        THE PERIOD IS A RANGE OF BUSINESS DATES, resolved to the SHIFTS that
        belong to them — never a `createdAt` window. Ca C of the 23rd owns its
        02:15 entries; a timestamp filter would hand them to the 24th.

        Every shift of the period is on SCREEN, open ones included and flagged:
        an Admin watching today wants to see the shift that is still running.
        The official export is the one that leaves open shifts out.
      */
      const today = hcmDateOnly(now);
      const period = q.from && q.to ? { from: q.from, to: q.to } : null;
      const sessions = await sessionsForBusinessDates({
        ...(period ?? { from: today, to: today }),
        branchId: q.branchId,
      });
      const sessionIds = sessions.map((s) => s.id);
      // No period chosen: every record, as before; the drawer is still bounded to today.
      const scope = period ? { shiftSessionIds: sessionIds } : {};
      const filter = { branchId: q.branchId, category: q.category, ...scope };

      const [reports, counts, total] = await Promise.all([
        listReports(admin, filter),
        /*
          COUNTED WITHOUT THE CATEGORY FILTER, on purpose: these numbers sit on
          the five category buttons, and selecting one must not zero the other
          four. They describe the branch and the period, not the selection.
        */
        countByCategory(admin, { branchId: filter.branchId, ...scope }),
        countReports(admin, filter),
      ]);

      /*
        THE DRAWER IS ALWAYS BOUNDED, and the period is stated. It is the drawer
        of exactly the shifts of the period — with no period, today's.
      */
      const cashPeriod = period ?? { from: today, to: today };

      res.json({
        reports: reports.map((r) => serializeReport(r, now)),
        counts,
        /*
          THE CAP IS DECLARED RATHER THAN APPLIED SILENTLY.

          `listReports` stops at 500 rows. A branch with 1.500 payments would
          otherwise show "1500" on the button and render 500, with nothing to say
          the other 1.000 exist — a screen whose whole purpose is that the Admin
          sees FULL records, quietly showing a third of them.
        */
        total,
        truncated: total > reports.length,
        /* Cash is per BRANCH by definition — a drawer belongs to one desk — so
           an all-branch view answers null rather than adding eight drawers
           together into a number that describes nowhere. */
        cash: q.branchId === undefined ? null : await sessionsCashSummary(sessionIds),
        cashPeriod: q.branchId === undefined ? null : cashPeriod,
        /*
          THE SHIFTS OF THIS PERIOD THAT HAVE NOT PRESSED "KẾT THÚC CA". They are
          on screen, but not in the official export — and the screen says so
          rather than letting an unfinished day pass for a finished one.
        */
        openShifts: openShiftNotices(sessions),
        openShiftWarning: OPEN_SHIFT_WARNING,
      });
    })().catch(next);
  });

  // GET /api/admin/reports/operational.pdf — every record, by branch section.
  router.get('/admin/reports/operational.pdf', (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const q = operationalExportQuery.parse(req.query);
      const admin = { id: user.id, role: user.role, branchId: user.branchId, fullName: user.fullName };
      const data = await operationalReport(admin, {
        from: q.from,
        to: q.to,
        branchId: q.branchId,
        category: q.category,
      });
      sendPdf(res, await buildOperationalReportPdf(data), operationalFileName(q.from, q.to, 'pdf'));
    })().catch(next);
  });

  // GET /api/admin/reports/operational.xlsx — the same data, six sheets.
  router.get('/admin/reports/operational.xlsx', (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const q = operationalExportQuery.parse(req.query);
      const admin = { id: user.id, role: user.role, branchId: user.branchId, fullName: user.fullName };
      const data = await operationalReport(admin, {
        from: q.from,
        to: q.to,
        branchId: q.branchId,
        category: q.category,
      });
      const workbook = await buildOperationalReportWorkbook(data);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', contentDisposition(operationalFileName(q.from, q.to, 'xlsx')));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(workbook);
    })().catch(next);
  });

  return router;
}

/**
 * Filtered in the database over the reported-at instant, so a month across eight
 * properties is one indexed query rather than every incident ever loaded into
 * the process and filtered in JavaScript.
 */
async function loadIssues(q: { from: string; to: string; branchId?: number }) {
  const { start, end } = hcmRange(q.from, q.to);
  const where: Prisma.HotelIssueWhereInput = { createdAt: { gte: start, lt: end } };
  if (q.branchId !== undefined) where.branchId = q.branchId;
  return prisma.hotelIssue.findMany({
    where,
    include: ISSUE_INCLUDE,
    orderBy: [{ branchId: 'asc' }, { createdAt: 'asc' }],
  });
}
