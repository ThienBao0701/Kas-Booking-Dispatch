/**
 * Chat box — receptionists asking the Admin questions, inside the application.
 *
 * HUMAN TO HUMAN. There is no assistant, no suggestion, no generated reply
 * anywhere in this module. Every message has a person behind it.
 *
 * THE ACCESS RULE, ONCE, IN ONE PLACE: an Admin reads every conversation; a
 * receptionist reads only the conversations they created. It is expressed as
 * `visibilityWhere()` and applied to EVERY read — list, detail, message and
 * attachment — so a new endpoint cannot quietly widen it by forgetting a
 * filter. Nothing accepts a conversation id from the client without running it
 * through that filter first.
 *
 * VISIBILITY IS OWNERSHIP, NOT BRANCH. Two receptionists at the same branch
 * must not read each other's questions to the Admin — the existing branch model
 * scopes bookings and issues, which belong to a branch, whereas a question
 * belongs to the person who asked it. No requirement anywhere in the product
 * asks for branch-level chat visibility, so none is granted.
 *
 * BỘ PHẬN ĐẶT PHÒNG IS NOT INCLUDED. That role exists for Chứng từ and has no
 * stated role in reception↔Admin correspondence, so it gets no access rather
 * than an assumed one.
 */
import type { ChatCategory, Prisma, PrismaClient, ShiftType, UserRole } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { captureShiftContext, type ShiftActor } from '../shift/shiftService';
import { scopedBranchFilter } from '../auth/branchScope';

/**
 * What a submission is about. The closed list that replaced the typed title.
 *
 * The labels live HERE and are served to the client, rather than being written
 * out again in React: a category whose name differs between the form and the
 * Admin's report is a category nobody can count.
 */
export const CHAT_CATEGORY_LABELS: Record<ChatCategory, string> = {
  ROOM: 'Phòng',
  WORK_ENVIRONMENT: 'Môi trường làm việc',
  INTERNAL: 'Các vấn đề nội bộ',
};

export const CHAT_CATEGORIES: { value: ChatCategory; label: string }[] = (
  Object.keys(CHAT_CATEGORY_LABELS) as ChatCategory[]
).map((value) => ({ value, label: CHAT_CATEGORY_LABELS[value] }));

/** What an anonymous author is called, everywhere, to everyone. */
export const ANONYMOUS_LABEL = 'Ẩn danh';

/** Who is acting. Mirrors the shape the rest of the app already passes around. */
export interface ChatActor {
  id: number;
  role: UserRole;
  branchId: number | null;
  /** Quản lý lễ tân only: the branches it supervises (see `auth/branchScope.ts`). */
  managedBranchIds?: readonly number[];
}

/**
 * The roles that may use Chat box at all. The two reception supervisors reach
 * only the branch CHANNELS (their route allow-list omits the question threads),
 * and only for the branches in their scope.
 */
export const CHAT_ROLES: readonly UserRole[] = [
  'ADMIN',
  'RECEPTIONIST',
  'RECEPTION_MANAGER',
  'RECEPTION_GENERAL_MANAGER',
];

export function assertChatAccess(actor: ChatActor): void {
  if (!CHAT_ROLES.includes(actor.role)) {
    throw ApiError.forbidden('Bạn không có quyền truy cập Chat box.');
  }
}

/**
 * The one visibility predicate. An Admin gets `{}` (everything); anyone else is
 * pinned to their own conversations.
 *
 * Returned as a Prisma `where` fragment rather than a boolean check on a row we
 * already fetched, so the restriction runs IN THE DATABASE. A "fetch then
 * compare" version leaks existence through timing and through the difference
 * between 403 and 404; this simply cannot return another user's row.
 */
