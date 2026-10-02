/**
 * THE CHAT BUBBLE — one persistent conversation per branch.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The branch list IS the branch table: an Admin sees every active branch,
 *      a branch added later appears with no other change, a deactivated one goes.
 *   2. A receptionist sees their own branch's channel and no other; everyone in
 *      the branch shares it. Other roles are refused.
 *   3. Unread is a per-reader cursor: somebody else's message is unread until the
 *      reader opens the channel, and your own message never is.
 *   4. One channel per branch, even when two first messages race.
 *   5. The old question threads and their anonymity rule are untouched — a
 *      channel never shows up in them and they never show up in a channel.
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

type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];
const app = createApp();

let cn1 = 0;
let cn2 = 0;
let admin: Agent;
let admin2: Agent;
let letan: Agent;
let letan1b: Agent;
let letan2: Agent;
let tech: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'LY_TU_TRONG_260' } })).id;
  await createAdmin({ mustChangePassword: false });
  await createAdmin({ username: 'admin2', fullName: 'Admin Hai', mustChangePassword: false });
  await createReceptionist(cn1, { username: 'letan1', fullName: 'Lễ tân 1', mustChangePassword: false });
  await createReceptionist(cn1, { username: 'letan1b', fullName: 'Lễ tân 1B', mustChangePassword: false });
  await createReceptionist(cn2, { username: 'letan2', fullName: 'Lễ tân 2', mustChangePassword: false });
  await createUser({ username: 'kythuat', password: RECEPTIONIST_PASSWORD, fullName: 'Kỹ thuật', role: 'TECHNICAL' });
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  admin2 = (await loginAgent(app, 'admin2', ADMIN_PASSWORD)).agent;
  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  letan1b = (await loginAgent(app, 'letan1b', RECEPTIONIST_PASSWORD)).agent;
  letan2 = (await loginAgent(app, 'letan2', RECEPTIONIST_PASSWORD)).agent;
  tech = (await loginAgent(app, 'kythuat', RECEPTIONIST_PASSWORD)).agent;
});

beforeEach(async () => {
  await testPrisma.chatReadState.deleteMany();
  await testPrisma.chatAttachment.deleteMany();
  await testPrisma.chatMessage.deleteMany();
  await testPrisma.chatConversation.deleteMany();
  await testPrisma.branch.updateMany({ data: { active: true } });
});

afterAll(async () => {
  await resetAll();
});

type Channel = { branchId: number; unreadCount: number; conversationId: string | null; lastMessage: { preview: string; mine: boolean } | null };
const channels = async (agent: Agent) => {
  const res = await agent.get('/api/chat/channels');
  expect(res.status).toBe(200);
  return res.body.channels as Channel[];
};
const unread = async (agent: Agent, branchId: number) => (await channels(agent)).find((c) => c.branchId === branchId)?.unreadCount;
const send = (agent: Agent, branchId: number, body: string) =>
  agent.post(`/api/chat/channels/${branchId}/messages`).field('body', body);

describe('the branch list is the branch table', () => {
  it('gives the Admin every active branch — silent ones included', async () => {
    const list = await channels(admin);
    expect(list).toHaveLength(8);
    expect(list.every((c) => c.conversationId === null && c.unreadCount === 0 && c.lastMessage === null)).toBe(true);
    // Opening the list wrote nothing.
    expect(await testPrisma.chatConversation.count()).toBe(0);
  });

  it('shows a branch added later, and drops a deactivated one', async () => {
    const added = await testPrisma.branch.create({
      data: { code: 'BRANCH_MOI_99', hotelName: 'Khách sạn mới', address: '99 Đường Mới', branchNumber: 99 },
    });
    expect((await channels(admin)).map((c) => c.branchId)).toContain(added.id);
    await testPrisma.branch.update({ where: { id: added.id }, data: { active: false } });
    expect((await channels(admin)).map((c) => c.branchId)).not.toContain(added.id);
    await testPrisma.branch.delete({ where: { id: added.id } });
  });

  it('gives a receptionist their own branch and no other', async () => {
    expect((await channels(letan)).map((c) => c.branchId)).toEqual([cn1]);
    expect((await channels(letan2)).map((c) => c.branchId)).toEqual([cn2]);
  });

  it('refuses every other role', async () => {
    expect((await tech.get('/api/chat/channels')).status).toBe(403);
  });
});

describe('talking to a branch', () => {
  it('creates the branch channel on the first message and shares it across the branch', async () => {
    expect((await send(letan, cn1, 'Xin chào Admin')).status).toBe(201);
    expect((await send(admin, cn1, 'Chào bạn')).status).toBe(201);
    expect(await testPrisma.chatConversation.count({ where: { branchChannel: true, branchId: cn1 } })).toBe(1);

    // A colleague on the same branch reads the same conversation, both sides.
    const seen = await letan1b.get(`/api/chat/channels/${cn1}/messages`);
    expect(seen.body.messages.map((m: { body: string }) => m.body)).toEqual(['Xin chào Admin', 'Chào bạn']);
    expect(seen.body.messages[1]).toMatchObject({ senderRole: 'ADMIN', sender: { fullName: 'Quản trị viên' } });
    // …and so does a second Admin.
    expect((await admin2.get(`/api/chat/channels/${cn1}/messages`)).body.messages).toHaveLength(2);
  });

  it('keeps one branch’s channel from every other branch’s reception', async () => {
    await send(letan, cn1, 'Riêng chi nhánh 1');
    expect((await letan2.get(`/api/chat/channels/${cn1}/messages`)).status).toBe(404);
    expect((await send(letan2, cn1, 'Xen vào')).status).toBe(404);
    expect((await letan2.post(`/api/chat/channels/${cn1}/read`)).status).toBe(404);
    expect((await channels(letan2)).find((c) => c.branchId === cn1)).toBeUndefined();
    expect(await testPrisma.chatMessage.count()).toBe(1);
  });

  it('refuses an empty message and an unknown or inactive branch', async () => {
    expect((await send(letan, cn1, '   ')).status).toBe(422);
    expect((await send(admin, 999_999, 'x')).status).toBe(404);
    await testPrisma.branch.update({ where: { id: cn2 }, data: { active: false } });
    expect((await send(admin, cn2, 'x')).status).toBe(404);
  });

  it('lets the Admin write first, to a branch that has never spoken', async () => {
    expect((await send(admin, cn2, 'Nhắc chi nhánh 2')).status).toBe(201);
    expect((await letan2.get(`/api/chat/channels/${cn2}/messages`)).body.messages).toHaveLength(1);
  });

  it('creates exactly one channel when two first messages race', async () => {
    const results = await Promise.all([send(letan, cn1, 'A'), send(letan1b, cn1, 'B'), send(admin, cn1, 'C')]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(await testPrisma.chatConversation.count({ where: { branchChannel: true, branchId: cn1 } })).toBe(1);
    expect(await testPrisma.chatMessage.count()).toBe(3);
  });

  it('carries an image, served only to people who may read the channel', async () => {
    const res = await letan
      .post(`/api/chat/channels/${cn1}/messages`)
      .field('body', 'Ảnh hỏng hóc')
      .attach('images', pngBuffer(), 'hong.png');
    expect(res.status).toBe(201);
    const attachmentId = res.body.message.attachments[0].id as string;
    expect((await admin.get(`/api/chat/attachments/${attachmentId}/file`)).status).toBe(200);
    expect((await letan1b.get(`/api/chat/attachments/${attachmentId}/file`)).status).toBe(200);
    expect((await letan2.get(`/api/chat/attachments/${attachmentId}/file`)).status).toBe(404);
  });
});

describe('unread', () => {
  it('counts other people’s messages until the channel is read, and never your own', async () => {
    await send(letan, cn1, 'Một');
    await send(letan, cn1, 'Hai');
    expect(await unread(letan, cn1)).toBe(0);
    expect(await unread(admin, cn1)).toBe(2);
    expect(await unread(letan1b, cn1)).toBe(2);

    expect((await admin.post(`/api/chat/channels/${cn1}/read`)).status).toBe(200);
    expect(await unread(admin, cn1)).toBe(0);
    // Reading is per person: the other Admin and the colleague still have it unread.
    expect(await unread(admin2, cn1)).toBe(2);
    expect(await unread(letan1b, cn1)).toBe(2);
  });

  it('turns unread again on a reply, and clears it for the sender at once', async () => {
    await send(letan, cn1, 'Hỏi');
    await admin.post(`/api/chat/channels/${cn1}/read`);
    await new Promise((r) => setTimeout(r, 5));
    await send(admin, cn1, 'Đáp');
    expect(await unread(admin, cn1)).toBe(0);
    expect(await unread(letan, cn1)).toBe(1);
    expect(await unread(admin2, cn1)).toBe(2);
  });

  it('reports the last message for the list, and whether it was yours', async () => {
    await send(letan, cn1, 'Tin cuối');
    const own = (await channels(letan)).find((c) => c.branchId === cn1)!;
    expect(own.lastMessage).toMatchObject({ preview: 'Tin cuối', mine: true });
    const seenByAdmin = (await channels(admin)).find((c) => c.branchId === cn1)!;
    expect(seenByAdmin.lastMessage).toMatchObject({ preview: 'Tin cuối', mine: false });
  });
});

describe('the old question threads', () => {
  it('never show a channel, and a channel never shows them', async () => {
    await send(letan, cn1, 'Tin nhắn kênh');
    const thread = await letan
      .post('/api/chat/conversations')
      .field('category', 'ROOM')
      .field('body', 'Câu hỏi riêng')
      .field('anonymous', 'false');
    expect(thread.status).toBe(201);

    for (const agent of [letan, admin]) {
      const list = await agent.get('/api/chat/conversations');
      expect(list.body.conversations).toHaveLength(1);
      expect(list.body.conversations[0].title).toBe('Phòng');
    }
    // A channel's id is not a thread's: the thread endpoints do not serve it.
    const channelId = (await channels(admin)).find((c) => c.branchId === cn1)!.conversationId!;
    expect((await admin.get(`/api/chat/conversations/${channelId}`)).status).toBe(404);
    expect((await letan.get(`/api/chat/conversations/${channelId}/messages`)).status).toBe(404);
    expect((await channels(admin)).find((c) => c.branchId === cn1)!.lastMessage!.preview).toBe('Tin nhắn kênh');
  });
});
