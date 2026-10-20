/**
 * HOUSEKEEPING WAREHOUSES — /api/housekeeping/inventory/…
 *
 * The gate is the session; WHO may do WHAT, and on which branch, is decided in
 * `inventoryService` from the account — never from a branch named here.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, requirePasswordChanged } from '../middleware/auth';
import { getClock } from '../lib/clock';
import { prisma } from '../db/prisma';
import { contentDisposition } from '../report/format';
import { buildInventoryWorkbook, inventoryFileName } from '../report/inventoryReport';
import type { HousekeepingActor } from '../housekeeping/roomIssueService';
import {
  addCatalogItems,
  createCount,
  createDamageReport,
  createItem,
  createItems,
  seesReconciliation,
  createReceipt,
  createTransfer,
  damageSources,
  inventoryCatalog,
  listFormMapping,
  mapItemToForm,
  listCounts,
  listDamageReports,
  listItems,
  listMovements,
  listReceipts,
  removeItem,
  reviewDamageReport,
  updateItem,
} from '../housekeeping/inventoryService';

const actorOf = (req: Request): HousekeepingActor => {
  const u = req.currentUser!;
  return { id: u.id, role: u.role, branchId: u.branchId, fullName: u.fullName, managedBranchIds: u.managedBranchIds };
};

const branchQuery = z.coerce.number().int().positive().optional();
const listQuery = z.object({
  branchId: branchQuery,
  warehouse: z.string().optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
  onlyDifferences: z.enum(['true', 'false']).optional(),
  status: z.string().optional(),
  itemId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().optional(),
});

const lines = z.array(z.record(z.unknown())).max(100);

/** What the file says it covers: the manager's hotel, one branch, or every branch. */
async function scopeOf(actor: HousekeepingActor, branchId?: number): Promise<string> {
  const id = actor.role === 'HOUSEKEEPING_MANAGER' ? actor.branchId : branchId;
  if (!id) return 'Tất cả chi nhánh';
  const b = await prisma.branch.findUnique({ where: { id }, select: { address: true } });
  return b?.address ?? 'Chi nhánh';
}

function sendXlsx(res: Response, body: Buffer, fileName: string): void {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', contentDisposition(fileName));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(body);
}