export function visibilityWhere(actor: ChatActor): Prisma.ChatConversationWhereInput {
  /*
    BRANCH CHANNELS ARE NEVER QUESTION THREADS. The persistent branch
    conversation behind the chat bubble lives in the same table, and without this
    clause the old thread list would show it (and, for a receptionist who happened
    to write the first message, treat it as their own). See `channelWhere`.
  */
  if (actor.role === 'ADMIN') return { branchChannel: false };
  /*
    `anonymous: false` IS THE WHOLE OF THE ANONYMITY RULE.

    Because every read — the list, the detail, the messages, the attachment
    download and the sidebar badge — runs through this one predicate, adding the
    clause here removes an anonymous thread from all five at once. The
    alternative, filtering at each of those five sites, is five places to
    remember and one of them eventually forgotten.

    THE AUTHOR LOSES SIGHT OF IT TOO, and that is the specified behaviour rather
    than an oversight: an anonymous report that its author can still open is a
    report whose author can be identified by watching who opens it. The
    consequence — that an Admin reply cannot reach them — is real, and is why the
    Admin's verdict is recorded in `adminNote` on the thread instead.
  */
  return { createdByUserId: actor.id, anonymous: false, branchChannel: false };
}

/**
 * THE VISIBILITY RULE OF A BRANCH CHANNEL — the chat bubble's conversation.
 *
 * The opposite of the question threads above: what decides access is the
 * BRANCH, not who wrote. Every Admin reads every channel; a receptionist reads
 * the channel of the branch they are assigned to and no other (`?? -1` matches no
 * branch, so an unassigned account reads nothing). Every other role is refused —
 * Bộ phận đặt phòng, kỹ thuật and buồng phòng have no part in this conversation.
 *
 * A DATABASE FRAGMENT, applied to every channel read, list, message and
 * attachment, for the same reason as `visibilityWhere`.
 */
export function channelWhere(actor: ChatActor): Prisma.ChatConversationWhereInput {
  assertChatAccess(actor);
  if (actor.role === 'ADMIN') return { branchChannel: true };
  // The shared scope: a receptionist's own branch, a manager's assigned ones,
  // every branch for the general manager — the same answer every screen uses.
  return { branchChannel: true, ...scopedBranchFilter(actor) };
}

export const MESSAGE_INCLUDE = {
  sender: { select: { id: true, fullName: true, role: true } },
  attachments: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      originalFileName: true,
      mimeType: true,
      fileSize: true,
      createdAt: true,
    },
  },
} as const;

const CONVERSATION_INCLUDE = {
  branch: { select: { id: true, code: true, hotelName: true } },
  createdBy: { select: { id: true, fullName: true, role: true } },
  handledBy: { select: { id: true, fullName: true } },
} as const;

export interface ChatAttachmentView {
  id: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
}

export interface ChatMessageView {
  id: string;
  conversationId: string;
  body: string;
  senderRole: UserRole;
  /** Null on an anonymous author's messages, so the account never reaches a UI. */
  sender: { id: number; fullName: string } | null;
  /** What to PRINT for the sender — "Ẩn danh" when the author is anonymous. */
  senderLabel: string;
  createdAt: string;
  attachments: ChatAttachmentView[];
}

