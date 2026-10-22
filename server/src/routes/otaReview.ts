/**
 * Admin-only OTA review endpoint.
 *
 * One stateless route: given the pasted text and the Admin's corrections, it
 * returns the fully-resolved review — branch, room lines with their internal
 * codes, prices, the exact PMS note, and precisely why dispatch is or is not
 * allowed.
 *
 * Stateless on purpose. Editing a review writes nothing, so an Admin can adjust
 * a price or swap a branch without leaving half-finished rows behind, and the
 * note shown always corresponds to what the server would actually generate.
 *
 * NOTHING THE CLIENT SENDS IS TRUSTED. The branch must be active, and a
 * submitted PMS code is re-validated against the selected branch's own
 * catalogue — a code that branch does not have is refused, never accepted
 * because the browser asked.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireAdmin, requirePasswordChanged } from '../middleware/auth';
import { buildOtaReviewFromText } from '../booking/otaReviewService';
import { dispatchOtaReview } from '../booking/otaDispatch';
import { readRequestOrigin } from '../booking/requestAudit';
import { applyAmendment, buildAmendment } from '../booking/otaAmendment';

/**
 * A room line as the browser sends it back.
 *
 * Zod DROPS keys it does not declare, so every field a room line carries has to
 * be declared here even when the server re-derives it — otherwise the value
 * survives the first response and then vanishes the moment the Admin edits
 * anything, which looks exactly like a parser failure.
 *
 * The audit and nightly fields are accepted but never trusted: the server
 * recomputes them from the pasted text, and `pmsCode` is re-validated against
 * the selected branch.
 */
const roomLineSchema = z.object({
  quantity: z.number().int().min(1, 'Số lượng phòng phải lớn hơn 0.').max(50),
  otaRoomName: z.string().trim().max(300).nullable(),
  rawOtaRoomName: z.string().trim().max(300).nullable().optional(),
  otaRoomTypeId: z.string().trim().max(100).nullable(),
  /** A proposal only — the server checks it against the branch. */
  pmsCode: z.string().trim().max(40).nullable(),
  requiresManualMapping: z.boolean(),
  sourceNightlyTotal: z.number().int().nonnegative().nullable().optional(),
  perRoomNightlyRate: z.number().int().nonnegative().nullable().optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải có định dạng YYYY-MM-DD.');

const overridesSchema = z
  .object({
    branchId: z.number().int().positive().nullable().optional(),
    bookingCode: z.string().trim().max(100).nullable().optional(),
    guestName: z.string().trim().max(200).nullable().optional(),
    checkIn: isoDate.nullable().optional(),
    checkOut: isoDate.nullable().optional(),
    rooms: z.array(roomLineSchema).max(20).optional(),
    branchPrice: z.number().int().nonnegative().nullable().optional(),
    guestBookedPrice: z.number().int().nonnegative().nullable().optional(),
    breakfastIncluded: z.boolean().nullable().optional(),
    paymentMode: z.enum(['CN', 'HOTEL_PAYMENT']).optional(),
  })
  .strict();

const reviewSchema = z.object({
  // Only the two platforms this review serves. Booking.com has its own,
  // already-operational path and must never be routed through here.
  source: z.enum(['AGODA', 'CTRIP']),
  rawText: z.string().min(1, 'Nội dung không được để trống.').max(50000, 'Nội dung quá dài.'),
  overrides: overridesSchema.optional(),
});

/**
 * An amendment adds the reviewer's verdict to the review body: which changed
 * fields they accepted. Omitting it accepts them all.
 */
const amendmentSchema = reviewSchema.extend({
  acceptedFields: z.array(z.string().trim().max(100)).max(50).optional(),
  expectedVersion: z.string().trim().max(40).optional(),
});

export function createOtaReviewRouter(): Router {
  const router = Router();
  router.use('/admin/ota', requireAuth, requirePasswordChanged, requireAdmin);

  // POST /api/admin/ota/review — build or recompute the review.
  router.post('/admin/ota/review', (req, res, next) => {
    (async () => {
      const input = reviewSchema.parse(req.body ?? {});
      res.json(await buildOtaReviewFromText(input));
    })().catch(next);
  });

  /**
   * POST /api/admin/ota/dispatch — persist the reviewed reservation.
   *
   * Takes the same body as the review, deliberately: the server rebuilds the
   * review from the pasted text and the Admin's corrections and dispatches THAT
   * — a client cannot submit a booking the review screen would have blocked.
   *
   * EXACTLY the review body, again. It briefly required an extra `adminPmsNote`
   * naming who created the reservation in the PMS; 5.2d removed that field, and
   * the schema went with it. A body that still carries one is accepted and the
   * value ignored — Zod strips unknown keys — so a browser left open across the
   * upgrade keeps working rather than failing validation mid-shift.
   *
   * Idempotent by (booking code, platform), so a double click, a retry or a
   * resubmitted form returns the booking already dispatched rather than
   * creating a second one. 200 for an existing booking, 201 for a new one.
   */
  router.post('/admin/ota/dispatch', (req, res, next) => {
    (async () => {
      const input = reviewSchema.parse(req.body ?? {});
      const actor = req.currentUser!;
      const result = await dispatchOtaReview(input, {
        id: actor.id,
        fullName: actor.fullName,
        origin: readRequestOrigin(req),
      });
      res.status(result.created ? 201 : 200).json({
        bookingId: result.bookingId,
        created: result.created,
        review: result.review,
      });
    })().catch(next);
  });

  /**
   * POST /api/admin/ota/amendment — compare an amended mail with the booking.
   *
   * Writes NOTHING. Returns every field that differs so a reviewer can see
   * exactly what would change before anything does, plus whether the platform
   * itself says the reservation is cancelled — reported, never acted on.
   */
  router.post('/admin/ota/amendment', (req, res, next) => {
    (async () => {
      const input = reviewSchema.parse(req.body ?? {});
      res.json(await buildAmendment(input));
    })().catch(next);
  });

  /**
   * POST /api/admin/ota/amendment/apply — apply the accepted changes.
   *
   * `acceptedFields` omitted means every change; an empty array means the
   * reviewer rejected all of them and the booking is left untouched. Each
   * applied field becomes an immutable correction row.
   */
  router.post('/admin/ota/amendment/apply', (req, res, next) => {
    (async () => {
      const input = amendmentSchema.parse(req.body ?? {});
      const actor = req.currentUser!;
      res.json(
        await applyAmendment(input, { id: actor.id, origin: readRequestOrigin(req) }),
      );
    })().catch(next);
  });

  return router;
}
