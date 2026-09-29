/**
 * BRANCH CHANNELS — the conversation behind the chat bubble.
 *
 * ONE PERSISTENT CONVERSATION PER BRANCH, between the Admins and that branch's
 * reception. It is a `ChatConversation` row like any other (`branchChannel =
 * true`), so messages, attachments, the upload pipeline and the serializer are
 * the ones the question threads already use; what is new is only WHO may read it
 * (`channelWhere`: the branch, not the author) and the unread cursor
 * (`ChatReadState`).
 *
 * THE BRANCH LIST IS THE BRANCH TABLE. An Admin's list is every active `Branch` —
 * the same rows "Khách sạn & chi nhánh" edits — with or without a conversation
 * yet, so a branch added tomorrow is in the chat tomorrow with no change here. A
 * receptionist's list is their own branch and nothing else: the chat is not a way
 * to read another hotel's correspondence.
 *
 * THE CONVERSATION IS CREATED BY THE FIRST MESSAGE, not by listing. Opening the
 * bubble must not write rows for eight silent branches.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import {
  MESSAGE_INCLUDE,
  assertBody,
  channelWhere,
  serializeMessage,
  type ChatActor,
  type ChatMessageView,
  type MessageRow,
  type NewAttachment,
} from './chatService';

/** How many of the newest messages a channel view returns. */
export const CHANNEL_PAGE_SIZE = 200;

export interface ChatChannelView {
  branchId: number;
  branchNumber: number;
  address: string;
  hotelName: string;
  /** Null until somebody has written. */
  conversationId: string | null;
  lastMessage: {
    preview: string;
    createdAt: string;
    senderLabel: string;
    /** True when the reader wrote it, so the list can say "Bạn: …". */
    mine: boolean;
  } | null;
  /** Messages written by somebody else since this reader last opened the channel. */
  unreadCount: number;
}

/** The one branch check: which branches may this actor open? */
async function loadBranch(branchId: number, actor: ChatActor, client: PrismaClient) {
  const branch = await client.branch.findFirst({ where: { id: branchId, active: true } });
  // NOT FOUND for a branch the actor may not open: a 403 would confirm it exists.
  if (!branch || (actor.role !== 'ADMIN' && actor.branchId !== branch.id)) {
    throw ApiError.notFound('Không tìm thấy chi nhánh.');
  }
  return branch;
}

export async function listChannels(
  actor: ChatActor,
  client: PrismaClient = defaultPrisma,
): Promise<ChatChannelView[]> {
  const conversationScope = channelWhere(actor); // also refuses every other role
  const branches = await client.branch.findMany({
    where:
      actor.role === 'ADMIN' ? { active: true } : { active: true, id: actor.branchId ?? -1 },
    orderBy: [{ branchNumber: 'asc' }, { id: 'asc' }],
  });
  const conversations = await client.chatConversation.findMany({
    where: { ...conversationScope, branchId: { in: branches.map((b) => b.id) } },
    select: {
      id: true,
      branchId: true,
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          body: true,
          createdAt: true,
          senderUserId: true,
          sender: { select: { fullName: true } },
          attachments: { select: { id: true } },
        },
      },
      readStates: { where: { userId: actor.id }, select: { lastReadAt: true } },
    },
  });

  // One indexed count per channel: (conversationId, createdAt) is an index.
  const unread = await client.$transaction(
    conversations.map((c) =>
      client.chatMessage.count({
        where: {
          conversationId: c.id,
          senderUserId: { not: actor.id },
          ...(c.readStates[0] ? { createdAt: { gt: c.readStates[0].lastReadAt } } : {}),
        },
      }),
    ),
  );

  return branches.map((b) => {
    const index = conversations.findIndex((c) => c.branchId === b.id);
    const conversation = index >= 0 ? conversations[index]! : null;
    const last = conversation?.messages[0] ?? null;
    return {
      branchId: b.id,
      branchNumber: b.branchNumber,
      address: b.address,
      hotelName: b.hotelName,
      conversationId: conversation?.id ?? null,
      lastMessage: last
        ? {
            preview:
              last.body.trim().length > 0
                ? last.body.trim()
                : last.attachments.length > 0
                  ? '[Hình ảnh]'
                  : '',
            createdAt: last.createdAt.toISOString(),
            senderLabel: last.sender?.fullName ?? '—',
            mine: last.senderUserId === actor.id,
          }
        : null,
      unreadCount: index >= 0 ? (unread[index] ?? 0) : 0,
    };
  });
}

