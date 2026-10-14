/**
 * THE DAILY ROOM WORK, KPI AND REPORT ROUTES.
 *
 *   /housekeeping/catalog                 — room codes, the "Dọn phòng" form (everyone here)
 *   /housekeeping/manager/...             — Quản lý buồng phòng (its branch) and Admin (every branch)
 *   /housekeeping/work/...                — the worker's own rooms and actions
 *   /housekeeping/kpi/me                  — the worker's own KPI
 *
 * The gate is the session; WHO may do WHAT is decided in the services
 * (\`roomTaskService\`, \`housekeepingKpi\`) on every request — a role, a branch, an
 * assignee — never by which button a screen shows.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getClock } from '../lib/clock';
import { requireAuth, requirePasswordChanged } from '../middleware/auth';
import type { HousekeepingActor } from '../housekeeping/roomIssueService';
import { roomWorkCatalog } from '../housekeeping/roomTaskCatalog';
import {
  assignTask,
  beginInspection,
  claimTasks,
  completeTask,
  createTasks,
  listWorkAreas,
  listWorkOrders,
  reassignAwaitingCleaning,
  reassignableStaff,
  workList,
  getTask,
  inspectTask,
  listStaff,
  listTasks,
  myTasks,
  openTask,
  saveCleaning,
  startTask,
  reviewTask,
  roomHistory,
  updateTask,
  voidTask,
} from '../housekeeping/roomTaskService';
import {
  acceptWorkGroup,
  addWorkGroupItems,
  assignWorkGroup,
  createWorkGroup,
  decideNoClean,
  listWorkGroups,
  renameWorkGroup,
  requestNoClean,
  workerGroups,
  workerHistory,
} from '../housekeeping/workGroupService';
import { housekeepingKpi, myKpi, operationsReport, overview, staffDetail, staffProgress } from '../housekeeping/housekeepingKpi';
import { buildHousekeepingOpsWorkbook, housekeepingOpsFileName } from '../report/housekeepingOpsReport';
import { buildHousekeepingCleaningPdf } from '../report/housekeepingCleaningPdf';
import { contentDisposition } from '../report/format';
import { prisma } from '../db/prisma';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày không hợp lệ.');
const branchQuery = z.coerce.number().int().positive().optional();
const periodSchema = z
  .object({ from: isoDay, to: isoDay, branchId: branchQuery })
  .refine((q) => q.from <= q.to, { message: 'Khoảng ngày không hợp lệ.', path: ['to'] });

const actorOf = (req: Request): HousekeepingActor => {
  const u = req.currentUser!;
  return { id: u.id, role: u.role, branchId: u.branchId, fullName: u.fullName, managedBranchIds: u.managedBranchIds };
};

const issuesSchema = z.object({
  issues: z.array(z.object({ type: z.string(), note: z.string().optional() })).max(50).default([]),
  // A shared area's inspection is a note, not room findings.
  note: z.string().max(2000).optional(),
});

/** One room / area of a work group: shape only — what each REQUIRES is the service's rule. */
const groupItemSchema = z.object({
  areaKind: z.string().optional(),
  roomNumber: z.string().max(100).optional(),
  floor: z.string().max(100).optional(),
  taskCodes: z.array(z.string().max(20)).max(4).optional(),
  note: z.string().max(2000).optional(),
  priority: z.boolean().optional(),
});

/** "Tạo công việc": the group (its optional name) and its places. */
const workGroupSchema = z.object({
  branchId: z.number().int().positive().optional(),
  workDate: isoDay,
  requestId: z.string().max(64).optional(),
  name: z.string().max(500).optional(),
  items: z.array(groupItemSchema).max(50),
});

const claimSchema = z.object({ taskIds: z.array(z.string().min(1).max(100)).min(1).max(50) });

const reassignSchema = z.object({
  assigneeUserId: z.number().int().positive(),
  reason: z.string().max(1000).optional(),
});

