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
  completeTask,
  createTasks,
  getTask,
  inspectTask,
  listStaff,
  listTasks,
  myTasks,
  openTask,
  saveCleaning,
  updateTask,
  voidTask,
} from '../housekeeping/roomTaskService';
import { housekeepingKpi, myKpi, operationsReport, overview, staffDetail, staffProgress } from '../housekeeping/housekeepingKpi';
import { buildHousekeepingOpsPdf, buildHousekeepingOpsWorkbook, housekeepingOpsFileName } from '../report/housekeepingOpsReport';
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
        .object({ statusCode: z.string().optional(), priority: z.boolean().optional(), note: z.string().max(1000).nullable().optional() })
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

  router.get('/housekeeping/manager/staff', ...gate, (req, res, next) => {
    (async () => {
      res.json({ staff: await listStaff(actorOf(req), { branchId: req.query.branchId, date: req.query.date }) });
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
      if (kind === 'pdf') sendFile(res, await buildHousekeepingOpsPdf(data), 'application/pdf', fileName);
      else sendFile(res, await buildHousekeepingOpsWorkbook(data), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName);
    })().catch(next);
  });

  /* ------------------------------- the worker ----------------------------- */

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
      const { issues } = issuesSchema.parse(req.body ?? {});
      res.status(201).json({ task: await inspectTask(actorOf(req), req.params.id!, { issues }, getClock()) });
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
