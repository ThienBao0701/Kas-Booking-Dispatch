/**
 * The Chat box API: authorization, visibility, messages, and image attachments.
 *
 * THE CLAIM THIS FILE EXISTS TO PROVE is not "a receptionist can chat" — it is
 * that ONE RECEPTIONIST CANNOT READ ANOTHER'S THREAD. Chat visibility is
 * ownership, not branch, and the two receptionists below share a branch
 * precisely so a branch-scoped implementation would fail here rather than ship.
 *
 * The attachment tests are the same claim at the byte level: an image id that
 * belongs to someone else's conversation must not resolve, even though the id
 * is perfectly valid and the file exists on disk. "Unguessable" is not access
 * control; the join back through the conversation is.
 *
 * Bộ phận đặt phòng is probed on every endpoint. It has no stated part in
 * reception↔Admin correspondence, so it gets 403 rather than an assumed access.
 */
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { CHAT_UPLOAD_DIR } from '../src/config/env';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  createUser,
  loginAgent,
} from './helpers/auth';
import { notAnImageBuffer, pngBuffer } from './helpers/images';

const BOOKING_DEPT_PASSWORD = 'Booking12345';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let deptAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
/** Two receptionists AT THE SAME BRANCH — the isolation claim depends on it. */
let letanA: Awaited<ReturnType<typeof loginAgent>>['agent'];
let letanB: Awaited<ReturnType<typeof loginAgent>>['agent'];
let cn1: number;

const CATEGORY = 'ROOM';
const CATEGORY_LABEL = 'Phòng';
const BODY = 'Khách đòi đổi phòng lúc nửa đêm, em xử lý sao ạ?';

/**
 * Opens a thread as receptionist A and returns its id.
 *
 * The thread is identified by a CATEGORY now, not a typed title — so what used
 * to be a different subject per test is a different BODY per test, and the
 * distinguishing text lives where free text is still allowed.
 */
async function openThread(
  agent = letanA,
  body = BODY,
  opts: { category?: string; anonymous?: boolean } = {},
): Promise<string> {
  const req = agent
    .post('/api/chat/conversations')
    .field('category', opts.category ?? CATEGORY)
    .field('body', body);
  if (opts.anonymous) req.field('anonymous', 'true');
  const res = await req;
  expect(res.status).toBe(201);
  return res.body.conversation.id as string;
}

beforeAll(async () => {
  await resetAll();
  await testPrisma.branchSourceAlias.deleteMany({});
  await seedBranches(testPrisma);
  app = createApp();

  cn1 = (await testPrisma.branch.findFirstOrThrow({ orderBy: { id: 'asc' } })).id;

  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;

  await createUser({
    username: 'datphong',
    password: BOOKING_DEPT_PASSWORD,
    fullName: 'Bộ phận đặt phòng',
    role: 'BOOKING_DEPARTMENT',
    branchId: null,
    mustChangePassword: false,
  });
  deptAgent = (await loginAgent(app, 'datphong', BOOKING_DEPT_PASSWORD)).agent;

  await createReceptionist(cn1, { username: 'letana', mustChangePassword: false });
  letanA = (await loginAgent(app, 'letana', RECEPTIONIST_PASSWORD)).agent;

  await createReceptionist(cn1, { username: 'letanb', mustChangePassword: false });
  letanB = (await loginAgent(app, 'letanb', RECEPTIONIST_PASSWORD)).agent;
}, 120_000);

