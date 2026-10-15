/**
 * "VII. BÁO CÁO CÁC VẤN ĐỀ VÀ TÌNH HÌNH QUAN TRỌNG" — the private upward reports.
 *
 * Every rule (who may send, to whom, who may read) is the service's; these
 * routes only admit the reception hierarchy and parse the shapes. The sender is
 * always the session's account — no field of any body names a sender.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePasswordChanged, requireRole } from '../middleware/auth';
import {
  CONFIDENTIAL_CATEGORIES,
  CONFIDENTIAL_CATEGORY_LABELS,
  CONFIDENTIAL_TITLE,
  MAX_CONFIDENTIAL_LENGTH,
  allowedRecipientRoles,
  allowedRecipients,
  canRead,
  canSend,
  createConfidentialReport,
  getConfidentialReport,
  listInbox,
  markConfidentialRead,
  type ConfidentialActor,
} from '../confidential/confidentialReportService';
import type { UserWithBranch } from '../auth/serialize';

const createSchema = z.object({
  category: z.enum(['WORK_ENVIRONMENT', 'PROCESS_RULES', 'COLLEAGUES', 'OTHER_IMPORTANT']),
  content: z.string().trim().min(1, 'Vui lòng nhập nội dung.').max(MAX_CONFIDENTIAL_LENGTH),
  recipientIds: z.array(z.number().int().positive()).max(50).optional(),
});

const listSchema = z.object({ state: z.enum(['UNREAD', 'READ']).optional() });

function actor(user: UserWithBranch): ConfidentialActor {
  return { id: user.id, role: user.role, branchId: user.branchId, fullName: user.fullName };
}

export function createConfidentialReportsRouter(): Router {
  const router = Router();
  router.use(
    '/confidential-reports',
    requireAuth,
    requirePasswordChanged,
    requireRole('RECEPTIONIST', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER', 'ADMIN'),
  );

  // GET /api/confidential-reports/options — the four kinds and MY allowed superiors.
  router.get('/confidential-reports/options', (req, res, next) => {
    (async () => {
      const me = actor(req.currentUser!);
      res.json({
        title: CONFIDENTIAL_TITLE,
        categories: CONFIDENTIAL_CATEGORIES.map((c) => ({ code: c, label: CONFIDENTIAL_CATEGORY_LABELS[c] })),
        canSend: canSend(me.role),
        canRead: canRead(me.role),
        recipients: canSend(me.role) ? await allowedRecipients(me) : [],
        /** The role groups of "Gửi đến", nearest first — shown even when empty. */
        recipientRoles: allowedRecipientRoles(me.role),
      });
    })().catch(next);
  });

  router.post('/confidential-reports', (req, res, next) => {
    (async () => {
      const body = createSchema.parse(req.body ?? {});
      const created = await createConfidentialReport(actor(req.currentUser!), body);
      res.status(201).json({ report: created });
    })().catch(next);
  });

  router.get('/confidential-reports', (req, res, next) => {
    (async () => {
      const q = listSchema.parse(req.query);
      res.json(await listInbox(actor(req.currentUser!), q.state));
    })().catch(next);
  });

  router.get('/confidential-reports/:id', (req, res, next) => {
    (async () => {
      res.json({ report: await getConfidentialReport(actor(req.currentUser!), req.params.id!) });
    })().catch(next);
  });

  router.post('/confidential-reports/:id/read', (req, res, next) => {
    (async () => {
      res.json({ report: await markConfidentialRead(actor(req.currentUser!), req.params.id!) });
    })().catch(next);
  });

  return router;
}
