/**
 * Reception's operational actions on a dispatched booking.
 *
 *   POST /api/bookings/:id/receive     the branch acknowledges the booking
 *   POST /api/bookings/:id/check-in    the guest actually arrived
 *   POST /api/bookings/:id/check-out   the guest actually departed
 *   POST /api/bookings/:id/complete    the stay is closed
 *   POST /api/bookings/:id/cancel      the booking will not happen
 *   POST /api/bookings/:id/no-show     the guest never arrived
 *
 * A NEW router rather than an addition to `bookings.ts`, so the existing
 * Booking.com read and proof routes are not touched at all.
 *
 * Mounted BEFORE the generic booking router: `/bookings/:id/receive` must not
 * be swallowed by `/bookings/:id`.
 *
 * Authorisation is enforced twice on purpose — the route rejects a receptionist
 * from another branch, and `applyLifecycleAction` checks again at the write.
 * The route can be re-mounted or reordered; the service is where the row
 * actually changes.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePasswordChanged, requireRole } from '../middleware/auth';
import { applyLifecycleAction, type LifecycleAction } from '../booking/lifecycle';
import { readRequestOrigin } from '../booking/requestAudit';

/**
 * WHO OPERATES A BOOKING THROUGH ITS STAY.
 *
 * An ALLOW-LIST, not a negative test, and that distinction is the point. The
 * branch check inside `applyLifecycleAction` reads
 * `actor.role === 'RECEPTIONIST' && booking.branchId !== actor.branchId`, so any
 * role that is not a receptionist skips it entirely. That was harmless while
 * every authenticated user either was one or was an Admin; with branchless
 * departments in the system it would have let Bộ phận kỹ thuật check a guest in
 * at a property it has no connection to.
 *
 * Naming the two roles that DO operate bookings means a future department gets
 * nothing here by default, which is the correct direction for a mistake to fail.
 */
const requireBookingOperator = requireRole('ADMIN', 'RECEPTIONIST');

/** A reason is optional everywhere, and required nowhere but cancellation. */
const bodySchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict()
  .optional();

const ACTIONS: ReadonlyArray<{ path: string; action: LifecycleAction }> = [
  { path: 'receive', action: 'RECEIVE' },
  { path: 'check-in', action: 'CHECK_IN' },
  { path: 'check-out', action: 'CHECK_OUT' },
  { path: 'complete', action: 'COMPLETE' },
  { path: 'cancel', action: 'CANCEL' },
  { path: 'no-show', action: 'NO_SHOW' },
];

export function createBookingLifecycleRouter(): Router {
  const router = Router();

  for (const { path, action } of ACTIONS) {
    router.post(
      `/bookings/:id/${path}`,
      requireAuth,
      requirePasswordChanged,
      requireBookingOperator,
      (req, res, next) => {
        (async () => {
          const body = bodySchema.parse(req.body ?? {}) ?? {};
          const user = req.currentUser!;
          const result = await applyLifecycleAction(
            req.params.id!,
            action,
            {
              id: user.id,
              role: user.role,
              branchId: user.branchId ?? null,
              origin: readRequestOrigin(req),
            },
            { reason: body.reason },
          );
          res.json(result);
        })().catch(next);
      },
    );
  }

  return router;
}
