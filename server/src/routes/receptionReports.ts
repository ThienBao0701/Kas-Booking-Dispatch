/**
 * "BÁO CÁO VẤN ĐỀ" — the reception operational journal's API.
 *
 * WHAT THESE ROUTES DELIBERATELY DO NOT ACCEPT
 *
 * No `branchId`. No `shiftSessionId`. No `shiftType`. No employee. No
 * `createdAt`. Every one of them is resolved on the server from the actor's open
 * shift session, so a request that names a different branch or a different
 * receptionist is not rejected with an error — the field simply does not exist
 * in any schema below, and nothing reads it. That is stronger than validating
 * it: there is no code path where a client-supplied identity could be believed.
 *
 * THE EXCEPTIONS: `issueId`, on a facility report, checked against the target
 * branch before it is accepted; and `branchId` on CREATE — read ONLY for a
 * reception supervisor, who has no shift and must name exactly one branch of
 * its scope (`auth/branchScope.ts`). A receptionist's `branchId` is ignored.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getClock } from '../lib/clock';
import { requireAuth, requirePasswordChanged, requireRole } from '../middleware/auth';
import { hcmRange } from '../booking/recreationReport';
import type { UserWithBranch } from '../auth/serialize';
import {
  completeReport,
  countByCategory,
  createReport,
  listActiveJournal,
  listArchivedJournal,
  listReports,
  serializeReport,
  updateReport,
  voidReport,
} from '../reception/reportService';
import { setOpeningCash, shiftCashSummary, sumPayments, withEndingCash } from '../reception/cashService';
import { MAX_VND } from '../reception/reportService';
import { captureShiftContext, requireOpenSession } from '../shift/shiftService';
import { COMPLETION_ARCHIVE_HOURS } from '../reception/completionArchive';
import { HOTEL_DELIVERY_ARCHIVE_HOURS } from '../reception/deliveryLifecycle';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  DELIVERY_DEPARTMENTS,
  DELIVERY_DEPARTMENT_LABELS,
  HOTEL_DELIVERY_TITLE,
  PAYMENT_SOURCES,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  ROOM_SERVICE_LABELS,
  ROOM_SERVICE_TYPES,
} from '../reception/reportTypes';

const CATEGORY = z.enum([
  'PAYMENT',
  'GUEST_REQUEST',
  'FACILITY_ISSUE',
  'CUSTOMER_COMPLAINT',
  'ROOM_SERVICE',
  'HOTEL_DELIVERY',
]);
const METHOD = z.enum(['CASH', 'TRANSFER', 'CARD', 'DEBT']);
const DEPARTMENT = z.enum(['RECEPTION', 'HOUSEKEEPING', 'TECHNICAL']);
const SERVICE = z.enum(['ROOM_SALE', 'UPGRADE', 'SMOKING', 'LAUNDRY', 'OTHER', 'REVIEW']);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * A money field, on the wire.
 *
 * `z.number().int()` and NOT `z.coerce.number()`. Coercion would turn the empty
 * string into 0 and `"3.150.000 ₫"` into NaN, and NaN is not an integer so the
 * second case would be caught — but the first would store a silent zero-đồng
 * payment. The client sends a number; a formatted string is a bug, and it is
 * refused here rather than repaired.
 */
/*
  THE CEILING COMES FROM THE SERVICE, WHICH TAKES IT FROM THE COLUMN.

  A literal here would be a second copy of a number whose real source is the
  width of a PostgreSQL INTEGER — and the two drifting apart is exactly how an
  amount got past validation and died in the driver with a 500.
*/
const money = z.number().int().min(0).max(MAX_VND);

const text = (max: number) => z.string().trim().max(max);

/*
  THE CURRENT FORMS, FIELD FOR FIELD. The legacy columns (a payment's room and
  note, a request's "Ký gửi" and room, a complaint's place, a room service's
  phone, room and service name) are no longer accepted: zod strips unknown keys,
  so a client that still sends them changes nothing, and older rows keep them.

  "Nguồn" is only length-checked here; WHICH values are allowed is the service's
  rule (`PAYMENT_SOURCES`), because a correction must be allowed to leave an
  older row's free-text source alone.
*/
const paymentSchema = z.object({
  ezCode: text(100).optional(),
  source: text(100).optional(),
  guestName: text(200).optional(),
  method: METHOD,
  amount: money,
  receivable: money.optional(),
  expense: money.optional(),
  note: text(2000).optional(),
});

