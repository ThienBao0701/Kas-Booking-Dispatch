/**
 * The Chứng từ API.
 *
 * AUTHORIZATION IS MOUNTED ONCE, ON THE PREFIX, so a route added later cannot
 * be forgotten: everything under /charge-documents requires a signed-in user
 * with ADMIN or BOOKING_DEPARTMENT. A receptionist calling any of these
 * directly gets 403 — hiding the menu is not the control, this is.
 *
 * The service layer re-checks the role on every call as well. That is
 * deliberate belt-and-braces: the middleware protects the HTTP surface, and
 * `assertChargeAccess` protects the domain even if something else ever calls it.
 *
 * No endpoint here returns a card number except `/card`, which exists for that
 * purpose alone and writes an audit row every time it is used.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { requireAuth, requirePasswordChanged, requireRole } from '../middleware/auth';
import { chargeUpload } from '../middleware/upload';
import { ApiError } from '../lib/errors';
import {
  addAttachment,
  authorizeAttachment,
  createChargeDocument,
  getChargeDocument,
  listChargeAudit,
  listChargeDocuments,
  monthlyChargeReport,
  removeAttachment,
  revealCardNumber,
  updateChargeDocument,
  type ChargeActor,
} from '../charge/chargeService';
import {
  deleteChargeFile,
  generateStoredFileName,
  mimeAllowedForCategory,
  readChargeFile,
  saveChargeFile,
  sniffChargeMime,
} from '../charge/chargeDocStorage';
import { buildMonthlyReportWorkbook } from '../charge/chargeReportExport';

function actorOf(req: Request): ChargeActor {
  const user = req.currentUser;
  if (!user) throw ApiError.authRequired();
  return { id: user.id, role: user.role };
}

function idOf(raw: string | undefined): string {
  if (!raw || raw.trim().length === 0) throw ApiError.notFound('Không tìm thấy chứng từ.');
  return raw;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày không hợp lệ.');
const statusEnum = z.enum(['CHUA_XU_LY', 'DA_BI_CHARGE', 'CHARGE_THAT_BAI']);

const createSchema = z.object({
  branchId: z.coerce.number().int().positive('Vui lòng chọn chi nhánh.'),
  guestName: z.string().trim().min(1, 'Vui lòng nhập tên khách.').max(200),
  bookingCode: z.string().trim().min(1, 'Vui lòng nhập mã đặt phòng.').max(100),
  amount: z.coerce.number().int().nonnegative('Số tiền không hợp lệ.'),
  // Accepted as typed (spaces/dashes are normal); never echoed back.
  cardNumber: z.string().trim().min(12, 'Số thẻ không hợp lệ.').max(32),
  cardExpiry: z
    .string()
    .trim()
    .regex(/^(0[1-9]|1[0-2])\/\d{2}$/, 'Ngày hết hạn phải theo dạng MM/YY.'),
  checkIn: isoDate,
  checkOut: isoDate,
  reason: z.string().trim().min(1, 'Vui lòng nhập lý do charge.').max(2000),
  status: statusEnum.optional(),
});

const updateSchema = createSchema.partial().extend({
  // An empty card number on update means "leave it alone", never "erase it".
  cardNumber: z.string().trim().max(32).optional(),
});

const listSchema = z.object({
  branchId: z.coerce.number().int().positive().optional(),
  status: statusEnum.optional(),
  chargedFrom: isoDate.optional(),
  chargedTo: isoDate.optional(),
  checkInFrom: isoDate.optional(),
  checkInTo: isoDate.optional(),
  guestName: z.string().trim().max(200).optional(),
  bookingCode: z.string().trim().max(100).optional(),
});

const monthSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Tháng không hợp lệ (định dạng YYYY-MM).'),
});

const categorySchema = z.enum(['GUEST_IMAGE', 'CHARGE_DOCUMENT', 'CARD_IMAGE']);

export function createChargeDocumentsRouter(): Router {
  const router = Router();

  // ONE gate for the whole module.
  router.use(
    '/charge-documents',
    requireAuth,
    requirePasswordChanged,
    requireRole('ADMIN', 'BOOKING_DEPARTMENT'),
  );

  // GET /api/charge-documents — filtered list. Every filter runs in the database.
  router.get('/charge-documents', (req, res, next) => {
    (async () => {
      const filters = listSchema.parse(req.query ?? {});
      res.json({ documents: await listChargeDocuments(filters, actorOf(req)) });
    })().catch(next);
  });

  // GET /api/charge-documents/report?month=YYYY-MM — the monthly report.
  // Mounted BEFORE /:id so "report" is never read as a document id.
  router.get('/charge-documents/report', (req, res, next) => {
    (async () => {
      const { month } = monthSchema.parse(req.query ?? {});
      res.json({ report: await monthlyChargeReport(month, actorOf(req)) });
    })().catch(next);
  });

  // GET /api/charge-documents/report/export?month=YYYY-MM — the same report,
  // as XLSX. It calls the same function; nothing is recalculated here.
  router.get('/charge-documents/report/export', (req, res, next) => {
    (async () => {
      const { month } = monthSchema.parse(req.query ?? {});
      const report = await monthlyChargeReport(month, actorOf(req));
      const buffer = await buildMonthlyReportWorkbook(report);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="bao-cao-charge-${month}.xlsx"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(buffer);
    })().catch(next);
  });

  // POST /api/charge-documents
  router.post('/charge-documents', (req, res, next) => {
    (async () => {
      const input = createSchema.parse(req.body ?? {});
      res.status(201).json({ document: await createChargeDocument(input, actorOf(req)) });
    })().catch(next);
  });

  // GET /api/charge-documents/:id
  router.get('/charge-documents/:id', (req, res, next) => {
    (async () => {
      res.json({ document: await getChargeDocument(idOf(req.params.id), actorOf(req)) });
    })().catch(next);
  });

  // PUT /api/charge-documents/:id — edit, including the status transition.
  router.put('/charge-documents/:id', (req, res, next) => {
    (async () => {
      const patch = updateSchema.parse(req.body ?? {});
      res.json({ document: await updateChargeDocument(idOf(req.params.id), patch, actorOf(req)) });
    })().catch(next);
  });

  // GET /api/charge-documents/:id/audit
  router.get('/charge-documents/:id/audit', (req, res, next) => {
    (async () => {
      res.json({ events: await listChargeAudit(idOf(req.params.id), actorOf(req)) });
    })().catch(next);
  });

  /**
   * POST /api/charge-documents/:id/card — reveal the full number.
   *
   * A POST, not a GET: a card number must never sit in a URL, a query string,
   * a browser history entry or an access log. The response is `no-store`, and
   * the reveal is audited by the service.
   */
  router.post('/charge-documents/:id/card', (req, res, next) => {
    (async () => {
      const result = await revealCardNumber(idOf(req.params.id), actorOf(req));
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    })().catch(next);
  });

  // POST /api/charge-documents/:id/attachments — multiple files at once.
  router.post('/charge-documents/:id/attachments', chargeUpload(), (req, res, next) => {
    (async () => {
      const actor = actorOf(req);
      const id = idOf(req.params.id);
      const category = categorySchema.parse((req.body ?? {}).category);
      // Confirms the document exists and the caller may reach it.
      await getChargeDocument(id, actor);

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) throw ApiError.badRequest('Chưa chọn tệp nào.');

      const saved = [];
      for (const file of files) {
        // The REAL type decides, not the declared one.
        const mime = sniffChargeMime(file.buffer);
        if (!mime || !mimeAllowedForCategory(mime, category)) {
          throw ApiError.unsupportedMedia(
            category === 'CHARGE_DOCUMENT'
              ? 'Chỉ chấp nhận ảnh PNG, JPEG, WebP hoặc tệp PDF.'
              : 'Mục này chỉ chấp nhận ảnh PNG, JPEG hoặc WebP.',
          );
        }
        const storedFileName = generateStoredFileName(id, mime);
        await saveChargeFile(file.buffer, storedFileName);
        saved.push(
          await addAttachment(
            id,
            {
              category,
              storedFileName,
              originalFileName: file.originalname,
              mimeType: mime,
              fileSize: file.size,
            },
            actor,
          ),
        );
      }

      res.status(201).json({ document: await getChargeDocument(id, actor), added: saved.length });
    })().catch(next);
  });

  /**
   * GET /api/charge-documents/attachments/:attachmentId/file — the bytes.
   *
   * Authenticated and role-checked like everything else, `private, no-store` so
   * card evidence is never cached by a proxy, and `nosniff` so a stored file
   * cannot be coerced into executing as something else. There is no public URL
   * for these files anywhere.
   */
  router.get('/charge-documents/attachments/:attachmentId/file', (req, res, next) => {
    (async () => {
      const attachment = await authorizeAttachment(
        idOf(req.params.attachmentId),
        actorOf(req),
      );
      const bytes = await readChargeFile(attachment.storedFileName);
      res.setHeader('Content-Type', attachment.mimeType);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // `inline` for images, `attachment` for a PDF the operator downloads.
      res.setHeader(
        'Content-Disposition',
        attachment.mimeType === 'application/pdf'
          ? `attachment; filename="${encodeURIComponent(attachment.originalFileName)}"`
          : 'inline',
      );
      res.send(bytes);
    })().catch(next);
  });

  // DELETE /api/charge-documents/attachments/:attachmentId
  router.delete('/charge-documents/attachments/:attachmentId', (req, res, next) => {
    (async () => {
      const removed = await removeAttachment(idOf(req.params.attachmentId), actorOf(req));
      await deleteChargeFile(removed.storedFileName);
      res.json({ success: true });
    })().catch(next);
  });

  return router;
}
