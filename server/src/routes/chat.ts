/**
 * The Chat box API.
 *
 * AUTHORIZATION IS MOUNTED ONCE, ON THE PREFIX, so a route added later cannot
 * be forgotten: everything under /chat requires a signed-in ADMIN or
 * RECEPTIONIST. Bộ phận đặt phòng calling any of these directly gets 403 —
 * hiding the menu is not the control, this is.
 *
 * The service layer re-checks the role and re-applies the per-user visibility
 * filter on every call as well. That is deliberate belt-and-braces: the
 * middleware protects the HTTP surface, `assertChatAccess` + `visibilityWhere`
 * protect the domain even if something else ever calls it.
 *
 * NO REALTIME TRANSPORT. The application has no WebSocket or SSE anywhere, and
 * introducing one for this would add a connection lifecycle, an auth handshake
 * and a reconnect story to a feature whose traffic is a handful of messages a
 * day. The client polls these endpoints instead — the simplest thing that is
 * reliable on the existing stack.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { requireAuth, requirePasswordChanged, requireRole } from '../middleware/auth';
import { chatUpload } from '../middleware/upload';
import { ApiError } from '../lib/errors';
import {
  addMessage,
  CHAT_CATEGORIES,
  closeConversation,
  createConversation,
  getConversation,
  listConversations,
  listMessages,
  authorizeChatAttachment,
  type ChatActor,
  type NewAttachment,
} from '../chat/chatService';
import {
  listChannelMessages,
  listChannels,
  markChannelRead,
  sendChannelMessage,
} from '../chat/channelService';
import { generateChatFileName, readChatFile, saveChatFile, sniffChatMime } from '../chat/chatStorage';

function actorOf(req: Request): ChatActor {
  const user = req.currentUser;
  if (!user) throw ApiError.authRequired();
  return { id: user.id, role: user.role, branchId: user.branchId ?? null, managedBranchIds: user.managedBranchIds };
}

function idOf(raw: string | undefined): string {
  if (!raw || raw.trim().length === 0) throw ApiError.notFound('Không tìm thấy cuộc trò chuyện.');
  return raw;
}

/**
 * A new submission names a CATEGORY, not a title.
 *
 * `subject` is not accepted any more — not even optionally. Leaving it open
 * "for compatibility" would leave the free-text path it replaced quietly
 * reachable by anything that skips the form, which is precisely the path the
 * category exists to close.
 *
 * `anonymous` arrives as a multipart string, so it is compared to the literal
 * 'true' rather than coerced: `Boolean('false')` is `true`, and getting that
 * wrong would make every submission anonymous.
 */
const createSchema = z.object({
  category: z.enum(['ROOM', 'WORK_ENVIRONMENT', 'INTERNAL'], {
    errorMap: () => ({ message: 'Vui lòng chọn loại vấn đề.' }),
  }),
  body: z.string().max(5000).optional().default(''),
  anonymous: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
});

/** The Admin's verdict, recorded beside the thread and never inside it. */
const closeSchema = z.object({
  adminNote: z.string().trim().max(2000).optional(),
});

const messageSchema = z.object({
  body: z.string().max(5000).optional().default(''),
});

/**
 * Sniffs, names and writes every uploaded image, returning the rows to attach.
 *
 * THE REAL TYPE DECIDES, not the declared one — a renamed executable is
 * rejected here, before anything reaches disk or the database.
 *
 * EVERY FILE IS CHECKED BEFORE ANY FILE IS WRITTEN. The obvious loop — sniff,
 * write, repeat — leaves the first two images on disk when the third turns out
 * to be a renamed executable: the request fails, no database row is ever
 * created, and those bytes are unreferenced by anything and so are never
 * cleaned up. Rejecting the whole batch up front makes the write-out
 * all-or-nothing in the only case that can realistically fail.
 */
async function persistUploads(req: Request, conversationId: string): Promise<NewAttachment[]> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];

  // Pass 1 — validate everything. Nothing has touched the disk yet.
  const checked = files.map((file) => {
    const mime = sniffChatMime(file.buffer);
    if (!mime) {
      throw ApiError.unsupportedMedia('Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP.');
    }
    return { file, mime };
  });

  // Pass 2 — write. `saveChatFile` uses the `wx` flag, so a name collision
  // fails loudly rather than overwriting an existing attachment.
  const saved: NewAttachment[] = [];
  for (const { file, mime } of checked) {
    const storedFileName = generateChatFileName(conversationId, mime);
    await saveChatFile(file.buffer, storedFileName);
    saved.push({
      storedFileName,
      originalFileName: file.originalname,
      mimeType: mime,
      fileSize: file.size,
    });
  }
  return saved;
}