/** The channel's newest messages, oldest first. An unopened channel is simply empty. */
export async function listChannelMessages(
  branchId: number,
  actor: ChatActor,
  client: PrismaClient = defaultPrisma,
): Promise<ChatMessageView[]> {
  await loadBranch(branchId, actor, client);
  const rows = await client.chatMessage.findMany({
    // The channel filter is restated on the message query, like `listMessages`.
    where: { conversation: { ...channelWhere(actor), branchId } },
    orderBy: { createdAt: 'desc' },
    take: CHANNEL_PAGE_SIZE,
    include: MESSAGE_INCLUDE,
  });
  return (rows as unknown as MessageRow[]).reverse().map((row) => serializeMessage(row));
}

/** Finds the branch's channel, creating it on first use. Race-safe. */
async function ensureChannel(
  branchId: number,
  actor: ChatActor & { fullName?: string },
  client: PrismaClient,
  now: Date,
): Promise<string> {
  const find = () =>
    client.chatConversation.findFirst({
      where: { branchChannel: true, branchId },
      select: { id: true },
    });
  const existing = await find();
  if (existing) return existing.id;
  try {
    const created = await client.chatConversation.create({
      data: {
        branchChannel: true,
        branchId,
        createdByUserId: actor.id,
        senderNameSnapshot: actor.fullName ?? null,
        status: 'WAITING_ADMIN',
        lastMessageAt: now,
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    // Two first messages at once: the partial unique index let one through, and
    // the other simply joins it.
    if ((error as { code?: string }).code === 'P2002') {
      const raced = await find();
      if (raced) return raced.id;
    }
    throw error;
  }
}

export async function sendChannelMessage(
  branchId: number,
  input: { body: string; attachments: NewAttachment[] },
  actor: ChatActor & { fullName?: string },
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ChatMessageView> {
  await loadBranch(branchId, actor, client);
  const body = assertBody(input.body, input.attachments.length);
  const conversationId = await ensureChannel(branchId, actor, client, now);

  const message = await client.chatMessage.create({
    data: {
      conversationId,
      senderUserId: actor.id,
      senderRole: actor.role,
      body,
      createdAt: now,
      attachments: { create: input.attachments },
    },
    include: MESSAGE_INCLUDE,
  });
  await client.chatConversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: now, status: actor.role === 'ADMIN' ? 'ANSWERED' : 'WAITING_ADMIN' },
  });
  // Writing is reading: the sender's own message never counts as unread to them.
  await markRead(conversationId, actor.id, now, client);
  return serializeMessage(message as unknown as MessageRow);
}

async function markRead(
  conversationId: string,
  userId: number,
  now: Date,
  client: PrismaClient | Prisma.TransactionClient,
): Promise<void> {
  await client.chatReadState.upsert({
    where: { conversationId_userId: { conversationId, userId } },
    create: { conversationId, userId, lastReadAt: now },
    update: { lastReadAt: now },
  });
}

/** "I have seen everything up to now" — a no-op for a channel nobody has written in. */
export async function markChannelRead(
  branchId: number,
  actor: ChatActor,
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<void> {
  await loadBranch(branchId, actor, client);
  const conversation = await client.chatConversation.findFirst({
    where: { ...channelWhere(actor), branchId },
    select: { id: true },
  });
  if (!conversation) return;
  await markRead(conversation.id, actor.id, now, client);
}
