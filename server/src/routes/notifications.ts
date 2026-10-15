import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock } from '../lib/clock';
import { requireAuth, requirePasswordChanged } from '../middleware/auth';

const listQuery = z.object({
  unreadOnly: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

function view(n: {
  id: string;
  bookingId: string | null;
  link: string | null;
  kind: string | null;
  title: string;
  body: string;
  read: boolean;
  createdAt: Date;
  readAt: Date | null;
}) {
  return {
    id: n.id,
    bookingId: n.bookingId,
    /** Where a press goes — an in-app path; null on older rows. */
    link: n.link,
    kind: n.kind,
    title: n.title,
    body: n.body,
    read: n.read,
    createdAt: n.createdAt.toISOString(),
    readAt: n.readAt ? n.readAt.toISOString() : null,
  };
}

/**
 * Persistent in-app notifications. Polling-ready (no SSE in this phase). Every
 * query and mutation is scoped to the authenticated user, so one user can never
 * see or modify another user's notifications.
 */
export function createNotificationsRouter(): Router {
  const router = Router();
  router.use('/notifications', requireAuth, requirePasswordChanged);

  // GET /api/notifications — the caller's own notifications, newest first.
  router.get('/notifications', (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const query = listQuery.parse(req.query);
      const where: Prisma.NotificationWhereInput = { userId: user.id };
      if (query.unreadOnly === 'true') where.read = false;

      const skip = (query.page - 1) * query.pageSize;
      const [total, unreadCount, rows] = await prisma.$transaction([
        prisma.notification.count({ where }),
        prisma.notification.count({ where: { userId: user.id, read: false } }),
        prisma.notification.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: query.pageSize,
        }),
      ]);

      res.json({
        notifications: rows.map(view),
        unreadCount,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
        },
      });
    })().catch(next);
  });

  // GET /api/notifications/unread-count — for a polling badge.
  router.get('/notifications/unread-count', (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const count = await prisma.notification.count({ where: { userId: user.id, read: false } });
      res.json({ count });
    })().catch(next);
  });

  // POST /api/notifications/read-all — mark every own notification read.
  router.post('/notifications/read-all', (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const result = await prisma.notification.updateMany({
        where: { userId: user.id, read: false },
        data: { read: true, readAt: getClock().now() },
      });
      res.json({ updated: result.count });
    })().catch(next);
  });

  // POST /api/notifications/:id/read — mark one own notification read.
  router.post('/notifications/:id/read', (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      // Scoped to the owner: another user's id simply matches nothing.
      const result = await prisma.notification.updateMany({
        where: { id: req.params.id!, userId: user.id },
        data: { read: true, readAt: getClock().now() },
      });
      if (result.count === 0) throw ApiError.notFound('Không tìm thấy thông báo.');
      res.json({ success: true });
    })().catch(next);
  });

  return router;
}