export function createChatRouter(): Router {
  const router = Router();

  // ONE gate for the whole module.
  // Managers reach only the branch channels (their route allow-list), scoped by branch.
  router.use(
    '/chat',
    requireAuth,
    requirePasswordChanged,
    requireRole('ADMIN', 'RECEPTIONIST', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'),
  );

  /*
    THE CHAT BUBBLE — branch channels. The list is the branch table (see
    `channelService.ts`), so a branch added later appears without a change here.
  */
  const branchIdOf = (raw: string | undefined): number => {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw ApiError.notFound('Không tìm thấy chi nhánh.');
    return id;
  };

  // GET /api/chat/channels — one entry per branch the caller may open, with unread counts.
  router.get('/chat/channels', (req, res, next) => {
    (async () => {
      res.json({ channels: await listChannels(actorOf(req)) });
    })().catch(next);
  });

  // GET /api/chat/channels/:branchId/messages — the newest messages, oldest first.
  router.get('/chat/channels/:branchId/messages', (req, res, next) => {
    (async () => {
      res.json({ messages: await listChannelMessages(branchIdOf(req.params.branchId), actorOf(req)) });
    })().catch(next);
  });

  // POST /api/chat/channels/:branchId/messages — write to the branch (multipart).
  router.post('/chat/channels/:branchId/messages', chatUpload(), (req, res, next) => {
    (async () => {
      const actor = actorOf(req);
      const branchId = branchIdOf(req.params.branchId);
      // Confirms the caller may open this branch BEFORE any file is written.
      await listChannelMessages(branchId, actor);
      const input = messageSchema.parse(req.body ?? {});
      const attachments = await persistUploads(req, `channel-${branchId}`);
      const message = await sendChannelMessage(
        branchId,
        { body: input.body, attachments },
        { ...actor, fullName: req.currentUser?.fullName },
      );
      res.status(201).json({ message });
    })().catch(next);
  });

  // POST /api/chat/channels/:branchId/read — clears this reader's unread count.
  router.post('/chat/channels/:branchId/read', (req, res, next) => {
    (async () => {
      await markChannelRead(branchIdOf(req.params.branchId), actorOf(req));
      res.json({ ok: true });
    })().catch(next);
  });

  // GET /api/chat/conversations — the caller's visible threads, newest first.
  router.get('/chat/conversations', (req, res, next) => {
    (async () => {
      res.json({ conversations: await listConversations(actorOf(req)) });
    })().catch(next);
  });

  // POST /api/chat/conversations — receptionist opens a thread (multipart).
  router.post('/chat/conversations', chatUpload(), (req, res, next) => {
    (async () => {
      const actor = actorOf(req);
      const input = createSchema.parse(req.body ?? {});
      // A cuid is generated by the database, so the file name is seeded with a
      // per-request token instead; the id is only ever a readability prefix.
      const attachments = await persistUploads(req, 'new');
      const result = await createConversation(
        {
          category: input.category,
          body: input.body,
          attachments,
          anonymous: input.anonymous,
        },
        actor,
      );
      res.status(201).json(result);
    })().catch(next);
  });

  // GET /api/chat/conversations/:id
  router.get('/chat/conversations/:id', (req, res, next) => {
    (async () => {
      res.json({ conversation: await getConversation(idOf(req.params.id), actorOf(req)) });
    })().catch(next);
  });

  // GET /api/chat/conversations/:id/messages — what the client polls.
  router.get('/chat/conversations/:id/messages', (req, res, next) => {
    (async () => {
      res.json({ messages: await listMessages(idOf(req.params.id), actorOf(req)) });
    })().catch(next);
  });

  // POST /api/chat/conversations/:id/messages — reply or follow-up (multipart).
  router.post('/chat/conversations/:id/messages', chatUpload(), (req, res, next) => {
    (async () => {
      const actor = actorOf(req);
      const id = idOf(req.params.id);
      // Confirms the thread exists and the caller may reach it BEFORE any file
      // is written — otherwise a stranger's id would still cost us disk.
      await getConversation(id, actor);
      const input = messageSchema.parse(req.body ?? {});
      const attachments = await persistUploads(req, id);
      const message = await addMessage(id, { body: input.body, attachments }, actor);
      res.status(201).json({ message });
    })().catch(next);
  });

  // POST /api/chat/conversations/:id/close — Admin only. Marks the thread
  // handled and records who did it; the original content is untouched.
  router.post('/chat/conversations/:id/close', (req, res, next) => {
    (async () => {
      const input = closeSchema.parse(req.body ?? {});
      res.json({
        conversation: await closeConversation(idOf(req.params.id), actorOf(req), input),
      });
    })().catch(next);
  });

  // GET /api/chat/categories — the three choices, with their Vietnamese labels.
  // Served rather than hardcoded in the client so the names exist ONCE.
  router.get('/chat/categories', (_req, res) => {
    res.json({ categories: CHAT_CATEGORIES });
  });

  /**
   * GET /api/chat/attachments/:attachmentId/file — the bytes.
   *
   * Authenticated and visibility-checked like everything else, `private,
   * no-store` so an image is never cached by a proxy, and `nosniff` so a stored
   * file cannot be coerced into executing as something else. There is no public
   * URL for these files anywhere.
   */
  router.get('/chat/attachments/:attachmentId/file', (req, res, next) => {
    (async () => {
      const attachment = await authorizeChatAttachment(
        idOf(req.params.attachmentId),
        actorOf(req),
      );
      const bytes = await readChatFile(attachment.storedFileName);
      res.setHeader('Content-Type', attachment.mimeType);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      res.send(bytes);
    })().catch(next);
  });

  return router;
}
