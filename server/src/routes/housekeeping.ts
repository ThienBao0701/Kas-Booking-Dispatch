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

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TYPE = z.enum(ROOM_ISSUE_TYPES as [string, ...string[]]);
const STATUS = z.enum(ROOM_COLLECTION_STATUSES as [string, ...string[]]);

/** Shape only — what is REQUIRED for which case is the service's rule. */
const inspectionSchema = z.object({
  roomNumber: z.string(),
  staffName: z.string(),
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
  router.use(
    '/housekeeping',
    requireAuth,
    requirePasswordChanged,
    // The reception supervisors READ (their scope); only Reception and the
    // Admin settle a collection, and only the Admin voids — per route below.
    requireRole('ADMIN', 'RECEPTIONIST', 'HOUSEKEEPING', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'),
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

  // POST /api/housekeeping/issues/:id/void — Admin only, with a reason.
  router.post('/housekeeping/issues/:id/void', requireRole('ADMIN'), (req, res, next) => {
    (async () => {
      const { reason } = voidSchema.parse(req.body ?? {});
      const issue = await voidRoomIssue(req.params.id!, reason, actorOf(req), getClock());
      res.json({ issue });
    })().catch(next);
  });

  return router;
}