beforeEach(async () => {
  await testPrisma.chatAttachment.deleteMany({});
  await testPrisma.chatMessage.deleteMany({});
  await testPrisma.chatConversation.deleteMany({});
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

/* ================================================================== */
/* Authorization                                                       */
/* ================================================================== */

describe('authorization', () => {
  it('lets a RECEPTIONIST use the module', async () => {
    expect((await letanA.get('/api/chat/conversations')).status).toBe(200);
    const id = await openThread();
    expect((await letanA.get(`/api/chat/conversations/${id}`)).status).toBe(200);
  });

  it('lets an ADMIN use the module', async () => {
    await openThread();
    expect((await adminAgent.get('/api/chat/conversations')).status).toBe(200);
  });

  it('refuses BỘ PHẬN ĐẶT PHÒNG on every endpoint', async () => {
    const id = await openThread();
    expect((await deptAgent.get('/api/chat/conversations')).status).toBe(403);
    expect((await deptAgent.get(`/api/chat/conversations/${id}`)).status).toBe(403);
    expect((await deptAgent.get(`/api/chat/conversations/${id}/messages`)).status).toBe(403);
    expect(
      (await deptAgent.post(`/api/chat/conversations/${id}/messages`).field('body', 'hi')).status,
    ).toBe(403);
    expect(
      (await deptAgent
        .post('/api/chat/conversations')
        .field('category', CATEGORY)
        .field('body', 'y')).status,
    ).toBe(403);
    expect((await deptAgent.post(`/api/chat/conversations/${id}/close`)).status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    const request = (await import('supertest')).default;
    expect((await request(app).get('/api/chat/conversations')).status).toBe(401);
  });

  it('refuses an ADMIN trying to OPEN a conversation — reception asks', async () => {
    const res = await adminAgent
      .post('/api/chat/conversations')
      .field('category', CATEGORY)
      .field('body', BODY);
    expect(res.status).toBe(403);
  });

  it('refuses a RECEPTIONIST trying to close a conversation', async () => {
    const id = await openThread();
    expect((await letanA.post(`/api/chat/conversations/${id}/close`)).status).toBe(403);
  });
});

/* ================================================================== */
/* Visibility — the core claim                                         */
/* ================================================================== */

describe('a receptionist sees only their own conversations', () => {
  it('does not list another receptionist thread at the same branch', async () => {
    await openThread(letanA, 'Câu hỏi của lễ tân A');

    const mine = await letanB.get('/api/chat/conversations');
    expect(mine.status).toBe(200);
    expect(mine.body.conversations).toHaveLength(0);
  });

  it('gets 404 — not 403 — for another receptionist thread', async () => {
    // 403 would confirm the id exists, which is itself information letan B has
    // no business learning about letan A's thread.
    const id = await openThread(letanA);
    expect((await letanB.get(`/api/chat/conversations/${id}`)).status).toBe(404);
    expect((await letanB.get(`/api/chat/conversations/${id}/messages`)).status).toBe(404);
  });

  it('cannot post into another receptionist thread', async () => {
    const id = await openThread(letanA);
    const res = await letanB.post(`/api/chat/conversations/${id}/messages`).field('body', 'xen vào');
    expect(res.status).toBe(404);
    expect(await testPrisma.chatMessage.count({ where: { conversationId: id } })).toBe(1);
  });

  it('sees its own thread normally', async () => {
    const id = await openThread(letanB, 'Câu hỏi của lễ tân B');
    const res = await letanB.get(`/api/chat/conversations/${id}`);
    expect(res.status).toBe(200);
    // `title` is the category's label, built by the server so the list, the
    // thread and the PDF cannot name the same category three different ways.
    expect(res.body.conversation.title).toBe(CATEGORY_LABEL);
    expect(res.body.conversation.category).toBe(CATEGORY);
  });

  it('lets an ADMIN see every thread', async () => {
    await openThread(letanA, 'A hỏi');
    await openThread(letanB, 'B hỏi');

    const res = await adminAgent.get('/api/chat/conversations');
    expect(res.status).toBe(200);
    const previews = (res.body.conversations as { lastMessagePreview: string }[]).map(
      (c) => c.lastMessagePreview,
    );
    expect(previews).toContain('A hỏi');
    expect(previews).toContain('B hỏi');
  });
});

/* ================================================================== */
/* ADMIN reaches ANY conversation — the product's central promise      */
/* ================================================================== */

describe('an ADMIN can open and answer ANY receptionist conversation', () => {
  it('opens the detail of a thread it did not create', async () => {
    const id = await openThread(letanA);
    const res = await adminAgent.get(`/api/chat/conversations/${id}`);
    // Explicitly NOT 403: the Admin owns nothing here and must still get in.
    expect(res.status).toBe(200);
    expect(res.body.conversation.id).toBe(id);
    expect(res.body.conversation.createdBy.fullName).toBeTruthy();
  });

  it('reads the messages of a thread it did not create', async () => {
    const id = await openThread(letanA);
    const res = await adminAgent.get(`/api/chat/conversations/${id}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].body).toBe(BODY);
  });

  it('replies to a thread it did not create', async () => {
    const id = await openThread(letanA);
    const res = await adminAgent
      .post(`/api/chat/conversations/${id}/messages`)
      .field('body', 'Admin trả lời');
    expect(res.status).toBe(201);
  });

  it('attaches an image when replying to a thread it did not create', async () => {
    const id = await openThread(letanA);
    const res = await adminAgent
      .post(`/api/chat/conversations/${id}/messages`)
      .field('body', 'Ảnh hướng dẫn')
      .attach('images', pngBuffer(), 'huongdan.png');
    expect(res.status).toBe(201);
    expect(res.body.message.attachments).toHaveLength(1);
  });

  it('reaches EVERY receptionist thread, not merely the first', async () => {
    const a = await openThread(letanA, 'A hỏi');
    const b = await openThread(letanB, 'B hỏi');
    expect((await adminAgent.get(`/api/chat/conversations/${a}`)).status).toBe(200);
    expect((await adminAgent.get(`/api/chat/conversations/${b}`)).status).toBe(200);
    expect((await adminAgent.get(`/api/chat/conversations/${a}/messages`)).status).toBe(200);
    expect((await adminAgent.get(`/api/chat/conversations/${b}/messages`)).status).toBe(200);
  });

  it('the ONLY thing an ADMIN is refused is STARTING a thread', async () => {
    // This is the single 403 in the module for an Admin, and it is by design:
    // reception asks, Admin answers. It must never be mistaken for "an Admin
    // cannot open a conversation".
    const id = await openThread(letanA);
    expect(
      (await adminAgent
        .post('/api/chat/conversations')
        .field('category', CATEGORY)
        .field('body', 'y')).status,
    ).toBe(403);
    // Everything else on that same thread is open to them.
    expect((await adminAgent.get(`/api/chat/conversations/${id}`)).status).toBe(200);
    expect(
      (await adminAgent.post(`/api/chat/conversations/${id}/messages`).field('body', 'ok')).status,
    ).toBe(201);
    expect((await adminAgent.post(`/api/chat/conversations/${id}/close`)).status).toBe(200);
  });
});

/* ================================================================== */
/* Creating and replying                                               */
/* ================================================================== */

describe('creating a conversation', () => {
  it('persists the thread, the first message and the asker branch', async () => {
    const id = await openThread();

    const conv = await testPrisma.chatConversation.findUniqueOrThrow({ where: { id } });
    // The column that replaced the typed title. `subject` stays null on every
    // thread created from here on — it is only ever read on legacy rows.
    expect(conv.category).toBe(CATEGORY);
    expect(conv.subject).toBeNull();
    expect(conv.anonymous).toBe(false);
    expect(conv.status).toBe('WAITING_ADMIN');
    // The branch is a server-side snapshot of the ASKER's branch, never taken
    // from the request body.
    expect(conv.branchId).toBe(cn1);

    const messages = await testPrisma.chatMessage.findMany({ where: { conversationId: id } });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toBe(BODY);
    expect(messages[0]!.senderRole).toBe('RECEPTIONIST');
  });

  it('ignores a client-supplied branchId', async () => {
    const other = await testPrisma.branch.findFirstOrThrow({ orderBy: { id: 'desc' } });
    const res = await letanA
      .post('/api/chat/conversations')
      .field('category', CATEGORY)
      .field('body', BODY)
      .field('branchId', String(other.id));
    expect(res.status).toBe(201);

    const conv = await testPrisma.chatConversation.findUniqueOrThrow({
      where: { id: res.body.conversation.id },
    });
    expect(conv.branchId).toBe(cn1);
  });

  it('rejects a missing category', async () => {
    const res = await letanA.post('/api/chat/conversations').field('body', BODY);
    expect(res.status).toBe(422); // KAS maps validation errors to 422
    expect(await testPrisma.chatConversation.count()).toBe(0);
  });

  /**
   * THE POINT OF A CLOSED LIST. An arbitrary string is not a category, and a
   * request that skipped the form is refused exactly as the form refuses it.
   * This is what the old "rejects a blank subject" test could never check:
   * free text has no wrong answer.
   */
  it('rejects a category outside the three choices', async () => {
    const res = await letanA
      .post('/api/chat/conversations')
      .field('category', 'ANYTHING_ELSE')
      .field('body', BODY);
    expect(res.status).toBe(422);
    expect(await testPrisma.chatConversation.count()).toBe(0);
  });

  /** A typed title is no longer something the API will take from anyone. */
  it('ignores a client-supplied subject', async () => {
    const res = await letanA
      .post('/api/chat/conversations')
      .field('category', CATEGORY)
      .field('body', BODY)
      .field('subject', 'Tiêu đề tự gõ');
    expect(res.status).toBe(201);
    const conv = await testPrisma.chatConversation.findUniqueOrThrow({
      where: { id: res.body.conversation.id },
    });
    expect(conv.subject).toBeNull();
  });

  /**
   * Stricter than a REPLY, on purpose: a photo with no words is a clear thing to
   * send into a thread already under way, and a useless thing to open one with —
   * the Admin receives a category and a picture and nothing to act on.
   */
  it('rejects a first message with no text, even with an image', async () => {
    const res = await letanA
      .post('/api/chat/conversations')
      .field('category', CATEGORY)
      .field('body', '   ')
      .attach('images', pngBuffer(), 'anh.png');
    expect(res.status).toBe(422);
    expect(await testPrisma.chatConversation.count()).toBe(0);
  });

  it('accepts text with an image', async () => {
    const res = await letanA
      .post('/api/chat/conversations')
      .field('category', CATEGORY)
      .field('body', BODY)
      .attach('images', pngBuffer(), 'anh.png');
    expect(res.status).toBe(201);
    expect(await testPrisma.chatAttachment.count()).toBe(1);
  });
});

describe('replying', () => {
  it('lets an ADMIN reply and marks the thread ANSWERED', async () => {
    const id = await openThread();

    const res = await adminAgent
      .post(`/api/chat/conversations/${id}/messages`)
      .field('body', 'Em cứ đổi phòng cho khách nhé.');
    expect(res.status).toBe(201);
    expect(res.body.message.senderRole).toBe('ADMIN');

    const conv = await testPrisma.chatConversation.findUniqueOrThrow({ where: { id } });
    expect(conv.status).toBe('ANSWERED');
  });

  it('puts the thread back to WAITING_ADMIN when the receptionist follows up', async () => {
    const id = await openThread();
    await adminAgent.post(`/api/chat/conversations/${id}/messages`).field('body', 'Đã xử lý.');
    await letanA.post(`/api/chat/conversations/${id}/messages`).field('body', 'Còn một việc nữa ạ.');

    const conv = await testPrisma.chatConversation.findUniqueOrThrow({ where: { id } });
    expect(conv.status).toBe('WAITING_ADMIN');
  });

  it('returns the whole thread in order', async () => {
    const id = await openThread();
    await adminAgent.post(`/api/chat/conversations/${id}/messages`).field('body', 'Trả lời 1');
    await letanA.post(`/api/chat/conversations/${id}/messages`).field('body', 'Hỏi thêm');

    const res = await letanA.get(`/api/chat/conversations/${id}/messages`);
    expect(res.status).toBe(200);
    const bodies = (res.body.messages as { body: string }[]).map((m) => m.body);
    expect(bodies).toEqual([BODY, 'Trả lời 1', 'Hỏi thêm']);
  });

  it('lets an ADMIN close a thread', async () => {
    const id = await openThread();
    const res = await adminAgent.post(`/api/chat/conversations/${id}/close`);
    expect(res.status).toBe(200);
    expect(res.body.conversation.status).toBe('CLOSED');
  });
});

/* ================================================================== */
/* Attachments                                                         */
/* ================================================================== */

describe('image attachments', () => {
  it('accepts several images on one message and persists their metadata', async () => {
    const id = await openThread();

    const res = await letanA
      .post(`/api/chat/conversations/${id}/messages`)
      .field('body', 'Ảnh phòng đây ạ')
      .attach('images', pngBuffer(), 'mot.png')
      .attach('images', pngBuffer(), 'hai.png')
      .attach('images', pngBuffer(), 'ba.png');
    expect(res.status).toBe(201);
    expect(res.body.message.attachments).toHaveLength(3);

    const rows = await testPrisma.chatAttachment.findMany();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // The client's name is kept for display only; the name ON DISK is ours.
      expect(['mot.png', 'hai.png', 'ba.png']).toContain(row.originalFileName);
      expect(row.storedFileName).not.toBe(row.originalFileName);
      expect(row.storedFileName).toMatch(/^[a-zA-Z0-9]+_[0-9a-f]{16}\.png$/);
      expect(row.mimeType).toBe('image/png');
    }
  });

  it('refuses a non-image whatever the client calls it', async () => {
    const id = await openThread();
    const res = await letanA
      .post(`/api/chat/conversations/${id}/messages`)
      .field('body', 'thử')
      .attach('images', notAnImageBuffer(), { filename: 'evil.png', contentType: 'image/png' });
    expect([400, 415]).toContain(res.status);
    expect(await testPrisma.chatAttachment.count()).toBe(0);
  });

  it('serves an attachment to a participant', async () => {
    const id = await openThread();
    const sent = await letanA
      .post(`/api/chat/conversations/${id}/messages`)
      .field('body', 'ảnh')
      .attach('images', pngBuffer(), 'anh.png');
    const attachmentId = sent.body.message.attachments[0].id as string;

    const res = await letanA.get(`/api/chat/attachments/${attachmentId}/file`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    // Never cached by a proxy, never sniffed into something executable.
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves it to the ADMIN too', async () => {
    const id = await openThread();
    const sent = await letanA
      .post(`/api/chat/conversations/${id}/messages`)
      .field('body', 'ảnh')
      .attach('images', pngBuffer(), 'anh.png');
    const attachmentId = sent.body.message.attachments[0].id as string;

    expect((await adminAgent.get(`/api/chat/attachments/${attachmentId}/file`)).status).toBe(200);
  });

  it('REFUSES it to a receptionist who is not in the conversation', async () => {
    const id = await openThread(letanA);
    const sent = await letanA
      .post(`/api/chat/conversations/${id}/messages`)
      .field('body', 'ảnh')
      .attach('images', pngBuffer(), 'anh.png');
    const attachmentId = sent.body.message.attachments[0].id as string;

    // A valid id, a file that exists — and still no bytes.
    expect((await letanB.get(`/api/chat/attachments/${attachmentId}/file`)).status).toBe(404);
  });

  it('refuses it to Bộ phận đặt phòng', async () => {
    const id = await openThread();
    const sent = await letanA
      .post(`/api/chat/conversations/${id}/messages`)
      .field('body', 'ảnh')
      .attach('images', pngBuffer(), 'anh.png');
    const attachmentId = sent.body.message.attachments[0].id as string;

    expect((await deptAgent.get(`/api/chat/attachments/${attachmentId}/file`)).status).toBe(403);
  });

  it('refuses a path-traversal attempt in the attachment id', async () => {
    const res = await letanA.get('/api/chat/attachments/..%2F..%2F.env/file');
    expect([400, 404]).toContain(res.status);
  });

  it('writes NOTHING to disk when one image in a batch is rejected', async () => {
    // The whole batch is validated before any file is written. The naive
    // sniff-then-write loop leaves the first image on disk with no database row
    // ever created to reference it — bytes nothing will clean up.
    const id = await openThread();
    const before = fs.existsSync(CHAT_UPLOAD_DIR) ? fs.readdirSync(CHAT_UPLOAD_DIR).length : 0;

    const res = await letanA
      .post(`/api/chat/conversations/${id}/messages`)
      .field('body', 'hai ảnh, một ảnh giả')
      .attach('images', pngBuffer(), 'that.png')
      .attach('images', notAnImageBuffer(), { filename: 'gia.png', contentType: 'image/png' });
    expect([400, 415]).toContain(res.status);

    const after = fs.existsSync(CHAT_UPLOAD_DIR) ? fs.readdirSync(CHAT_UPLOAD_DIR).length : 0;
    expect(after).toBe(before);
    expect(await testPrisma.chatAttachment.count()).toBe(0);
  });
});
