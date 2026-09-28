import { Router } from 'express';
import { z } from 'zod';
import { getClock } from '../lib/clock';
import { requireAuth, requirePasswordChanged, requireRole } from '../middleware/auth';
import { proofUpload } from '../middleware/upload';
import { readIssuePhoto } from '../issue/issueStorage';
import { hcmRange } from '../booking/recreationReport';
import {
  acceptIssue,
  authorizeIssuePhoto,
  cannotRepairIssue,
  completeIssue,
  createIssue,
  getIssue,
  inspectIssue,
  listIssues,
  serializeIssue,
  updateIssue,
  updateRepairCause,
} from '../issue/issueService';
import { computeIssueSummary, computeTechnicalCounts } from '../issue/issueSummary';
import type { UserWithBranch } from '../auth/serialize';

const CATEGORY = z.enum([
  'DOOR',
  'AIR_CONDITIONER',
  'TOILET',
  'TV',
  'WIFI',
  'ELECTRICITY',
  'WATER',
  'FURNITURE',
  'HOUSEKEEPING',
  'GUEST_REQUEST',
  'OTHER',
]);

const AREA = z.enum(['ROOM', 'LOBBY', 'HALLWAY', 'STAIRCASE', 'RESTAURANT', 'ROOFTOP', 'OTHER_AREA']);
const SUBTYPE = z.enum(['RECEPTION_DESK', 'SOFA', 'FLOOR', 'CEILING', 'LIGHT_BULB', 'CLOCK', 'OTHER']);
const STATUS = z.enum(['NEW', 'IN_PROGRESS', 'AWAITING_INSPECTION', 'COMPLETED']);
/** The queues as people name them — see `IssueStage` in the service. */
const STAGE = z.enum(['WAITING', 'REWORK', 'IN_PROGRESS', 'AWAITING_INSPECTION', 'COMPLETED']);

/**
 * Shape only. WHICH location fields are REQUIRED is decided by `normaliseArea`
 * in the domain, not here — one rule, on the server, for a form and an API that
 * must agree. zod's job is to reject the wrong TYPE; the domain's job is to
 * reject the wrong COMBINATION.
 */
const createSchema = z.object({
  branchId: z.coerce.number().int().positive().optional(),
  areaCategory: AREA,
  roomNumber: z.string().trim().max(50).optional(),
  floorNumber: z.string().trim().max(50).optional(),
  areaSubtype: SUBTYPE.optional(),
  locationDetail: z.string().trim().max(500).optional(),
  category: CATEGORY.optional(),
  description: z.string().trim().min(1, 'Vui lòng nhập mô tả sự cố.').max(2000),
  /** "Nguyên nhân" — optional: Reception often does not know it yet. */
  cause: z.string().trim().max(1000).optional(),
});

