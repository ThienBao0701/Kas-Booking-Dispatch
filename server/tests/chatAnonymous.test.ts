/**
 * Chat box: the category selector, and anonymous internal reports.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. A submission names one of three CATEGORIES. A typed title is not accepted
 *      from anybody, by any route — which is the difference between a list that
 *      can be counted and a pile of one-off phrases.
 *   2. An anonymous submission DISAPPEARS from reception: its list, its detail,
 *      its messages, its attachments and its sidebar badge. All five, from one
 *      predicate, because five separate filters is four chances to forget.
 *   3. An Admin sees it, as "Ẩn danh" — the account never leaves the server, so
 *      there is no hidden field for a screen to leak by accident.
 *   4. The author is STILL recorded internally. Anonymity is a rule about who may
 *      read the identity, not a hole in the audit trail.
 *   5. Nothing can edit what was said. The Admin's verdict is stored beside the
 *      thread, never inside it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
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
import { pngBuffer } from './helpers/images';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

const TECHNICAL_PASSWORD = 'Technical1';
const BODY = 'Máy lạnh phòng 302 kêu to suốt đêm.';

let cn1 = 0;
let letan: Agent;
let letanId = 0;
let letanB: Agent;
let admin: Agent;
let tech: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;

  letanId = (await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false })).id;
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  await createReceptionist(cn1, { username: 'letan1b', mustChangePassword: false });
  letanB = (await loginAgent(app, 'letan1b', RECEPTIONIST_PASSWORD)).agent;

  await createUser({
    username: 'kythuat',
    password: TECHNICAL_PASSWORD,
    fullName: 'Kỹ thuật',
    role: 'TECHNICAL',
    branchId: null,
    mustChangePassword: false,
  });
  tech = (await loginAgent(app, 'kythuat', TECHNICAL_PASSWORD)).agent;

  await createAdmin({ mustChangePassword: false });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
});

beforeEach(async () => {
  await testPrisma.chatAttachment.deleteMany();
  await testPrisma.chatMessage.deleteMany();
  await testPrisma.chatConversation.deleteMany();
  await testPrisma.receptionShiftSession.deleteMany();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

async function submit(
  agent: Agent,
  opts: { category?: string; body?: string; anonymous?: boolean } = {},
): Promise<string> {
  const req = agent
    .post('/api/chat/conversations')
    .field('category', opts.category ?? 'ROOM')
    .field('body', opts.body ?? BODY);
  if (opts.anonymous) req.field('anonymous', 'true');
  const res = await req;
  expect(res.status).toBe(201);
  return res.body.conversation.id as string;
}

/* ================================================================== */
/* The category                                                        */
/* ================================================================== */

describe('the category selector', () => {
  it('serves the three choices with their Vietnamese labels', async () => {
    const res = await letan.get('/api/chat/categories');
    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([
      { value: 'ROOM', label: 'Phòng' },
      { value: 'WORK_ENVIRONMENT', label: 'Môi trường làm việc' },
      { value: 'INTERNAL', label: 'Các vấn đề nội bộ' },
    ]);
  });

  it('stores the category and builds the display title from it', async () => {
    const id = await submit(letan, { category: 'WORK_ENVIRONMENT' });
    const res = await admin.get(`/api/chat/conversations/${id}`);
    expect(res.body.conversation.category).toBe('WORK_ENVIRONMENT');
    expect(res.body.conversation.title).toBe('Môi trường làm việc');
    expect(res.body.conversation.subject).toBeNull();
  });

  it('refuses anything outside the three', async () => {
    for (const bad of ['', 'OTHER', 'Phòng', 'room']) {
      const res = await letan
        .post('/api/chat/conversations')
        .field('category', bad)
        .field('body', BODY);
      expect(res.status, `category=${bad}`).toBe(422);
    }
    expect(await testPrisma.chatConversation.count()).toBe(0);
  });

  it('requires content, trimmed', async () => {
    const res = await letan
      .post('/api/chat/conversations')
      .field('category', 'ROOM')
      .field('body', '   ');
    expect(res.status).toBe(422);
    expect(await testPrisma.chatConversation.count()).toBe(0);
  });

  /**
   * A LEGACY THREAD KEEPS ITS OWN WORDS.
   *
   * Rows created before the selector have a typed subject and no category, and
   * they are not reclassified — guessing a category from free text would be a
   * guess recorded as a fact. The display title falls back to what its author
   * actually wrote.
   */
  it('still renders a pre-category thread by its original title', async () => {
    const legacy = await testPrisma.chatConversation.create({
      data: {
        subject: 'Câu hỏi cũ từ trước khi có loại vấn đề',
        branchId: cn1,
        createdByUserId: letanId,
        status: 'WAITING_ADMIN',
      },
    });
    const res = await admin.get(`/api/chat/conversations/${legacy.id}`);
    expect(res.body.conversation.category).toBeNull();
    expect(res.body.conversation.title).toBe('Câu hỏi cũ từ trước khi có loại vấn đề');
  });
});

