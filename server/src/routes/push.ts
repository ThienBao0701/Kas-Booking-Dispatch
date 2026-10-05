/**
 * WEB PUSH SUBSCRIPTIONS — "Bật thông báo" on this device.
 *
 * Every route is the signed-in account's own: a subscription is always saved
 * for `req.currentUser`, and removed only where it belongs to it. No body field
 * names a user. The private VAPID key never leaves the server; the browser gets
 * the public one to subscribe with.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePasswordChanged } from '../middleware/auth';
import { pushClientConfig, removeSubscription, saveSubscription } from '../push/pushService';

const keysSchema = z.object({
  p256dh: z.string().min(1).max(200),
  auth: z.string().min(1).max(100),
});

const subscribeSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: keysSchema,
});

const unsubscribeSchema = z.object({ endpoint: z.string().url().max(1000) });

export function createPushRouter(): Router {
  const router = Router();
  router.use('/push', requireAuth, requirePasswordChanged);

  // GET /api/push/config — the public key, or null while push is not configured.
  router.get('/push/config', (_req, res) => {
    res.json(pushClientConfig());
  });

  router.post('/push/subscriptions', (req, res, next) => {
    (async () => {
      const body = subscribeSchema.parse(req.body ?? {});
      const saved = await saveSubscription(req.currentUser!.id, body, req.get('user-agent') ?? null);
      res.status(201).json({ subscription: saved });
    })().catch(next);
  });

  router.delete('/push/subscriptions', (req, res, next) => {
    (async () => {
      const body = unsubscribeSchema.parse(req.body ?? {});
      res.json({ removed: await removeSubscription(req.currentUser!.id, body.endpoint) });
    })().catch(next);
  });

  return router;
}