const updateSchema = z
  .object({
    roomNumber: z.string().trim().max(50).nullable().optional(),
    category: CATEGORY.optional(),
    description: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật.' });

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải theo định dạng YYYY-MM-DD.');

/**
 * `from`/`to` are OPTIONAL and, when absent, nothing is filtered by date.
 *
 * The Admin monitor's job is "what is going on across the eight properties", and
 * defaulting it to today would hide every unresolved incident older than this
 * morning — the ones that most need looking at. A period is something the Admin
 * asks for, and asking for it changes nothing else about the screen.
 *
 * They are refused as a PAIR rather than accepted singly: a half-open range
 * expressed as "from the 17th" silently means "for ever after the 17th", which
 * reads on screen exactly like a range that was applied.
 */
const listSchema = z
  .object({
    branchId: z.coerce.number().int().positive().optional(),
    status: STATUS.optional(),
    stage: STAGE.optional(),
    areaCategory: AREA.optional(),
    from: isoDay.optional(),
    to: isoDay.optional(),
    outstanding: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
    // The 12-hour completion rule — Reception's active board and its archive.
    scope: z.enum(['active', 'archive']).optional(),
    // Technical's "Đã hoàn thành" — by the day the repair was FINISHED.
    completedFrom: isoDay.optional(),
    completedTo: isoDay.optional(),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(50),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    message: 'Cần chọn cả ngày bắt đầu và ngày kết thúc.',
    path: ['to'],
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.',
    path: ['from'],
  })
  .refine((q) => (q.completedFrom === undefined) === (q.completedTo === undefined), {
    message: 'Cần chọn cả ngày bắt đầu và ngày kết thúc.',
    path: ['completedTo'],
  })
  .refine((q) => q.completedFrom === undefined || q.completedTo === undefined || q.completedFrom <= q.completedTo, {
    message: 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.',
    path: ['completedFrom'],
  });

const countsSchema = z.object({
  branchId: z.coerce.number().int().positive().optional(),
});

/** Both fields are required: an accepted incident must always name a person. */
const acceptSchema = z.object({
  technicianName: z.string().trim().min(1, 'Vui lòng nhập họ và tên người sửa.').max(200),
  technicianPhone: z.string().trim().min(1, 'Vui lòng nhập số điện thoại người sửa.').max(30),
});

/**
 * An incident only goes back to the queue WITH a reason.
 *
 * Trimmed by zod before `min(1)`, so a reason of spaces is refused rather than
 * stored — the next technician to pick this up reads this line to decide whether
 * they can succeed where the last one could not, and "   " tells them nothing.
 */
const cannotRepairSchema = z.object({
  reason: z.string().trim().min(1, 'Vui lòng nhập lý do không sửa được.').max(1000),
});

/**
 * "Hoàn thành": the result is required — it is what the manager inspects — and
 * the cause is optional, because the one already on file may be right.
 */
const completeSchema = z.object({
  cause: z.string().trim().max(1000).nullable().optional(),
  // Required by the SERVICE while inspection is active; optional while dormant.
  result: z.string().trim().max(2000).nullable().optional(),
});

/** "Nguyên nhân" recorded during the repair — required when sent at all. */
const causeSchema = z.object({
  cause: z.string().trim().min(1, 'Vui lòng nhập nguyên nhân.').max(1000),
});

/**
 * "Nghiệm thu". The note is optional here and required by the SERVICE when the
 * verdict is a fail — one rule, in the domain, whoever calls it.
 */
const inspectSchema = z.object({
  result: z.enum(['PASSED', 'FAILED']),
  note: z.string().trim().max(1000).nullable().optional(),
});

function actor(user: UserWithBranch) {
  return { id: user.id, role: user.role, branchId: user.branchId, fullName: user.fullName };
}

/** Only Bộ phận kỹ thuật works the queue. Admin monitors, and is refused here. */
const requireTechnical = requireRole('TECHNICAL');

/** Only Quản lý kỹ thuật judges a repair — not the technician who made it. */
const requireInspector = requireRole('TECHNICAL_MANAGER');

/**
 * Who REPORTS an incident: Reception (own branch) and the Admin (any branch) —
 * the contract the create route always described. An allow-list, so a
 * branchless department (Bộ phận kỹ thuật, Quản lý kỹ thuật, Bộ phận đặt phòng)
 * cannot file or rewrite a report at a branch it has no desk at.
 */
const requireReporter = requireRole('RECEPTIONIST', 'ADMIN');

/** Reception reports hotel incidents; Bộ phận kỹ thuật works them. */
export function createIssuesRouter(): Router {
  const router = Router();

  // POST /api/issues — create a report (receptionist own branch, admin any branch).
  router.post('/issues', requireAuth, requirePasswordChanged, requireReporter, proofUpload(), (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const input = createSchema.parse(req.body ?? {});
      const photo = req.file ? { buffer: req.file.buffer, size: req.file.size } : undefined;
      const issue = await createIssue({ ...input, photo }, actor(user));
      res.status(201).json({ issue: serializeIssue(issue) });
    })().catch(next);
  });

  // GET /api/issues — list (newest first; receptionist limited to own branch,
  // Technical and Admin see all eight).
  router.get('/issues', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const q = listSchema.parse(req.query);
      // Half-open [from, to) in Asia/Ho_Chi_Minh, using the SAME helper the
      // dashboard and the accountability report use — one definition of what a
      // Vietnamese calendar day is, for every screen that asks for one.
      const range = q.from && q.to ? hcmRange(q.from, q.to) : null;
      const completed = q.completedFrom && q.completedTo ? hcmRange(q.completedFrom, q.completedTo) : null;
      const now = getClock().now();
      const { issues, total } = await listIssues(actor(user), {
        branchId: q.branchId,
        status: q.status,
        stage: q.stage,
        areaCategory: q.areaCategory,
        from: range?.start,
        to: range?.end,
        outstanding: q.outstanding,
        scope: q.scope,
        completedFrom: completed?.start,
        completedTo: completed?.end,
        now,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      });
      res.json({
        issues: issues.map((issue) => serializeIssue(issue, now)),
        pagination: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) },
      });
    })().catch(next);
  });

  // GET /api/issues/summary — unresolved counters within the caller's branch
  // scope (Admin: all branches; receptionist: own branch only). Declared before
  // "/issues/:id" so "summary" is never captured as an id.
  router.get('/issues/summary', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const summary = await computeIssueSummary(actor(user));
      res.json({ summary });
    })().catch(next);
  });

  // GET /api/issues/counts — the three workflow-queue totals. Served by the
  // server so a tab badge can never disagree with the tab it labels because the
  // list behind it happened to be paginated.
  router.get('/issues/counts', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const q = countsSchema.parse(req.query);
      const counts = await computeTechnicalCounts(actor(user), q.branchId);
      res.json({ counts });
    })().catch(next);
  });

  // GET /api/issues/:id — detail (branch-isolated).
  router.get('/issues/:id', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const issue = await getIssue(req.params.id!, actor(user));
      res.json({ issue: serializeIssue(issue) });
    })().catch(next);
  });

  // GET /api/issues/:id/photo — authenticated, branch-isolated photo bytes.
  router.get('/issues/:id/photo', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const { storedFileName, mimeType } = await authorizeIssuePhoto(req.params.id!, actor(user));
      const bytes = await readIssuePhoto(storedFileName);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(bytes);
    })().catch(next);
  });

  // PUT /api/issues/:id — reporter edits while still NEW (own branch).
  router.put('/issues/:id', requireAuth, requirePasswordChanged, requireReporter, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const input = updateSchema.parse(req.body ?? {});
      const issue = await updateIssue(req.params.id!, input, actor(user));
      res.json({ issue: serializeIssue(issue) });
    })().catch(next);
  });

  // POST /api/issues/:id/accept — Technical takes the job: NEW → IN_PROGRESS.
  // `requireTechnical` refuses an Admin here; the service re-checks the role as
  // well, so reaching the transition by any other path is refused too.
  router.post('/issues/:id/accept', requireAuth, requirePasswordChanged, requireTechnical, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const input = acceptSchema.parse(req.body ?? {});
      const issue = await acceptIssue(req.params.id!, input, actor(user), getClock());
      res.json({ issue: serializeIssue(issue) });
    })().catch(next);
  });

  // POST /api/issues/:id/complete — Technical finishes the repair:
  // IN_PROGRESS → AWAITING_INSPECTION. The server stamps the time.
  router.post('/issues/:id/complete', requireAuth, requirePasswordChanged, requireTechnical, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const input = completeSchema.parse(req.body ?? {});
      const issue = await completeIssue(req.params.id!, input, actor(user), getClock());
      res.json({ issue: serializeIssue(issue) });
    })().catch(next);
  });

  // POST /api/issues/:id/cause — the technician records the cause they found,
  // on the attempt that is still open. Reception's reported cause is untouched.
  router.post('/issues/:id/cause', requireAuth, requirePasswordChanged, requireTechnical, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const input = causeSchema.parse(req.body ?? {});
      const issue = await updateRepairCause(req.params.id!, input, actor(user));
      res.json({ issue: serializeIssue(issue) });
    })().catch(next);
  });

  // POST /api/issues/:id/inspect — Quản lý kỹ thuật judges the repair:
  // AWAITING_INSPECTION → COMPLETED (đạt) or → NEW (không đạt, sửa lại).
  // `requireInspector` refuses every other role; the service re-checks it.
  router.post('/issues/:id/inspect', requireAuth, requirePasswordChanged, requireInspector, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const input = inspectSchema.parse(req.body ?? {});
      const issue = await inspectIssue(req.params.id!, input, actor(user), getClock());
      res.json({ issue: serializeIssue(issue) });
    })().catch(next);
  });

  /*
    POST /api/issues/:id/cannot-repair — "Không sửa được": IN_PROGRESS → NEW.

    A SEPARATE ENDPOINT, not a parameter on /complete. The two are opposite
    outcomes with different consequences — one closes the incident, the other
    puts it back in front of somebody else — and folding them into one route
    with an `outcome` field would make "finish this job" and "give this job up"
    the same request with a different word in the body. It also keeps
    /complete's contract exactly as it was.
  */
  router.post('/issues/:id/cannot-repair', requireAuth, requirePasswordChanged, requireTechnical, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const input = cannotRepairSchema.parse(req.body ?? {});
      const issue = await cannotRepairIssue(req.params.id!, input, actor(user), getClock());
      res.json({ issue: serializeIssue(issue) });
    })().catch(next);
  });

  return router;
}