export interface ChatConversationView {
  id: string;
  /** The typed title, on threads that predate the category selector. */
  subject: string | null;
  category: ChatCategory | null;
  /** What to PRINT as the thread's heading, whichever of the two it has. */
  title: string;
  status: 'WAITING_ADMIN' | 'ANSWERED' | 'CLOSED';
  branch: { id: number; code: string; hotelName: string } | null;
  /** Null on an anonymous thread. Use `senderLabel` to display. */
  createdBy: { id: number; fullName: string; role: UserRole } | null;
  senderLabel: string;
  anonymous: boolean;
  /** Which shift raised it, for the Admin's audit view. */
  shiftType: ShiftType | null;
  handledBy: { id: number; fullName: string } | null;
  handledAt: string | null;
  adminNote: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  /** Denormalised for the list: enough to render a row without a second call. */
  lastMessagePreview: string | null;
  messageCount: number;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const MAX_BODY = 5000;

/**
 * A submission must name one of the three categories.
 *
 * REPLACES `assertSubject`, which validated free text. That is the point of the
 * change: a typed title could not be wrong, so it could not be validated, and
 * "Máy lạnh hỏng" / "may lanh phong 302" / "AC broken" were three unaskable
 * questions instead of one countable one.
 */
export function assertCategory(category: unknown): ChatCategory {
  if (typeof category === 'string' && category in CHAT_CATEGORY_LABELS) {
    return category as ChatCategory;
  }
  throw ApiError.validation('Vui lòng chọn loại vấn đề.');
}

/**
 * The first message of a thread must carry TEXT.
 *
 * Deliberately stricter than `assertBody`, which a reply uses: a reply of one
 * photo in an open thread is a perfectly clear thing to send, but a brand new
 * submission whose entire content is an unexplained image gives an Admin a
 * category and a picture and nothing to act on.
 */
export function assertInitialBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) throw ApiError.validation('Vui lòng nhập nội dung.');
  if (trimmed.length > MAX_BODY) throw ApiError.validation('Nội dung quá dài.');
  return trimmed;
}

/**
 * A message must carry something. An empty body is allowed ONLY when images are
 * attached — an "empty" message with no attachments is a mis-click, and storing
 * it would put a blank bubble in a thread nobody can interpret.
 */
