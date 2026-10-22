/**
 * Booking guest API (Phase C.3.8).
 *
 * Guest management is an operational task, so a receptionist may do it — but
 * strictly for a booking of their OWN branch that has actually been dispatched
 * to them. That check lives in the service (`authorizeBooking`), which every
 * handler here goes through, so branch isolation is enforced server-side no
 * matter which route is called.
 *
 * Re-applying the room mapping is deliberately NOT operational: it is
 * Admin-only, needs a reason, and is refused for completed/archived bookings.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePasswordChanged } from '../middleware/auth';
import { ApiError } from '../lib/errors';
import {
  addGuest,
  createGuestSchema,
  listBookingAudit,
  listGuests,
  removeGuest,
  setPrimaryGuest,
  updateGuest,
  updateGuestSchema,
  type GuestActor,
} from '../booking/guestService';
import {
  applyLatestMapping,
  previewLatestMapping,
  setManualRoomClass,
} from '../room/roomSnapshotService';

const reasonSchema = z.object({ reason: z.string().trim().min(1, 'Cần nêu lý do.').max(500) });

const roomClassSelectionSchema = z.object({
  roomClassId: z.string().trim().min(1, 'Chưa chọn mã hạng phòng nội bộ.'),
});

function roomIndexOf(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw ApiError.notFound('Không tìm thấy hạng phòng trong đơn này.');
  }
  return value;
}

function actorOf(req: Parameters<Parameters<Router['get']>[1]>[0]): GuestActor {
  const user = req.currentUser;
  if (!user) throw ApiError.authRequired();
  return { id: user.id, role: user.role, branchId: user.branchId };
}

function bookingIdOf(raw: string | undefined): string {
  if (!raw || raw.trim().length === 0) throw ApiError.notFound('Không tìm thấy đơn đặt phòng.');
  return raw;
}

function guestIdOf(raw: string | undefined): string {
  if (!raw || raw.trim().length === 0) throw ApiError.notFound('Không tìm thấy khách.');
  return raw;
}

export function createBookingGuestsRouter(): Router {
  const router = Router();
  router.use('/bookings/:id/guests', requireAuth, requirePasswordChanged);
  router.use('/bookings/:id/audit', requireAuth, requirePasswordChanged);
  router.use('/bookings/:id/room-mapping', requireAuth, requirePasswordChanged);
  // The room-class selector. Authentication is mounted per prefix here, so a
  // new path without its own line would reach the handler with no session and
  // fail as "not signed in" rather than as the thing it actually is.
  router.use('/bookings/:id/rooms', requireAuth, requirePasswordChanged);

  // GET /api/bookings/:id/guests
  router.get('/bookings/:id/guests', (req, res, next) => {
    (async () => {
      res.json({ guests: await listGuests(bookingIdOf(req.params.id), actorOf(req)) });
    })().catch(next);
  });

  // POST /api/bookings/:id/guests — add a guest. Existing guests untouched.
  router.post('/bookings/:id/guests', (req, res, next) => {
    (async () => {
      const input = createGuestSchema.parse(req.body ?? {});
      const guests = await addGuest(bookingIdOf(req.params.id), input, actorOf(req));
      res.status(201).json({ guests });
    })().catch(next);
  });

  // PATCH /api/bookings/:id/guests/:guestId — partial update. Only the keys
  // actually present are written; everything else is preserved.
  router.patch('/bookings/:id/guests/:guestId', (req, res, next) => {
    (async () => {
      const input = updateGuestSchema.parse(req.body ?? {});
      const guests = await updateGuest(
        bookingIdOf(req.params.id),
        guestIdOf(req.params.guestId),
        input,
        actorOf(req),
      );
      res.json({ guests });
    })().catch(next);
  });

  // DELETE /api/bookings/:id/guests/:guestId
  router.delete('/bookings/:id/guests/:guestId', (req, res, next) => {
    (async () => {
      const guests = await removeGuest(
        bookingIdOf(req.params.id),
        guestIdOf(req.params.guestId),
        actorOf(req),
      );
      res.json({ guests });
    })().catch(next);
  });

  // POST /api/bookings/:id/guests/:guestId/primary
  router.post('/bookings/:id/guests/:guestId/primary', (req, res, next) => {
    (async () => {
      const guests = await setPrimaryGuest(
        bookingIdOf(req.params.id),
        guestIdOf(req.params.guestId),
        actorOf(req),
      );
      res.json({ guests });
    })().catch(next);
  });

  // GET /api/bookings/:id/audit — booking-scoped audit trail.
  router.get('/bookings/:id/audit', (req, res, next) => {
    (async () => {
      res.json({ events: await listBookingAudit(bookingIdOf(req.params.id), actorOf(req)) });
    })().catch(next);
  });

  // GET /api/bookings/:id/room-mapping/preview — what re-applying WOULD do.
  // Read-only: shows the current snapshot beside the latest mapping so the
  // Admin can compare before deciding. Changes nothing.
  router.get('/bookings/:id/room-mapping/preview', (req, res, next) => {
    (async () => {
      const actor = actorOf(req);
      if (actor.role !== 'ADMIN') throw ApiError.forbidden();
      res.json({ rooms: await previewLatestMapping(bookingIdOf(req.params.id)) });
    })().catch(next);
  });

  // POST /api/bookings/:id/room-mapping/apply-latest — explicit, audited,
  // Admin-only, reason required, refused for completed/archived bookings.
  router.post('/bookings/:id/room-mapping/apply-latest', (req, res, next) => {
    (async () => {
      const { reason } = reasonSchema.parse(req.body ?? {});
      const result = await applyLatestMapping(bookingIdOf(req.params.id), reason, actorOf(req));
      res.json(result);
    })().catch(next);
  });

  // PUT /api/bookings/:id/rooms/:roomIndex/room-class — the Admin chooses the
  // internal room class for one room. Admin-only and audited; the service
  // validates the class against the booking's branch and ACTIVE mapping
  // version and records the choice as MANUAL, so the note the receptionist
  // eventually pastes is generated from exactly what was selected here.
  router.put('/bookings/:id/rooms/:roomIndex/room-class', (req, res, next) => {
    (async () => {
      const { roomClassId } = roomClassSelectionSchema.parse(req.body ?? {});
      const room = await setManualRoomClass(
        bookingIdOf(req.params.id),
        roomIndexOf(req.params.roomIndex),
        roomClassId,
        actorOf(req),
      );
      res.json({ room });
    })().catch(next);
  });

  return router;
}