async function scopeLabel(actor: HousekeepingActor, branchId?: number): Promise<string> {
  const id = branchId ?? (actor.role === 'HOUSEKEEPING_MANAGER' ? actor.branchId : null);
  if (id === null || id === undefined) return 'Tất cả chi nhánh';
  const b = await prisma.branch.findUnique({ where: { id }, select: { address: true, branchNumber: true } });
  return b ? `Chi nhánh ${b.branchNumber} — ${b.address}` : 'Chi nhánh';
}

function sendFile(res: Response, body: Buffer, type: string, fileName: string): void {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', contentDisposition(fileName));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(body);
}

export function createHousekeepingWorkRouter(): Router {
  const router = Router();
  const gate = [requireAuth, requirePasswordChanged];

  router.get('/housekeeping/catalog', ...gate, (_req, res) => {
    res.json(roomWorkCatalog());
  });

  /* ------------------------------ the manager ----------------------------- */

  router.get('/housekeeping/manager/tasks', ...gate, (req, res, next) => {
    (async () => {
      const q = z
        .object({ date: isoDay, branchId: branchQuery, includeVoided: z.enum(['true', 'false']).optional() })
        .parse(req.query);
      const tasks = await listTasks(actorOf(req), { workDate: q.date, branchId: q.branchId, includeVoided: q.includeVoided === 'true' });
      res.json({ tasks });
    })().catch(next);
  });

  router.post('/housekeeping/manager/tasks', ...gate, (req, res, next) => {
    (async () => {
      const body = z
        .object({
          branchId: z.number().int().positive().optional(),
          workDate: isoDay,
          roomNumbers: z.array(z.string()).min(1, 'Vui lòng chọn ít nhất một phòng.').max(200),
          statusCode: z.string(),
          priority: z.boolean().optional(),
          note: z.string().max(1000).optional(),
          assigneeUserId: z.number().int().positive().nullable().optional(),
        })
        .parse(req.body ?? {});
      res.status(201).json(await createTasks(actorOf(req), body, getClock()));
    })().catch(next);
  });

  router.patch('/housekeeping/manager/tasks/:id', ...gate, (req, res, next) => {
    (async () => {
      const body = z
        .object({
          statusCode: z.string().optional(),
          // A work group's place: its ticked codes (OUT / OC / VC and/or OTHER).
          taskCodes: z.array(z.string().max(20)).max(4).optional(),
          priority: z.boolean().optional(),
          note: z.string().max(1000).nullable().optional(),
        })
        .parse(req.body ?? {});
      res.json({ task: await updateTask(actorOf(req), req.params.id!, body, getClock()) });
    })().catch(next);
  });

  router.post('/housekeeping/manager/tasks/:id/assign', ...gate, (req, res, next) => {
    (async () => {
      const body = z.object({ assigneeUserId: z.number().int().positive().nullable() }).parse(req.body ?? {});
      res.json({ task: await assignTask(actorOf(req), req.params.id!, body, getClock()) });
    })().catch(next);
  });

  router.post('/housekeeping/manager/tasks/:id/void', ...gate, (req, res, next) => {
    (async () => {
      const body = z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {});
      await voidTask(actorOf(req), req.params.id!, body, getClock());
      res.json({ voided: true, id: req.params.id });
    })().catch(next);
  });

  // "Đạt" / "Không đạt" (+ reason, + "Yêu cầu dọn lại" for a worker of the branch).
  router.post('/housekeeping/manager/tasks/:id/review', ...gate, (req, res, next) => {
    (async () => {
      const body = z
        .object({
          result: z.enum(['PASSED', 'FAILED']),
          reason: z.string().max(1000).optional(),
          reclean: z.boolean().optional(),
          assigneeUserId: z.number().int().positive().nullable().optional(),
        })
        .parse(req.body ?? {});
      res.json(await reviewTask(actorOf(req), req.params.id!, body, getClock()));
    })().catch(next);
  });

  // Every cleaning cycle of the room that business day.
  router.get('/housekeeping/manager/tasks/:id/history', ...gate, (req, res, next) => {
    (async () => {
      res.json({ cycles: await roomHistory(actorOf(req), req.params.id!) });
    })().catch(next);
  });

  router.get('/housekeeping/manager/staff', ...gate, (req, res, next) => {
    (async () => {
      res.json({ staff: await listStaff(actorOf(req), { branchId: req.query.branchId }) });
    })().catch(next);
  });

  router.get('/housekeeping/manager/overview', ...gate, (req, res, next) => {
    (async () => {
      const q = z.object({ date: isoDay, branchId: branchQuery }).parse(req.query);
      res.json(await overview(actorOf(req), { workDate: q.date, branchId: q.branchId }));
    })().catch(next);
  });

  router.get('/housekeeping/manager/staff-progress', ...gate, (req, res, next) => {
    (async () => {
      const q = periodSchema.parse(req.query);
      res.json({ rows: await staffProgress(actorOf(req), q) });
    })().catch(next);
  });

  router.get('/housekeeping/manager/staff/:userId', ...gate, (req, res, next) => {
    (async () => {
      const q = periodSchema.parse(req.query);
      const userId = z.coerce.number().int().positive().parse(req.params.userId);
      res.json(await staffDetail(actorOf(req), userId, q));
    })().catch(next);
  });

  router.get('/housekeeping/manager/kpi', ...gate, (req, res, next) => {
    (async () => {
      const q = periodSchema
        .and(
          z.object({
            userId: z.coerce.number().int().positive().optional(),
            status: z.enum(['PENDING', 'COLLECTED', 'UNCOLLECTIBLE']).optional(),
          }),
        )
        .parse(req.query);
      res.json(await housekeepingKpi(actorOf(req), q));
    })().catch(next);
  });

  router.get('/housekeeping/manager/report', ...gate, (req, res, next) => {
    (async () => {
      res.json(await operationsReport(actorOf(req), periodSchema.parse(req.query)));
    })().catch(next);
  });

  router.get(/^\/housekeeping\/manager\/report\.(pdf|xlsx)$/, ...gate, (req, res, next) => {
    (async () => {
      const kind = req.path.endsWith('.pdf') ? 'pdf' : 'xlsx';
      const q = periodSchema.parse(req.query);
      const actor = actorOf(req);
      const report = await operationsReport(actor, q);
      const data = { ...report, scope: await scopeLabel(actor, q.branchId), generatedAt: getClock().now() };
      const fileName = housekeepingOpsFileName(q.from, q.to, kind);
      // The PDF reports what was entered in "Dọn phòng"; the workbook adds the KPI sheet.
      if (kind === 'pdf') sendFile(res, await buildHousekeepingCleaningPdf(data), 'application/pdf', fileName);
      else sendFile(res, await buildHousekeepingOpsWorkbook(data), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName);
    })().catch(next);
  });

  /* ------------------------- work items: the manager ------------------------ */

  // "Chọn khu vực": the branch's floors and rooms, from its own catalog.
  router.get('/housekeeping/manager/areas', ...gate, (req, res, next) => {
    (async () => {
      const q = z.object({ branchId: branchQuery }).parse(req.query);
      res.json({ areas: await listWorkAreas(actorOf(req), { branchId: q.branchId }) });
    })().catch(next);
  });

  /* ---------------- WORK GROUPS — "Công việc 1, 2, …" (the manager) ---------------- */

  router.get('/housekeeping/manager/work-groups', ...gate, (req, res, next) => {
    (async () => {
      const q = z.object({ date: isoDay, branchId: branchQuery }).parse(req.query);
      res.json({ groups: await listWorkGroups(actorOf(req), { workDate: q.date, branchId: q.branchId }) });
    })().catch(next);
  });

  // "Tạo công việc": one group, its places, one transaction.
  router.post('/housekeeping/manager/work-groups', ...gate, (req, res, next) => {
    (async () => {
      const input = workGroupSchema.parse(req.body ?? {});
      const result = await createWorkGroup(actorOf(req), input, getClock());
      res.status(result.duplicate ? 200 : 201).json(result);
    })().catch(next);
  });

  // "Chỉnh sửa": the group's name.
  router.patch('/housekeeping/manager/work-groups/:id', ...gate, (req, res, next) => {
    (async () => {
      const body = z.object({ name: z.string().max(500).nullable().optional() }).parse(req.body ?? {});
      res.json({ group: await renameWorkGroup(actorOf(req), req.params.id!, body, getClock()) });
    })().catch(next);
  });

  // "Chỉnh sửa": more places. (A place is taken out with /manager/tasks/:id/void.)
  router.post('/housekeeping/manager/work-groups/:id/items', ...gate, (req, res, next) => {
    (async () => {
      const body = z.object({ items: z.array(groupItemSchema).max(50) }).parse(req.body ?? {});
      res.status(201).json({ group: await addWorkGroupItems(actorOf(req), req.params.id!, body, getClock()) });
    })().catch(next);
  });

  // "Giao" the whole group (null: "Chưa giao").
  router.post('/housekeeping/manager/work-groups/:id/assign', ...gate, (req, res, next) => {
    (async () => {
      const body = z.object({ assigneeUserId: z.number().int().positive().nullable() }).parse(req.body ?? {});
      res.json({ group: await assignWorkGroup(actorOf(req), req.params.id!, body, getClock()) });
    })().catch(next);
  });

  // "Không cần dọn": the manager's decision.
  router.post('/housekeeping/manager/tasks/:id/no-clean-decision', ...gate, (req, res, next) => {
    (async () => {
      const body = z.object({ approve: z.boolean(), note: z.string().max(1000).optional() }).parse(req.body ?? {});
      res.json({ task: await decideNoClean(actorOf(req), req.params.id!, body, getClock()) });
    })().catch(next);
  });

  /* ------------- "Các công việc trong ngày" and "Giao lại" (supervisors) ------------- */

  router.get('/housekeeping/work-orders', ...gate, (req, res, next) => {
    (async () => {
      const q = z.object({ date: isoDay, branchId: branchQuery }).parse(req.query);
      res.json({ tasks: await listWorkOrders(actorOf(req), { workDate: q.date, branchId: q.branchId }) });
    })().catch(next);
  });

  router.get('/housekeeping/work-orders/staff', ...gate, (req, res, next) => {
    (async () => {
      const q = z.object({ branchId: z.coerce.number().int().positive() }).parse(req.query);
      res.json({ staff: await reassignableStaff(actorOf(req), { branchId: q.branchId }) });
    })().catch(next);
  });

  // "Giao lại" an item inspected and waiting for cleaning — to another housekeeper of its branch.
  router.post('/housekeeping/work-orders/:id/reassign', ...gate, (req, res, next) => {
    (async () => {
      const input = reassignSchema.parse(req.body ?? {});
      res.json({ task: await reassignAwaitingCleaning(actorOf(req), req.params.id!, input, getClock()) });
    })().catch(next);
  });

  /* ------------------------------- the worker ----------------------------- */

  // The items of the branch the open shift established: the housekeeper's and the unclaimed.
  router.get('/housekeeping/work/items', ...gate, (req, res, next) => {
    (async () => {
      const q = z.object({ date: isoDay }).parse(req.query);
      res.json(await workList(actorOf(req), q.date));
    })().catch(next);
  });

  /* ---------------- WORK GROUPS — the housekeeper ---------------- */

  // The day's groups at the shift's branch, and who holds each.
  router.get('/housekeeping/work/groups', ...gate, (req, res, next) => {
    (async () => {
      const q = z.object({ date: isoDay }).parse(req.query);
      res.json(await workerGroups(actorOf(req), q.date));
    })().catch(next);
  });

  // "Nhận công việc": the whole group, never two owners.
  router.post('/housekeeping/work/groups/:id/accept', ...gate, (req, res, next) => {
    (async () => {
      res.json({ group: await acceptWorkGroup(actorOf(req), req.params.id!, getClock()) });
    })().catch(next);
  });

  // "Không cần dọn": asked for one room, with the reason.
  router.post('/housekeeping/work/tasks/:id/no-clean', ...gate, (req, res, next) => {
    (async () => {
      const body = z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {});
      res.json({ task: await requestNoClean(actorOf(req), req.params.id!, body, getClock()) });
    })().catch(next);
  });

  // The housekeeper's own finished work of a day, and that day's shifts.
  router.get('/housekeeping/work/history', ...gate, (req, res, next) => {
    (async () => {
      const q = z.object({ date: isoDay }).parse(req.query);
      res.json(await workerHistory(actorOf(req), q.date));
    })().catch(next);
  });

  // "Nhận" (an item created before work groups): exactly the selected items, all or none.
  router.post('/housekeeping/work/claim', ...gate, (req, res, next) => {
    (async () => {
      const input = claimSchema.parse(req.body ?? {});
      res.json({ tasks: await claimTasks(actorOf(req), input, getClock()) });
    })().catch(next);
  });

  // "Kiểm tra": the inspection begins — "Đang kiểm tra".
  router.post('/housekeeping/work/tasks/:id/begin-inspection', ...gate, (req, res, next) => {
    (async () => {
      res.json({ task: await beginInspection(actorOf(req), req.params.id!, getClock()) });
    })().catch(next);
  });

  router.get('/housekeeping/work', ...gate, (req, res, next) => {
    (async () => {
      const q = z.object({ date: isoDay }).parse(req.query);
      res.json({ tasks: await myTasks(actorOf(req), q.date) });
    })().catch(next);
  });

  router.get('/housekeeping/work/tasks/:id', ...gate, (req, res, next) => {
    (async () => {
      res.json({ task: await getTask(actorOf(req), req.params.id!) });
    })().catch(next);
  });

  router.post('/housekeeping/work/tasks/:id/open', ...gate, (req, res, next) => {
    (async () => {
      res.json({ task: await openTask(actorOf(req), req.params.id!, getClock()) });
    })().catch(next);
  });

  router.post('/housekeeping/work/tasks/:id/inspect', ...gate, (req, res, next) => {
    (async () => {
      const { issues, note } = issuesSchema.parse(req.body ?? {});
      res.status(201).json({ task: await inspectTask(actorOf(req), req.params.id!, { issues, note }, getClock()) });
    })().catch(next);
  });

  // "Bắt đầu dọn" — the explicit start; nothing else starts the cleaning time.
  router.post('/housekeeping/work/tasks/:id/start', ...gate, (req, res, next) => {
    (async () => {
      res.json({ task: await startTask(actorOf(req), req.params.id!, getClock()) });
    })().catch(next);
  });

  router.put('/housekeeping/work/tasks/:id/cleaning', ...gate, (req, res, next) => {
    (async () => {
      res.json({ task: await saveCleaning(actorOf(req), req.params.id!, req.body ?? {}, getClock()) });
    })().catch(next);
  });

  router.post('/housekeeping/work/tasks/:id/complete', ...gate, (req, res, next) => {
    (async () => {
      res.json({ task: await completeTask(actorOf(req), req.params.id!, req.body ?? {}, getClock()) });
    })().catch(next);
  });

  router.get('/housekeeping/kpi/me', ...gate, (req, res, next) => {
    (async () => {
      const q = periodSchema.parse(req.query);
      res.json(await myKpi(actorOf(req), q));
    })().catch(next);
  });

  return router;
}
