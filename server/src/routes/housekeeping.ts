/**
 * "BUỒNG PHÒNG" — the API behind room inspections and their collection.
 *
 * ONE GATE FOR THE PREFIX: ADMIN, RECEPTIONIST and HOUSEKEEPING. What each may
 * DO is decided per route and again in the service, and what each may SEE is
 * `roomIssueWhere` — this file only maps HTTP onto that.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePasswordChanged, requireRole } from '../middleware/auth';
import { createWorkplaceLookupRateLimiter, createWorkplaceRateLimiter } from '../middleware/rateLimit';
import { getClock } from '../lib/clock';
import { hcmRange } from '../booking/recreationReport';
import {
  createInspection,
  listRoomIssues,
  saveCollection,
  summariseInspections,
  summariseRoomIssues,
  voidRoomIssue,
  type HousekeepingActor,
} from '../housekeeping/roomIssueService';
import {
  ROOM_COLLECTION_METHODS,
  ROOM_COLLECTION_METHOD_LABELS,
  ROOM_COLLECTION_STATUSES,
  ROOM_COLLECTION_STATUS_LABELS,
  ROOM_ISSUE_TYPES,
  ROOM_ISSUE_TYPE_LABELS,
} from '../housekeeping/roomIssueTypes';
import { currentShift, endShift, listShifts, lookupWorkplace, startShift, switchShiftBranch } from '../housekeeping/workShiftService';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TYPE = z.enum(ROOM_ISSUE_TYPES as [string, ...string[]]);
const STATUS = z.enum(ROOM_COLLECTION_STATUSES as [string, ...string[]]);

/** Shape only — what is REQUIRED for which case is the service's rule. */
const inspectionSchema = z.object({
  roomNumber: z.string(),
  // Optional: the shift's cleaner ("Tên người dọn buồng") is used when absent.
  staffName: z.string().optional(),
  issues: z.array(z.object({ type: z.string(), note: z.string().optional() })).max(50),
});

const collectionSchema = z.object({
  status: z.string(),
  amount: z.number().optional(),
  method: z.string().optional(),
  reason: z.string().optional(),
  note: z.string().optional(),
});

const voidSchema = z.object({ reason: z.string() });

/**
 * "Vào ca": the hotel's address as typed — resolved by the service. A branch id
 * the browser sends is not a way to pick the branch and is ignored.
 */
const shiftStartSchema = z.object({
  branchId: z.number().int().positive().optional(),
  // Optional: the account is the person; a name is kept only when one is sent.
  staffName: z.string().trim().max(100).optional(),
  address: z.string().max(500).optional(),
});

/** "Vào ca", step one: what the typed start of an address identifies. */
const shiftLookupSchema = z.object({ address: z.string().max(500).optional() });

const shiftListSchema = z.object({
  branchId: z.coerce.number().int().positive().optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
});

