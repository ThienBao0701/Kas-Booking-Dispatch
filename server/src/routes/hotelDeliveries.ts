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
import type { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock } from '../lib/clock';
import { requireAuth, requirePasswordChanged } from '../middleware/auth';
import { REPORT_INCLUDE, serializeReport } from '../reception/reportService';
import { lifecycleWhere } from '../reception/deliveryLifecycle';
import { hcmRange } from '../booking/recreationReport';
import { scopedBranchFilter } from '../auth/branchScope';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const querySchema = z
  .object({
    scope: z.enum(['active', 'archived']).default('active'),
    branchId: z.coerce.number().int().positive().optional(),
    // The days a delivery was RECEIVED on (inclusive Vietnamese calendar days) —
    // the same instant the 12-hour rule runs from. A window narrows a list; it
    // never admits a row the rule keeps on the other side.
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

/** Who may read which deliveries — the whole authorization rule, in one function. */
export function deliveryVisibilityWhere(
  user: { role: UserRole; branchId: number | null; managedBranchIds?: number[] },
  filter: { branchId?: number },
): Prisma.ReceptionOperationalReportWhereInput {
  switch (user.role) {
    // Reception's view of its branches — every department's deliveries — for
    // the managers: assigned branches, or all eight; another branch is refused.
    case 'RECEPTION_MANAGER':
    case 'RECEPTION_GENERAL_MANAGER':
      return scopedBranchFilter(user, filter.branchId);
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
      const received = q.from && q.to ? hcmRange(q.from, q.to) : null;

      const where: Prisma.ReceptionOperationalReportWhereInput = {
        ...visible,
        category: 'HOTEL_DELIVERY',
        // Combined with the role's own `delivery` filter, never replacing it.
        AND: [
          { delivery: { is: lifecycleWhere(q.scope, now) } },
          ...(received ? [{ createdAt: { gte: received.start, lt: received.end } }] : []),
        ],
      };
      const [rows, total] = await Promise.all([
        prisma.receptionOperationalReport.findMany({
          where,
          include: REPORT_INCLUDE,
          orderBy: { createdAt: 'desc' },
          take: 500,
        }),
        prisma.receptionOperationalReport.count({ where }),
      ]);
      res.json({
        scope: q.scope,
        deliveries: rows.map((r) => serializeReport(r, now)),
        // The full count: the list is a page, and a screen can say so.
        total,
      });
    })().catch(next);
  });

  return router;
}
