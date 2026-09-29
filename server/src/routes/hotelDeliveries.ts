/**
 * "GIAO NHẬN HÀNG HÓA CỦA KHÁCH SẠN" — the shared read side.
 *
 * ONE ENDPOINT FOR EVERY ROLE THAT MAY SEE A DELIVERY, and one place that says
 * which ones. The rows are the reception journal's own (`HOTEL_DELIVERY`
 * reports), so Reception writes them through `/reception/reports` and the Admin
 * reads them in the period report; this route is how the other departments and
 * the "Hoàn thành vấn đề" screen read the SAME rows — there is no per-role copy.
 *
 *   RECEPTIONIST   their own branch, every department, voided rows included
 *   ADMIN          every branch (or one, with ?branchId), voided rows included
 *   HOUSEKEEPING   their own branch, the Buồng phòng department, live rows only
 *   TECHNICAL      every branch, the Kỹ thuật department, live rows only
 *
 * `scope` splits the list at the 12-hour rule (`deliveryLifecycle.ts`):
 * `active` is what is still on the working screen, `archived` is "Hoàn thành
 * vấn đề". Read-only — nothing here writes.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock } from '../lib/clock';
import { requireAuth, requirePasswordChanged } from '../middleware/auth';
import { REPORT_INCLUDE, serializeReport } from '../reception/reportService';
import { lifecycleWhere } from '../reception/deliveryLifecycle';

const querySchema = z.object({
  scope: z.enum(['active', 'archived']).default('active'),
  branchId: z.coerce.number().int().positive().optional(),
});

/** Who may read which deliveries — the whole authorization rule, in one function. */
export function deliveryVisibilityWhere(
  user: { role: string; branchId: number | null },
  filter: { branchId?: number },
): Prisma.ReceptionOperationalReportWhereInput {
  switch (user.role) {
    case 'RECEPTIONIST':
      // `?? -1` matches no branch: an unassigned account sees nothing, and the
      // key is never left out — leaving it out would widen the query.
      return { branchId: user.branchId ?? -1 };
    case 'ADMIN':
      return filter.branchId !== undefined ? { branchId: filter.branchId } : {};
    case 'HOUSEKEEPING':
      return {
        branchId: user.branchId ?? -1,
        voidedAt: null,
        delivery: { is: { department: 'HOUSEKEEPING' } },
      };
    case 'TECHNICAL':
      return {
        ...(filter.branchId !== undefined ? { branchId: filter.branchId } : {}),
        voidedAt: null,
        delivery: { is: { department: 'TECHNICAL' } },
      };
    default:
      throw ApiError.forbidden('Bạn không có quyền xem giao nhận hàng hóa.');
  }
}

export function createHotelDeliveriesRouter(): Router {
  const router = Router();

  router.get('/hotel-deliveries', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const q = querySchema.parse(req.query);
      const now = getClock().now();
      const visible = deliveryVisibilityWhere(user, { branchId: q.branchId });

      const rows = await prisma.receptionOperationalReport.findMany({
        where: {
          ...visible,
          category: 'HOTEL_DELIVERY',
          // Combined with the role's own `delivery` filter, never replacing it.
          AND: [{ delivery: { is: lifecycleWhere(q.scope, now) } }],
        },
        include: REPORT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      res.json({
        scope: q.scope,
        deliveries: rows.map((r) => serializeReport(r, now)),
      });
    })().catch(next);
  });

  return router;
}