export function assertBody(body: string, attachmentCount: number): string {
  const trimmed = body.trim();
  if (trimmed.length === 0 && attachmentCount === 0) {
    throw ApiError.validation('Vui lòng nhập nội dung hoặc đính kèm ảnh.');
  }
  if (trimmed.length > MAX_BODY) throw ApiError.validation('Nội dung quá dài.');
  return trimmed;
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

type ConversationRow = {
  id: string;
  subject: string | null;
  category: ChatCategory | null;
  anonymous: boolean;
  shiftType: ShiftType | null;
  senderNameSnapshot: string | null;
  handledAt: Date | null;
  adminNote: string | null;
  status: 'WAITING_ADMIN' | 'ANSWERED' | 'CLOSED';
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  branch: { id: number; code: string; hotelName: string } | null;
  createdBy: { id: number; fullName: string; role: UserRole } | null;
  handledBy: { id: number; fullName: string } | null;
};

/**
 * WHERE ANONYMITY IS ACTUALLY ENFORCED FOR A READER.
 *
 * `visibilityWhere` decides WHO may open the thread; this decides what they see
 * once they have. Only an Admin ever gets here for an anonymous thread, and the
 * account behind it is dropped before the object leaves the server — there is no
 * hidden field for a client to find, and no flag a UI has to remember to respect.
 *
 * BRANCH AND SHIFT ARE KEPT, as the audit view specifies. Be clear-eyed about
 * what that costs: a branch has a handful of receptionists and a shift narrows
 * it further, so an Admin who wants to work out who wrote an anonymous report
 * usually can. The anonymity here is a rule about what the product displays, not
 * a cryptographic guarantee — and it is worth having anyway, because it removes
 * the name from every ordinary screen where it would otherwise be read by
 * accident.
 */
function serializeConversation(
  row: ConversationRow,
  extra: { lastMessagePreview: string | null; messageCount: number },
): ChatConversationView {
  const anonymous = row.anonymous;
  return {
    id: row.id,
    subject: row.subject,
    category: row.category,
    // Built on the server so the list, the thread and the PDF say it the same
    // way, and so a legacy thread still has a heading.
    title: row.category
      ? CHAT_CATEGORY_LABELS[row.category]
      : row.subject ?? 'Cuộc trò chuyện',
    status: row.status,
    branch: row.branch,
    createdBy: anonymous ? null : row.createdBy,
    senderLabel: anonymous
      ? ANONYMOUS_LABEL
      : row.senderNameSnapshot ?? row.createdBy?.fullName ?? '—',
    anonymous,
    shiftType: row.shiftType,
    handledBy: row.handledBy,
    handledAt: row.handledAt ? row.handledAt.toISOString() : null,
    adminNote: row.adminNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastMessagePreview: extra.lastMessagePreview,
    messageCount: extra.messageCount,
  };
}

export type MessageRow = {
  id: string;
  conversationId: string;
  body: string;
  senderRole: UserRole;
  createdAt: Date;
  sender: { id: number; fullName: string; role: UserRole } | null;
  attachments: {
    id: string;
    originalFileName: string;
    mimeType: string;
    fileSize: number;
    createdAt: Date;
  }[];
};

/**
 * ONLY THE ANONYMOUS AUTHOR'S OWN MESSAGES LOSE THEIR IDENTITY.
 *
 * An Admin replying inside an anonymous thread is not anonymous, and nulling
 * their sender too would break the thread view in a way that looks like a bug
 * rather than a privacy rule: the view decides which side a bubble belongs on by
 * comparing `sender.id` to the reader's own, so an Admin with no sender would
 * see their own replies left-aligned and labelled as somebody else's.
 *
 * `originalFileName` goes with the name. It is the author's own file name, and
 * "bang-luong-thang-8-cua-Lan.png" identifies a person just as precisely as the
 * field this function is careful to drop.
 */
export function serializeMessage(
  row: MessageRow,
  opts: { anonymous: boolean } = { anonymous: false },
): ChatMessageView {
  const hide = opts.anonymous && row.senderRole !== 'ADMIN';
  return {
    id: row.id,
    conversationId: row.conversationId,
    body: row.body,
    senderRole: row.senderRole,
    sender: hide || !row.sender ? null : { id: row.sender.id, fullName: row.sender.fullName },
    senderLabel: hide ? ANONYMOUS_LABEL : row.sender?.fullName ?? '—',
    createdAt: row.createdAt.toISOString(),
    attachments: row.attachments.map((a, index) => ({
      id: a.id,
      originalFileName: hide ? `Tệp đính kèm ${index + 1}` : a.originalFileName,
      mimeType: a.mimeType,
      fileSize: a.fileSize,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

export async function listConversations(
  actor: ChatActor,
  client: PrismaClient = defaultPrisma,
): Promise<ChatConversationView[]> {
  assertChatAccess(actor);

  const rows = await client.chatConversation.findMany({
    where: visibilityWhere(actor),
    orderBy: { lastMessageAt: 'desc' },
    include: {
      ...CONVERSATION_INCLUDE,
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { body: true, attachments: { select: { id: true } } },
      },
      _count: { select: { messages: true } },
    },
  });

  return rows.map((row) => {
    const last = row.messages[0];
    // A picture-only message has no text to preview; say so rather than
    // rendering an empty row the operator cannot distinguish from a bug.
    const preview = last
      ? last.body.trim().length > 0
        ? last.body.trim()
        : last.attachments.length > 0
          ? '[Hình ảnh]'
          : null
      : null;
    return serializeConversation(row as unknown as ConversationRow, {
      lastMessagePreview: preview,
      messageCount: row._count.messages,
    });
  });
}

/**
 * One conversation the actor is allowed to see, or 404.
 *
 * NOT FOUND, NOT FORBIDDEN, for a conversation belonging to someone else: a 403
 * would confirm the id exists, which is itself information a receptionist has
 * no business learning about another receptionist's thread.
 */
export async function getConversation(
  id: string,
  actor: ChatActor,
  client: PrismaClient = defaultPrisma,
): Promise<ChatConversationView> {
  assertChatAccess(actor);

  const row = await client.chatConversation.findFirst({
    where: { id, ...visibilityWhere(actor) },
    include: {
      ...CONVERSATION_INCLUDE,
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { body: true, attachments: { select: { id: true } } },
      },
      _count: { select: { messages: true } },
    },
  });
  if (!row) throw ApiError.notFound('Không tìm thấy cuộc trò chuyện.');

  const last = row.messages[0];
  const preview = last
    ? last.body.trim().length > 0
      ? last.body.trim()
      : last.attachments.length > 0
        ? '[Hình ảnh]'
        : null
    : null;
  return serializeConversation(row as unknown as ConversationRow, {
    lastMessagePreview: preview,
    messageCount: row._count.messages,
  });
}

export async function listMessages(
  conversationId: string,
  actor: ChatActor,
  client: PrismaClient = defaultPrisma,
): Promise<ChatMessageView[]> {
  // Re-uses the visibility check rather than trusting the id. The result is kept
  // rather than discarded: it is also what tells the serializer whether the
  // thread is anonymous.
  const conversation = await getConversation(conversationId, actor, client);

  const rows = await client.chatMessage.findMany({
    // The conversation filter is restated HERE as well, rather than relying on
    // the visibility check above having run. It is redundant today and it is
    // meant to be: a future read that forgets line one would otherwise return
    // every message in the table, and `where` is the cheaper habit.
    where: { conversationId, conversation: visibilityWhere(actor) },
    orderBy: { createdAt: 'asc' },
    include: MESSAGE_INCLUDE,
  });
  return (rows as unknown as MessageRow[]).map((row) =>
    serializeMessage(row, { anonymous: conversation.anonymous }),
  );
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

export interface NewAttachment {
  storedFileName: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
}

/**
 * Starts a thread with its first message.
 *
 * ONLY A RECEPTIONIST OPENS A CONVERSATION. The feature is "reception asks the
 * Admin"; an Admin-initiated thread is a different feature (a broadcast or a
 * direct message) with different expectations, and inventing it here would ship
 * something nobody specified.
 *
 * The branch is a snapshot of the ASKER's own branch, taken server-side. It is
 * never read from the request: a client-supplied branch would let a receptionist
 * label their question with someone else's location.
 */
export async function createConversation(
  input: {
    category: unknown;
    body: string;
    attachments: NewAttachment[];
    /** "Gửi ẩn danh" rather than "Gửi". */
    anonymous?: boolean;
  },
  actor: ChatActor,
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ conversation: ChatConversationView; message: ChatMessageView }> {
  assertChatAccess(actor);
  if (actor.role !== 'RECEPTIONIST') {
    throw ApiError.forbidden('Chỉ lễ tân mới mở được cuộc trò chuyện mới.');
  }

  const category = assertCategory(input.category);
  const body = assertInitialBody(input.body);
  const anonymous = input.anonymous === true;

  /*
    THE AUTHOR IS RECORDED EVEN WHEN THE SUBMISSION IS ANONYMOUS.

    `createdByUserId` is written exactly as it always was. Anonymity is enforced
    on the way OUT — `visibilityWhere` hides the thread from reception and
    `serializeConversation` drops the account before the object leaves the
    server — never by declining to write it down. An anonymous channel with no
    record behind it cannot be acted on if it ever reports something that
    requires action against a named person, and cannot be defended if somebody
    abuses it.

    The shift is captured for the same reason it is captured on an incident: so
    the Admin can see which shift raised what. It is null when nobody had checked
    in, rather than blocking the submission.
  */
  const shift = await captureShiftContext(actor as ShiftActor, client);

  const created = await client.chatConversation.create({
    data: {
      category,
      anonymous,
      branchId: actor.branchId,
      createdByUserId: actor.id,
      shiftSessionId: shift.shiftSessionId,
      shiftType: shift.shiftType,
      senderNameSnapshot: shift.receptionistName,
      status: 'WAITING_ADMIN',
      lastMessageAt: now,
      messages: {
        create: {
          senderUserId: actor.id,
          senderRole: actor.role,
          body,
          createdAt: now,
          attachments: { create: input.attachments },
        },
      },
    },
    include: {
      ...CONVERSATION_INCLUDE,
      messages: { orderBy: { createdAt: 'asc' }, include: MESSAGE_INCLUDE },
      _count: { select: { messages: true } },
    },
  });

  const message = (created.messages as unknown as MessageRow[])[0]!;
  return {
    conversation: serializeConversation(created as unknown as ConversationRow, {
      lastMessagePreview: message.body.trim().length > 0 ? message.body.trim() : '[Hình ảnh]',
      messageCount: created._count.messages,
    }),
    message: serializeMessage(message, { anonymous }),
  };
}

/**
 * Appends a message to a thread the actor may see.
 *
 * The status follows from WHO SPOKE, not from anything the client asked for:
 * an Admin reply marks the thread ANSWERED, a receptionist message puts it back
 * to WAITING_ADMIN. That is what the Admin list's "chưa trả lời" filter reads,
 * so it must be a consequence of the write rather than a separate flag someone
 * can forget to set.
 *
 * A CLOSED thread is reopened by a new receptionist message rather than
 * rejecting it — the alternative is a receptionist with a follow-up and nowhere
 * to put it.
 */
export async function addMessage(
  conversationId: string,
  input: { body: string; attachments: NewAttachment[] },
  actor: ChatActor,
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ChatMessageView> {
  // Visibility first: this throws 404 for a thread the actor may not see.
  const conversation = await getConversation(conversationId, actor, client);

  const body = assertBody(input.body, input.attachments.length);

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
    data: {
      lastMessageAt: now,
      status: actor.role === 'ADMIN' ? 'ANSWERED' : 'WAITING_ADMIN',
    },
  });

  return serializeMessage(message as unknown as MessageRow, {
    anonymous: conversation.anonymous,
  });
}

/**
 * Admin-only: mark a thread handled.
 *
 * THE ORIGINAL IS NEVER TOUCHED. The verdict is written to its own columns
 * beside the conversation — who closed it, when, and an optional note — rather
 * than into the message the receptionist wrote. There is no endpoint anywhere in
 * this module that edits a message body, and there must not be: the value of an
 * internal report is that it still says what it said, and an anonymous report
 * that a reviewer could rewrite is worth nothing at all.
 */
export async function closeConversation(
  conversationId: string,
  actor: ChatActor,
  input: { adminNote?: string } = {},
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<ChatConversationView> {
  assertChatAccess(actor);
  if (actor.role !== 'ADMIN') {
    throw ApiError.forbidden('Chỉ Admin mới đóng được cuộc trò chuyện.');
  }
  await getConversation(conversationId, actor, client);
  const adminNote = input.adminNote?.trim();
  await client.chatConversation.update({
    where: { id: conversationId },
    data: {
      status: 'CLOSED',
      handledByUserId: actor.id,
      handledAt: now,
      // Left alone when nothing was typed, so re-closing never blanks a note
      // somebody wrote the first time.
      ...(adminNote ? { adminNote } : {}),
    },
  });
  return getConversation(conversationId, actor, client);
}

/**
 * Authorises an attachment download and returns what is needed to serve it.
 *
 * The join back to the conversation carries the SAME visibility filter as every
 * other read. An attachment id is a cuid and unguessable, but "unguessable" is
 * not an access control — this is.
 */
export async function authorizeChatAttachment(
  attachmentId: string,
  actor: ChatActor,
  client: PrismaClient = defaultPrisma,
): Promise<{ storedFileName: string; mimeType: string; originalFileName: string }> {
  assertChatAccess(actor);

  const row = await client.chatAttachment.findFirst({
    where: {
      id: attachmentId,
      // A question thread's attachment (owner-visible) OR a branch channel's
      // (branch-visible) — two different rules, either of which may admit it.
      OR: [
        { message: { conversation: visibilityWhere(actor) } },
        { message: { conversation: channelWhere(actor) } },
      ],
    },
    select: { storedFileName: true, mimeType: true, originalFileName: true },
  });
  if (!row) throw ApiError.notFound('Không tìm thấy tệp.');
  return row;
}