const guestRequestSchema = z.object({
  guestName: text(200).min(1, 'Vui lòng nhập tên khách.'),
  ezCode: text(100).optional(),
  note: text(2000).min(1, 'Vui lòng nhập nội dung.'),
});

/** "Cách xử lý / Hướng xử lý (nếu có)" — optional; blank is stored as nothing. */
const completeSchema = z.object({
  resolution: text(2000).optional(),
});

const facilitySchema = z.object({ issueId: z.string().min(1) });

const complaintSchema = z.object({
  guestName: text(200).min(1, 'Vui lòng nhập tên khách.'),
  ezCode: text(100).optional(),
  description: text(4000).min(1, 'Vui lòng nhập mô tả.'),
});

const roomServiceSchema = z.object({
  serviceType: SERVICE,
  guestName: text(200).min(1, 'Vui lòng nhập tên khách.'),
  ezCode: text(100).optional(),
  roomClass: text(200).optional(),
  fromRoomClass: text(200).optional(),
  toRoomClass: text(200).optional(),
  // Which subtypes need it, and its range, are the service's rule.
  nights: z.number().int().optional(),
  // Every service but "Review" requires it — the service's rule, like nights.
  price: money.optional(),
  note: text(2000).optional(),
  // "Review" only: whole numbers; the range is the service's rule.
  tripadvisorCount: z.number().int().optional(),
  googleCount: z.number().int().optional(),
});

/**
 * Quantity is a NUMBER on the wire. `z.number().int()` refuses "5" and "năm"
 * alike — the field is not free text, and coercing a string here would turn an
 * empty box into a delivery of zero.
 */
const deliverySchema = z.object({
  department: DEPARTMENT,
  itemName: text(300).min(1, 'Vui lòng nhập tên hàng hóa.'),
  quantity: z.number({ invalid_type_error: 'Số lượng phải là số.' }).int('Số lượng phải là số nguyên.'),
  note: text(2000).optional(),
});

/**
 * A DISCRIMINATED UNION, not one object with six optional blocks.
 *
 * zod then refuses a body carrying both a payment and a complaint outright,
 * instead of the service having to decide which one wins. A report is exactly
 * one category, and the schema says so.
 */
const createSchema = z.discriminatedUnion('category', [
  z.object({ category: z.literal('PAYMENT'), payment: paymentSchema }),
  z.object({ category: z.literal('GUEST_REQUEST'), guestRequest: guestRequestSchema }),
  z.object({ category: z.literal('FACILITY_ISSUE'), facility: facilitySchema }),
  z.object({ category: z.literal('CUSTOMER_COMPLAINT'), complaint: complaintSchema }),
  z.object({ category: z.literal('ROOM_SERVICE'), roomService: roomServiceSchema }),
  z.object({ category: z.literal('HOTEL_DELIVERY'), delivery: deliverySchema }),
]);

const updateSchema = z.object({
  payment: paymentSchema.partial().optional(),
  guestRequest: guestRequestSchema.partial().optional(),
  complaint: complaintSchema.partial().optional(),
  roomService: roomServiceSchema.partial().optional(),
  delivery: deliverySchema.partial().optional(),
  reason: text(1000).optional(),
});

const voidSchema = z.object({
  reason: text(1000).min(1, 'Vui lòng nhập lý do hủy.'),
});

const listSchema = z
  .object({
    category: CATEGORY.optional(),
    shiftSessionId: z.string().min(1).optional(),
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

/**
 * "Hoàn thành vấn đề" by the days the records were RECEIVED on. Optional — the
 * whole archive without it — and refused as a pair or in the wrong order, like
 * every other period in KAS.
 */
const archiveSchema = z
  // `branchId`: a reception manager narrowing to one branch of its scope.
  .object({ from: isoDay.optional(), to: isoDay.optional(), branchId: z.coerce.number().int().positive().optional() })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: 'Cần chọn cả ngày bắt đầu và ngày kết thúc.',
    path: ['to'],
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.',
    path: ['from'],
  });

const openingCashSchema = z.object({ openingCash: money });

function actor(user: UserWithBranch & { managedBranchIds?: number[] }) {
  return {
    id: user.id,
    role: user.role,
    branchId: user.branchId,
    fullName: user.fullName,
    managedBranchIds: user.managedBranchIds,
  };
}

