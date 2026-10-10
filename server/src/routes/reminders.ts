/**
 * Nhắc nhở API.
 *
 * Authorization is mounted once on the prefix, as every other KAS module does,
 * and the service re-checks it: creation is ADMIN-only, and every read is
 * filtered by the actor's own id in the database rather than by a check applied
 * after fetching. A receptionist cannot reach another receptionist's reminder
 * through any route here.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { requireAuth, requirePasswordChanged, requireRole } from '../middleware/auth';
import { ApiError } from '../lib/errors';
import {
  createReminder,
  listReminders,
  markReminderRead,
  createRemindersForAllBranches,
  unreadReminderCount,
  type ReminderActor,
} from '../reminder/reminderService';

function actorOf(req: Request): ReminderActor {
  const user = req.currentUser;
  if (!user) throw ApiError.authRequired();
  return { id: user.id, role: user.role };
}

const reminderBody = z.string().trim().min(1, 'Vui lòng nhập nội dung nhắc nhở.').max(2000);

const createSchema = z.object({
  recipientUserId: z.coerce.number().int().positive('Vui lòng chọn lễ tân nhận nhắc nhở.'),
  body: reminderBody,
});

/**
 * The same endpoint, addressed to everyone instead of one person.
 *
 * A discriminated body rather than a second route: "send a reminder" is one
 * operation and one permission, and splitting it would duplicate the ADMIN gate
 * and the body validation for the sake of the recipient field.
 */
const broadcastSchema = z.object({
  recipientScope: z.literal('ALL_BRANCHES'),
  body: reminderBody,
});

export function createRemindersRouter(): Router {
  const router = Router();

  // Reminders are Admin -> Receptionist. Bộ phận đặt phòng has no part in it.
  router.use('/reminders', requireAuth, requirePasswordChanged, requireRole('ADMIN', 'RECEPTIONIST'));

  // GET /api/reminders — receptionist: their inbox. Admin: what they sent.
  router.get('/reminders', (req, res, next) => {
    (async () => {
      res.json({ reminders: await listReminders(actorOf(req)) });
    })().catch(next);
  });

  // GET /api/reminders/unread-count — the badge. Mounted before /:id.
  router.get('/reminders/unread-count', (req, res, next) => {
    (async () => {
      res.json({ count: await unreadReminderCount(actorOf(req)) });
    })().catch(next);
  });

  // POST /api/reminders — ADMIN only (re-checked in the service).
  router.post('/reminders', requireRole('ADMIN'), (req, res, next) => {
    (async () => {
      const raw = req.body ?? {};
      if (raw.recipientScope !== undefined) {
        const input = broadcastSchema.parse(raw);
        const result = await createRemindersForAllBranches(input, actorOf(req));
        res.status(201).json(result);
        return;
      }
      const input = createSchema.parse(raw);
      res.status(201).json({ reminder: await createReminder(input, actorOf(req)) });
    })().catch(next);
  });

  // POST /api/reminders/:id/read — recipient only.
  router.post('/reminders/:id/read', (req, res, next) => {
    (async () => {
      const id = req.params.id;
      if (!id) throw ApiError.notFound('Không tìm thấy nhắc nhở.');
      res.json({ reminder: await markReminderRead(id, actorOf(req)) });
    })().catch(next);
  });

  return router;
}