/* ================================================================== */
/* Anonymity — reception                                               */
/* ================================================================== */

describe('an anonymous submission disappears from reception', () => {
  let id = '';
  beforeEach(async () => {
    id = await submit(letan, { anonymous: true, category: 'INTERNAL' });
  });

  it('is not in the author’s own list', async () => {
    const res = await letan.get('/api/chat/conversations');
    expect(res.status).toBe(200);
    expect((res.body.conversations as { id: string }[]).map((c) => c.id)).not.toContain(id);
  });

  it('is a 404 on its detail — not a 403, which would confirm it exists', async () => {
    expect((await letan.get(`/api/chat/conversations/${id}`)).status).toBe(404);
  });

  it('is a 404 on its messages', async () => {
    expect((await letan.get(`/api/chat/conversations/${id}/messages`)).status).toBe(404);
  });

  it('cannot be replied to by its own author', async () => {
    const res = await letan.post(`/api/chat/conversations/${id}/messages`).field('body', 'thêm');
    expect(res.status).toBe(404);
  });

  it('is invisible to another receptionist too', async () => {
    expect((await letanB.get(`/api/chat/conversations/${id}`)).status).toBe(404);
  });

  /**
   * THE BADGE IS THE ONE PEOPLE FORGET.
   *
   * A thread hidden from the list but still counted in the sidebar is worse than
   * not hiding it: the receptionist sees a number, finds nothing behind it, and
   * learns that the badge lies. It falls out for free here because the badge is
   * counted through the same predicate as every read.
   */
  it('is not counted in the author’s nav badge', async () => {
    // An Admin reply is what would normally make the badge tick over.
    await admin.post(`/api/chat/conversations/${id}/messages`).field('body', 'đã nhận');

    const res = await letan.get('/api/nav-badges');
    expect(res.status).toBe(200);
    expect(res.body.counts.chat).toBe(0);
  });

  it('leaves an ORDINARY thread from the same receptionist fully visible', async () => {
    const normal = await submit(letan, { body: 'Câu hỏi bình thường' });
    const res = await letan.get('/api/chat/conversations');
    const ids = (res.body.conversations as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(normal);
    expect(ids).not.toContain(id);
  });
});

/* ================================================================== */
/* Anonymity — the Admin's view                                        */
/* ================================================================== */

describe('an Admin sees the anonymous submission, without the author', () => {
  let id = '';
  beforeEach(async () => {
    id = await submit(letan, { anonymous: true, category: 'INTERNAL', body: 'Phản ánh nội bộ' });
  });

  it('shows it in the list as "Ẩn danh"', async () => {
    const res = await admin.get('/api/chat/conversations');
    const row = (res.body.conversations as { id: string }[]).find((c) => c.id === id) as
      | Record<string, unknown>
      | undefined;
    expect(row).toBeDefined();
    expect(row!.anonymous).toBe(true);
    expect(row!.senderLabel).toBe('Ẩn danh');
    // The account is not merely hidden by the UI — it never leaves the server.
    expect(row!.createdBy).toBeNull();
  });

  it('shows no author on the detail or on the message', async () => {
    const detail = await admin.get(`/api/chat/conversations/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.conversation.createdBy).toBeNull();
    expect(detail.body.conversation.senderLabel).toBe('Ẩn danh');

    const messages = await admin.get(`/api/chat/conversations/${id}/messages`);
    expect(messages.body.messages[0].sender).toBeNull();
    expect(messages.body.messages[0].senderLabel).toBe('Ẩn danh');
    // The role is kept — it says a receptionist wrote it, which names nobody.
    expect(messages.body.messages[0].senderRole).toBe('RECEPTIONIST');
  });

  it('does not leak the author through an attachment file name', async () => {
    const anon = await letan
      .post('/api/chat/conversations')
      .field('category', 'INTERNAL')
      .field('body', 'Kèm ảnh')
      .field('anonymous', 'true')
      .attach('images', pngBuffer(), 'bang-luong-cua-Lan.png');
    expect(anon.status).toBe(201);

    const messages = await admin.get(
      `/api/chat/conversations/${anon.body.conversation.id}/messages`,
    );
    const attachment = messages.body.messages[0].attachments[0];
    expect(attachment.originalFileName).not.toContain('Lan');
    expect(attachment.originalFileName).toBe('Tệp đính kèm 1');
  });

  /**
   * AN ADMIN'S OWN REPLY KEEPS ITS NAME.
   *
   * Nulling every sender in the thread would break it in a way that looks like a
   * bug rather than a privacy rule: the thread view decides which side a bubble
   * belongs on by comparing the sender's id to the reader's own, so an Admin with
   * no sender sees their own replies left-aligned and attributed to somebody else.
   */
  it('keeps the Admin identified on their own replies', async () => {
    await admin.post(`/api/chat/conversations/${id}/messages`).field('body', 'Đã ghi nhận');

    const res = await admin.get(`/api/chat/conversations/${id}/messages`);
    const [first, second] = res.body.messages;
    expect(first.sender).toBeNull();
    expect(second.sender).not.toBeNull();
    expect(second.senderLabel).toBe('Quản trị viên');
  });

  it('still shows the branch and the shift, as the audit view specifies', async () => {
    await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Nguyễn Văn A' });
    const withShift = await submit(letan, { anonymous: true, category: 'INTERNAL' });

    const res = await admin.get(`/api/chat/conversations/${withShift}`);
    expect(res.body.conversation.branch).not.toBeNull();
    expect(res.body.conversation.shiftType).toBe('A');
    // …and still no person.
    expect(res.body.conversation.createdBy).toBeNull();
    expect(res.body.conversation.senderLabel).toBe('Ẩn danh');
  });
});

/* ================================================================== */
/* The audit trail behind it                                           */
/* ================================================================== */

describe('the author is recorded even though nobody can read it', () => {
  it('stores the account, the branch and the shift on the row', async () => {
    await letan.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: 'Nguyễn Văn A' });
    const id = await submit(letan, { anonymous: true, category: 'INTERNAL' });

    const row = await testPrisma.chatConversation.findUniqueOrThrow({ where: { id } });
    /*
      Anonymity is enforced on the way OUT, never by declining to write it down:
      an anonymous channel with no record behind it cannot be acted on if it ever
      reports something requiring action against a named person, and cannot be
      defended if somebody abuses it.
    */
    expect(row.anonymous).toBe(true);
    expect(row.createdByUserId).toBe(letanId);
    expect(row.branchId).toBe(cn1);
    expect(row.shiftType).toBe('A');
    expect(row.senderNameSnapshot).toBe('Nguyễn Văn A');
  });

  it('accepts a submission from a receptionist with no open shift', async () => {
    // Reporting a problem is not an accounting act — refusing it to protect a
    // statistic would leave a real complaint unmade.
    const id = await submit(letan, { anonymous: true });
    const row = await testPrisma.chatConversation.findUniqueOrThrow({ where: { id } });
    expect(row.shiftType).toBeNull();
    expect(row.senderNameSnapshot).toBeNull();
  });
});

/* ================================================================== */
/* Immutability and moderation                                         */
/* ================================================================== */

describe('what was said cannot be changed', () => {
  it('has no edit or delete route for a thread or a message', async () => {
    const id = await submit(letan);
    const messages = await admin.get(`/api/chat/conversations/${id}/messages`);
    const messageId = messages.body.messages[0].id as string;

    for (const path of [`/api/chat/conversations/${id}`, `/api/chat/messages/${messageId}`]) {
      expect((await admin.put(path).send({ body: 'viết lại' })).status).toBe(404);
      expect((await admin.patch(path).send({ body: 'viết lại' })).status).toBe(404);
      expect((await admin.delete(path)).status).toBe(404);
    }

    const stored = await testPrisma.chatMessage.findFirstOrThrow({ where: { conversationId: id } });
    expect(stored.body).toBe(BODY);
  });

  it('records the Admin verdict BESIDE the thread, not inside it', async () => {
    const id = await submit(letan, { anonymous: true, category: 'INTERNAL' });

    const res = await admin
      .post(`/api/chat/conversations/${id}/close`)
      .send({ adminNote: 'Đã trao đổi với quản lý chi nhánh.' });
    expect(res.status).toBe(200);
    expect(res.body.conversation.status).toBe('CLOSED');
    expect(res.body.conversation.adminNote).toBe('Đã trao đổi với quản lý chi nhánh.');
    expect(res.body.conversation.handledBy).toMatchObject({ fullName: 'Quản trị viên' });
    expect(res.body.conversation.handledAt).not.toBeNull();

    // The original message is untouched.
    const stored = await testPrisma.chatMessage.findFirstOrThrow({ where: { conversationId: id } });
    expect(stored.body).toBe(BODY);
  });

  it('does not blank an existing note when closed again without one', async () => {
    const id = await submit(letan);
    await admin.post(`/api/chat/conversations/${id}/close`).send({ adminNote: 'Ghi chú đầu tiên' });
    const again = await admin.post(`/api/chat/conversations/${id}/close`).send({});
    expect(again.body.conversation.adminNote).toBe('Ghi chú đầu tiên');
  });

  it('refuses a receptionist trying to close their own thread', async () => {
    const id = await submit(letan);
    expect((await letan.post(`/api/chat/conversations/${id}/close`).send({})).status).toBe(403);
  });
});

/* ================================================================== */
/* Role boundaries                                                     */
/* ================================================================== */

describe('who may reach Chat box at all', () => {
  it('refuses Bộ phận kỹ thuật everywhere', async () => {
    const id = await submit(letan);
    expect((await tech.get('/api/chat/conversations')).status).toBe(403);
    expect((await tech.get(`/api/chat/conversations/${id}`)).status).toBe(403);
    expect((await tech.get(`/api/chat/conversations/${id}/messages`)).status).toBe(403);
    expect((await tech.get('/api/chat/categories')).status).toBe(403);
  });

  it('still refuses an Admin trying to OPEN a thread', async () => {
    const res = await admin
      .post('/api/chat/conversations')
      .field('category', 'ROOM')
      .field('body', BODY);
    expect(res.status).toBe(403);
  });

  it('refuses an anonymous CALLER — which is a different thing entirely', async () => {
    const request = (await import('supertest')).default;
    const res = await request(app)
      .post('/api/chat/conversations')
      .field('category', 'ROOM')
      .field('body', BODY)
      .field('anonymous', 'true');
    // "Gửi ẩn danh" hides the author from other USERS. It has never meant that
    // an unauthenticated stranger may post.
    expect(res.status).toBe(401);
  });
});

/* ================================================================== */
/* The Admin chat report                                               */
/* ================================================================== */

describe('the chat audit report', () => {
  it('lists both modes, with the anonymous one masked', async () => {
    await submit(letan, { category: 'ROOM', body: 'Bình thường' });
    await submit(letan, { category: 'INTERNAL', body: 'Ẩn', anonymous: true });

    const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await admin.get(`/api/admin/reports/chat?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(2);

    const anon = (res.body.conversations as { anonymous: boolean; senderLabel: string; createdBy: unknown }[]).find(
      (c) => c.anonymous,
    );
    expect(anon!.senderLabel).toBe('Ẩn danh');
    expect(anon!.createdBy).toBeNull();

    const normal = (res.body.conversations as { anonymous: boolean; senderLabel: string }[]).find(
      (c) => !c.anonymous,
    );
    expect(normal!.senderLabel).not.toBe('Ẩn danh');
  });

  it('narrows by category and by submission mode', async () => {
    await submit(letan, { category: 'ROOM' });
    await submit(letan, { category: 'INTERNAL', anonymous: true });

    const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const byCategory = await admin.get(
      `/api/admin/reports/chat?from=${today}&to=${today}&category=INTERNAL`,
    );
    expect(byCategory.body.conversations).toHaveLength(1);

    const byMode = await admin.get(
      `/api/admin/reports/chat?from=${today}&to=${today}&anonymous=true`,
    );
    expect(byMode.body.conversations).toHaveLength(1);
    expect(byMode.body.conversations[0].anonymous).toBe(true);
  });

  it('produces a real PDF and is Admin-only', async () => {
    await submit(letan, { category: 'INTERNAL', anonymous: true });
    const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const res = await admin.get(`/api/admin/reports/chat.pdf?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');

    expect((await letan.get(`/api/admin/reports/chat?from=${today}&to=${today}`)).status).toBe(403);
  });
});