const requireReception = requireRole('RECEPTIONIST');

/**
 * WHO MAY WRITE A JOURNAL RECORD: the desk on its open shift, and the reception
 * supervisors (Admin, Quản lý lễ tân, Tổng quản lý lễ tân) on a branch of their
 * scope. The service decides the branch and the shift; this only admits the roles.
 */
const requireJournalWriter = requireRole(
  'RECEPTIONIST',
  'ADMIN',
  'RECEPTION_MANAGER',
  'RECEPTION_GENERAL_MANAGER',
);

/** A supervisor names its target branch; a receptionist's is its shift's. */
const targetSchema = z.object({ branchId: z.number().int().positive().optional() });

export function createReceptionReportsRouter(): Router {
  const router = Router();

  /*
    GET /api/reception/reports/options — the vocabulary, served once.

    Open to Admin as well as Reception: the Admin drill-down renders the same
    category names and method labels, and a second copy in React is how the
    export and the screen start disagreeing about what a column is called.
  */
  router.get(
    '/reception/reports/options',
    requireAuth,
    requirePasswordChanged,
    requireJournalWriter,
    (_req, res) => {
      res.json({
        categories: CATEGORIES.map((c) => ({ code: c, label: CATEGORY_LABELS[c] })),
        paymentMethods: PAYMENT_METHODS.map((m) => ({ code: m, label: PAYMENT_METHOD_LABELS[m] })),
        roomServiceTypes: ROOM_SERVICE_TYPES.map((t) => ({ code: t, label: ROOM_SERVICE_LABELS[t] })),
        paymentSources: PAYMENT_SOURCES,
        deliveryDepartments: DELIVERY_DEPARTMENTS.map((d) => ({ code: d, label: DELIVERY_DEPARTMENT_LABELS[d] })),
        deliveryTitle: HOTEL_DELIVERY_TITLE,
        deliveryArchiveHours: HOTEL_DELIVERY_ARCHIVE_HOURS,
      });
    },
  );

  /*
    GET /api/reception/reports — this branch's journal.

    Branch isolation is not applied here; it is applied in `reportWhere`, which
    every read goes through. One filter, one place to get it right.
  */
  router.get('/reception/reports', requireAuth, requirePasswordChanged, requireReception, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const q = listSchema.parse(req.query);
      const range = q.from && q.to ? hcmRange(q.from, q.to) : null;
      const now = getClock().now();
      const filter = {
        category: q.category,
        shiftSessionId: q.shiftSessionId,
        from: range?.start,
        to: range?.end,
      };
      const [reports, counts] = await Promise.all([
        listReports(actor(user), filter),
        countByCategory(actor(user), filter),
      ]);
      res.json({ reports: reports.map((r) => serializeReport(r, now)), counts });
    })().catch(next);
  });

  /*
    GET /api/reception/reports/active — II and IV as the desk must see them:
    the branch's unfinished records at any age, and its completions received in
    the last 12 hours, across shifts. The server clock decides; the open shift
    is read from the session, never from the request.
  */
  router.get('/reception/reports/active', requireAuth, requirePasswordChanged, requireReception, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const now = getClock().now();
      const shift = await captureShiftContext(actor(user));
      const { reports, totals } = await listActiveJournal(actor(user), now, shift.shiftSessionId);
      res.json({
        reports: reports.map((r) => serializeReport(r, now)),
        // Each category's full count: the list is a page, and the screen says so.
        totals,
        archiveAfterHours: COMPLETION_ARCHIVE_HOURS,
      });
    })().catch(next);
  });

  /*
    GET /api/reception/reports/archive — "Hoàn thành vấn đề": II and IV that are
    completed AND were received at least 12 hours ago. A query over the same
    rows, not a copy of them.

    `from`/`to` (YYYY-MM-DD, inclusive Vietnamese calendar days) narrow it to
    the records RECEIVED on those days — the original reception time, the same
    instant the 12-hour rule is measured from; never the completion.
  */
  // Reception's own branch; a supervisor's scope (one branch of it, or all of it).
  router.get('/reception/reports/archive', requireAuth, requirePasswordChanged, requireJournalWriter, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const q = archiveSchema.parse(req.query);
      const received = q.from && q.to ? hcmRange(q.from, q.to) : null;
      const now = getClock().now();
      const { reports, totals } = await listArchivedJournal(actor(user), now, received, undefined, q.branchId);
      res.json({
        reports: reports.map((r) => serializeReport(r, now)),
        totals,
        range: q.from && q.to ? { from: q.from, to: q.to } : null,
        archiveAfterHours: COMPLETION_ARCHIVE_HOURS,
      });
    })().catch(next);
  });

  // POST /api/reception/reports — one journal entry.
  router.post('/reception/reports', requireAuth, requirePasswordChanged, requireJournalWriter, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const input = createSchema.parse(req.body ?? {});
      const { branchId } = targetSchema.parse(req.body ?? {});
      const clock = getClock();
      const created = await createReport({ ...input, branchId }, actor(user), clock);
      res.status(201).json({ report: serializeReport(created, clock.now()) });
    })().catch(next);
  });

  // PATCH /api/reception/reports/:id — correct a record, keeping the old value.
  router.patch('/reception/reports/:id', requireAuth, requirePasswordChanged, requireJournalWriter, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const patch = updateSchema.parse(req.body ?? {});
      const clock = getClock();
      const updated = await updateReport(req.params.id!, patch, actor(user), clock);
      res.json({ report: serializeReport(updated, clock.now()) });
    })().catch(next);
  });

  /*
    POST /api/reception/reports/:id/void — "Xóa", implemented as a withdrawal.

    NOT `DELETE`, and the verb is the point: nothing here removes a row. The
    record keeps its place in the journal with the reason, the person and the
    instant attached, and drops out of every total.
    Reception only: a supervisor corrects a record ("Sửa") but never withdraws it.
  */
  router.post('/reception/reports/:id/void', requireAuth, requirePasswordChanged, requireReception, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const { reason } = voidSchema.parse(req.body ?? {});
      const clock = getClock();
      const voided = await voidReport(req.params.id!, reason, actor(user), clock);
      res.json({ report: serializeReport(voided, clock.now()) });
    })().catch(next);
  });

  /*
    POST /api/reception/reports/:id/complete — "Hoàn thành" on a guest request
    or a service-quality report.

    The body carries only the optional handling text; who, when and on which
    shift come from the session and the server clock.
  */
  router.post('/reception/reports/:id/complete', requireAuth, requirePasswordChanged, requireReception, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const { resolution } = completeSchema.parse(req.body ?? {});
      const clock = getClock();
      const completed = await completeReport(req.params.id!, resolution, actor(user), clock);
      res.json({ report: serializeReport(completed, clock.now()) });
    })().catch(next);
  });

  /*
    GET /api/reception/shifts/cash — the drawer for the CURRENT shift.

    Requires an open session rather than answering with nulls: "Tiền cuối ca" is
    a property of a shift, and without one there is no shift to compute it for.
  */
  router.get('/reception/shifts/cash', requireAuth, requirePasswordChanged, requireReception, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const session = await requireOpenSession(actor(user));
      res.json({ cash: await shiftCashSummary(session.id) });
    })().catch(next);
  });

  // PUT /api/reception/shifts/cash — set or correct "Tiền đầu ca".
  router.put('/reception/shifts/cash', requireAuth, requirePasswordChanged, requireReception, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const { openingCash } = openingCashSchema.parse(req.body ?? {});
      res.json({ cash: await setOpeningCash(openingCash, actor(user), getClock()) });
    })().catch(next);
  });

  /*
    GET /api/reception/reports/cash-range — the branch's cash over a period.

    Reception's own branch only, and only over days it names. Exists so a
    receptionist can reconcile yesterday without an Admin; the figures are the
    same ones `branchCashSummary` gives the Admin report.
  */
  router.get('/reception/reports/cash-range', requireAuth, requirePasswordChanged, requireReception, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const q = listSchema.parse(req.query);
      const range = q.from && q.to ? hcmRange(q.from, q.to) : null;
      const branchId = user.branchId ?? -1;
      const totals = await sumPayments({
        branchId,
        ...(range ? { createdAt: { gte: range.start, lt: range.end } } : {}),
      });
      // Opening cash is a per-shift count and is not summed here: over an
      // arbitrary range it would answer a question nobody asked. The Admin
      // period report uses `branchCashSummary`, which does it deliberately.
      res.json({ cash: withEndingCash(null, totals) });
    })().catch(next);
  });

  return router;
}