const listSchema = z
  .object({
    branchId: z.coerce.number().int().positive().optional(),
    type: TYPE.optional(),
    roomNumber: z.string().trim().min(1).max(50).optional(),
    status: STATUS.optional(),
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

export function createHousekeepingRouter(): Router {
  const router = Router();
  // One per app: an account's "Vào ca" address attempts are counted (see rateLimit.ts).
  const workplaceLimiter = createWorkplaceRateLimiter();
  const lookupLimiter = createWorkplaceLookupRateLimiter();
  router.use(
    '/housekeeping',
    requireAuth,
    requirePasswordChanged,
    // The reception supervisors READ (their scope); only Reception and the
    // Admin settle a collection, and only the Admin voids — per route below.
    requireRole('ADMIN', 'RECEPTIONIST', 'HOUSEKEEPING', 'HOUSEKEEPING_MANAGER', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'),
  );

  const actorOf = (req: {
    currentUser?: {
      id: number;
      role: HousekeepingActor['role'];
      branchId: number | null;
      fullName: string;
      managedBranchIds?: number[];
    };
  }): HousekeepingActor => {
    const u = req.currentUser!;
    return { id: u.id, role: u.role, branchId: u.branchId, fullName: u.fullName, managedBranchIds: u.managedBranchIds };
  };

  // GET /api/housekeeping/options — the vocabulary, served once.
  router.get('/housekeeping/options', (_req, res) => {
    res.json({
      issueTypes: ROOM_ISSUE_TYPES.map((t) => ({ code: t, label: ROOM_ISSUE_TYPE_LABELS[t] })),
      collectionStatuses: ROOM_COLLECTION_STATUSES.map((s) => ({ code: s, label: ROOM_COLLECTION_STATUS_LABELS[s] })),
      collectionMethods: ROOM_COLLECTION_METHODS.map((m) => ({ code: m, label: ROOM_COLLECTION_METHOD_LABELS[m] })),
    });
  });

  // POST /api/housekeeping/inspections — Bộ phận buồng phòng saves one room's findings.
  router.post('/housekeeping/inspections', requireRole('HOUSEKEEPING'), (req, res, next) => {
    (async () => {
      const input = inspectionSchema.parse(req.body ?? {});
      const inspection = await createInspection(input, actorOf(req), getClock());
      res.status(201).json({ inspection });
    })().catch(next);
  });

  // GET /api/housekeeping/issues — issues, scoped by role (see `roomIssueWhere`).
  router.get('/housekeeping/issues', (req, res, next) => {
    (async () => {
      const q = listSchema.parse(req.query);
      const range = q.from && q.to ? hcmRange(q.from, q.to) : null;
      const actor = actorOf(req);
      const filter = {
        branchId: q.branchId,
        type: q.type as never,
        roomNumber: q.roomNumber,
        status: q.status as never,
        from: range?.start,
        to: range?.end,
      };
      const list = await listRoomIssues(actor, filter);
      // Money totals for the roles that see money; Housekeeping gets its own
      // facts (inspections, findings, rooms) and nothing about collection.
      const summary = actor.role === 'HOUSEKEEPING' ? null : await summariseRoomIssues(actor, filter);
      const inspectionSummary = await summariseInspections(actor, filter);
      res.json({ ...list, summary, inspectionSummary });
    })().catch(next);
  });

  // PUT /api/housekeeping/issues/:id/collection — Reception (own branch) or Admin.
  // Reception and the reception managers settle a finding; the service checks the branch.
  router.put(
    '/housekeeping/issues/:id/collection',
    requireRole('RECEPTIONIST', 'ADMIN', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'),
    (req, res, next) => {
    (async () => {
      const input = collectionSchema.parse(req.body ?? {});
      const issue = await saveCollection(req.params.id!, input, actorOf(req), getClock());
      res.json({ issue });
    })().catch(next);
    },
  );

  /*
    THE HOUSEKEEPING WORKDAY — "Vào ca", "Đổi chi nhánh", "Kết thúc ca", and the
    history of workdays. The account itself only ever acts on its own workday.
  */
  router.get('/housekeeping/shift', requireRole('HOUSEKEEPING', 'HOUSEKEEPING_MANAGER'), (req, res, next) => {
    (async () => {
      res.json({ shift: await currentShift(actorOf(req)) });
    })().catch(next);
  });

  // Only the ONE branch the input uniquely identifies is named back; otherwise a
  // generic "nhập thêm". Every lookup counts toward the account's limit.
  router.post('/housekeeping/shift/lookup', requireRole('HOUSEKEEPING'), lookupLimiter, (req, res, next) => {
    (async () => {
      const body = shiftLookupSchema.parse(req.body ?? {});
      res.json(await lookupWorkplace(actorOf(req), body));
    })().catch(next);
  });

  router.post('/housekeeping/shift/start', requireRole('HOUSEKEEPING', 'HOUSEKEEPING_MANAGER'), workplaceLimiter, (req, res, next) => {
    (async () => {
      const body = shiftStartSchema.parse(req.body ?? {});
      res.status(201).json({ shift: await startShift(actorOf(req), body, getClock()) });
    })().catch(next);
  });

  router.post('/housekeeping/shift/switch', requireRole('HOUSEKEEPING'), (req, res, next) => {
    (async () => {
      res.json({ shift: await switchShiftBranch(actorOf(req)) });
    })().catch(next);
  });

  router.post('/housekeeping/shift/end', requireRole('HOUSEKEEPING', 'HOUSEKEEPING_MANAGER'), (req, res, next) => {
    (async () => {
      res.json({ shift: await endShift(actorOf(req), getClock()) });
    })().catch(next);
  });

  // GET /api/housekeeping/shifts — workdays on record: one's own, or a supervisor's scope.
  router.get('/housekeeping/shifts', (req, res, next) => {
    (async () => {
      const q = shiftListSchema.parse(req.query);
      const range = q.from && q.to ? hcmRange(q.from, q.to) : null;
      const shifts = await listShifts(actorOf(req), { from: range?.start, to: range?.end, branchId: q.branchId });
      res.json({ shifts });
    })().catch(next);
  });

  // POST /api/housekeeping/issues/:id/void — the Admin and the managers (their branches), with a reason.
  router.post('/housekeeping/issues/:id/void', requireRole('ADMIN', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER', 'HOUSEKEEPING_MANAGER'), (req, res, next) => {
    (async () => {
      const { reason } = voidSchema.parse(req.body ?? {});
      const issue = await voidRoomIssue(req.params.id!, reason, actorOf(req), getClock());
      res.json({ issue });
    })().catch(next);
  });

  return router;
}