export function createInventoryRouter(): Router {
  const router = Router();
  const gate = [requireAuth, requirePasswordChanged];
  const base = '/housekeeping/inventory';

  router.get(`${base}/catalog`, ...gate, (_req, res) => {
    res.json(inventoryCatalog());
  });

  router.get(`${base}/items`, ...gate, (req, res, next) => {
    (async () => {
      const q = listQuery.parse(req.query);
      res.json({ items: await listItems(actorOf(req), { branchId: q.branchId, warehouse: q.warehouse, includeArchived: q.includeArchived === 'true' }) });
    })().catch(next);
  });

  router.post(`${base}/items`, ...gate, (req, res, next) => {
    (async () => {
      res.status(201).json({ item: await createItem(actorOf(req), (req.body ?? {}) as never) });
    })().catch(next);
  });

  // "Thêm mặt hàng" — several new items of one warehouse, all or none.
  router.post(`${base}/items/batch`, ...gate, (req, res, next) => {
    (async () => {
      const body = z.object({ items: z.array(z.record(z.unknown())).max(50) }).passthrough().parse(req.body ?? {});
      res.status(201).json({ items: await createItems(actorOf(req), body as never) });
    })().catch(next);
  });

  // "Thêm từ form dọn phòng" — the form's items this branch does not keep yet.
  router.post(`${base}/items/from-catalog`, ...gate, (req, res, next) => {
    (async () => {
      res.json(await addCatalogItems(actorOf(req), (req.body ?? {}).warehouse));
    })().catch(next);
  });

  router.patch(`${base}/items/:id`, ...gate, (req, res, next) => {
    (async () => {
      res.json({ item: await updateItem(actorOf(req), req.params.id!, req.body ?? {}) });
    })().catch(next);
  });

  // Removed when never used; archived ("Ngừng sử dụng") otherwise.
  router.delete(`${base}/items/:id`, ...gate, (req, res, next) => {
    (async () => {
      res.json(await removeItem(actorOf(req), req.params.id!));
    })().catch(next);
  });

  // "Gắn với form dọn phòng": each form field and the one item it moves.
  router.get(`${base}/mapping`, ...gate, (req, res, next) => {
    (async () => {
      const q = listQuery.parse(req.query);
      res.json({ fields: await listFormMapping(actorOf(req), { branchId: q.branchId, warehouse: q.warehouse }) });
    })().catch(next);
  });

  router.put(`${base}/items/:id/mapping`, ...gate, (req, res, next) => {
    (async () => {
      const body = z.object({ catalogKey: z.string().nullable(), confirmKit: z.boolean().optional() }).parse(req.body ?? {});
      res.json({ item: await mapItemToForm(actorOf(req), req.params.id!, body) });
    })().catch(next);
  });

  router.get(`${base}/receipts`, ...gate, (req, res, next) => {
    (async () => {
      const q = listQuery.parse(req.query);
      res.json({ receipts: await listReceipts(actorOf(req), { branchId: q.branchId, warehouse: q.warehouse }) });
    })().catch(next);
  });

  router.post(`${base}/receipts`, ...gate, (req, res, next) => {
    (async () => {
      const body = z.object({ lines }).passthrough().parse(req.body ?? {});
      const result = await createReceipt(actorOf(req), body as never, getClock());
      res.status(result.duplicate ? 200 : 201).json(result);
    })().catch(next);
  });

  router.get(`${base}/counts`, ...gate, (req, res, next) => {
    (async () => {
      const q = listQuery.parse(req.query);
      res.json({ counts: await listCounts(actorOf(req), { branchId: q.branchId, warehouse: q.warehouse, onlyDifferences: q.onlyDifferences === 'true' }) });
    })().catch(next);
  });

  router.post(`${base}/counts`, ...gate, (req, res, next) => {
    (async () => {
      const body = z.object({ lines }).passthrough().parse(req.body ?? {});
      const result = await createCount(actorOf(req), body as never, getClock());
      res.status(result.duplicate ? 200 : 201).json(result);
    })().catch(next);
  });

  // "Xuất dùng", "Thu hồi" (the laundry moves are no longer offered).
  router.post(`${base}/transfers`, ...gate, (req, res, next) => {
    (async () => {
      const body = z.object({ lines }).passthrough().parse(req.body ?? {});
      const result = await createTransfer(actorOf(req), body as never, getClock());
      res.status(result.duplicate ? 200 : 201).json(result);
    })().catch(next);
  });

  router.get(`${base}/damage`, ...gate, (req, res, next) => {
    (async () => {
      const q = listQuery.parse(req.query);
      res.json({ reports: await listDamageReports(actorOf(req), q) });
    })().catch(next);
  });

  // What a damage report may name as its source — this branch's work and incidents.
  router.get(`${base}/damage/sources`, ...gate, (req, res, next) => {
    (async () => {
      res.json(await damageSources(actorOf(req), { roomNumber: req.query.roomNumber }, getClock()));
    })().catch(next);
  });

  router.post(`${base}/damage`, ...gate, (req, res, next) => {
    (async () => {
      const result = await createDamageReport(actorOf(req), (req.body ?? {}) as never, getClock());
      res.status(result.duplicate ? 200 : 201).json(result);
    })().catch(next);
  });

  router.post(`${base}/damage/:id/review`, ...gate, (req, res, next) => {
    (async () => {
      res.json({ report: await reviewDamageReport(actorOf(req), req.params.id!, req.body ?? {}, getClock()) });
    })().catch(next);
  });

  router.get(`${base}/movements`, ...gate, (req, res, next) => {
    (async () => {
      const q = listQuery.parse(req.query);
      res.json({ movements: await listMovements(actorOf(req), { branchId: q.branchId, warehouse: q.warehouse, itemId: q.itemId, limit: q.limit }) });
    })().catch(next);
  });

  // "Xuất Excel": the stock, the damage reports and the counting differences — the reader's scope only.
  router.get(`${base}/export.xlsx`, ...gate, (req, res, next) => {
    (async () => {
      const actor = actorOf(req);
      const q = listQuery.parse(req.query);
      const scope = { branchId: q.branchId, warehouse: q.warehouse };
      // The counting differences are the Admin's sheet only.
      const [items, damage, counts] = await Promise.all([
        listItems(actor, { ...scope, includeArchived: true }),
        listDamageReports(actor, scope),
        seesReconciliation(actor) ? listCounts(actor, { ...scope, onlyDifferences: true }) : Promise.resolve(undefined),
      ]);
      const now = getClock().now();
      const body = await buildInventoryWorkbook({ scope: await scopeOf(actor, q.branchId), generatedAt: now, items, damage, counts });
      sendXlsx(res, body, inventoryFileName(now));
    })().catch(next);
  });

  return router;
}
