/**
 * Chat box — the receptionist↔Admin question thread.
 *
 * IMAGES ARE NEVER ADDRESSED BY A PUBLIC URL. `attachmentUrl` points at an
 * authenticated endpoint that re-checks, per request, that the caller may read
 * the conversation the image belongs to. The stored file name never appears
 * here and is not something this module can construct a path from.
 *
 * There is no realtime transport in this application, so the conversation view
 * polls. See `CHAT_POLL_MS`.
 */
import { api } from './client';

export type ChatConversationStatus = 'WAITING_ADMIN' | 'ANSWERED' | 'CLOSED';

/**
 * What a submission is about. A CLOSED LIST that replaced the typed title.
 *
 * The labels are duplicated from the server for rendering only; the server
 * refuses anything outside this set, so the form cannot widen it.
 */
export type ChatCategory = 'ROOM' | 'WORK_ENVIRONMENT' | 'INTERNAL';

export const CHAT_CATEGORIES: { value: ChatCategory; label: string }[] = [
  { value: 'ROOM', label: 'Phòng' },
  { value: 'WORK_ENVIRONMENT', label: 'Môi trường làm việc' },
  { value: 'INTERNAL', label: 'Các vấn đề nội bộ' },
];

export const CHAT_CATEGORY_LABEL: Record<ChatCategory, string> = Object.fromEntries(
  CHAT_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<ChatCategory, string>;

/** What an anonymous author is called, to everyone who can see the thread. */
export const ANONYMOUS_LABEL = 'Ẩn danh';

export const CHAT_STATUS_LABEL: Record<ChatConversationStatus, string> = {
  WAITING_ADMIN: 'Chờ Admin trả lời',
  ANSWERED: 'Đã trả lời',
  CLOSED: 'Đã đóng',
};

export const CHAT_STATUS_TONE: Record<ChatConversationStatus, string> = {
  WAITING_ADMIN: 'bg-amber-50 text-amber-700 ring-amber-200',
  ANSWERED: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  CLOSED: 'bg-slate-100 text-slate-600 ring-slate-200',
};

/**
 * How often an open conversation re-reads its messages.
 *
 * Six seconds is a deliberate compromise: fast enough that a reply feels
 * immediate in a conversation people are actively having, slow enough that a
 * screen left open all day is a rounding error against the rest of the app's
 * traffic. It is only polled while a conversation is open, never from the list.
 */
export const CHAT_POLL_MS = 6000;

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
  senderRole: 'ADMIN' | 'RECEPTIONIST' | 'BOOKING_DEPARTMENT' | 'TECHNICAL' | 'HOUSEKEEPING';
  /** Null on an anonymous author's messages — the account never reaches here. */
  sender: { id: number; fullName: string } | null;
  /** What to PRINT: the sender's name, or "Ẩn danh". Decided by the server. */
  senderLabel: string;
  createdAt: string;
  attachments: ChatAttachmentView[];
}

export interface ChatConversationView {
  id: string;
  /** The typed title, on threads that predate the category selector. */
  subject: string | null;
  category: ChatCategory | null;
  /** The heading to render, whichever of the two the thread has. */
  title: string;
  status: ChatConversationStatus;
  branch: { id: number; code: string; hotelName: string } | null;
  /** Null on an anonymous thread. Render `senderLabel` instead. */
  createdBy: { id: number; fullName: string; role: string } | null;
  senderLabel: string;
  anonymous: boolean;
  shiftType: string | null;
  handledBy: { id: number; fullName: string } | null;
  handledAt: string | null;
  adminNote: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  messageCount: number;
}

/**
 * ONE ENTRY OF THE CHAT BUBBLE'S BRANCH LIST.
 *
 * The list is the branch table (the server builds it from `Branch`), so a hotel
 * added under "Khách sạn & chi nhánh" appears here with no change on this side.
 * A receptionist's list has exactly one entry — their own branch.
 */
export interface ChatChannelView {
  branchId: number;
  branchNumber: number;
  address: string;
  hotelName: string;
  /** Null until somebody has written. */
  conversationId: string | null;
  lastMessage: { preview: string; createdAt: string; senderLabel: string; mine: boolean } | null;
  /** Messages by somebody else since this reader last opened the channel. */
  unreadCount: number;
}

/**
 * The bubble polls at this rate while closed (the badge) and, once a branch is
 * open, re-reads its messages at `CHAT_POLL_MS`. No realtime transport exists in
 * this application, and a badge that is twenty seconds late is not worth one.
 */
export const CHAT_CHANNELS_POLL_MS = 20_000;

/** The authenticated bytes endpoint. Never a public or guessable file path. */
export function chatAttachmentUrl(attachmentId: string): string {
  return `/api/chat/attachments/${attachmentId}/file`;
}

export const chatApi = {
  /** The bubble: one entry per branch the caller may open, with unread counts. */
  channels: () => api.get<{ channels: ChatChannelView[] }>('/chat/channels'),

  channelMessages: (branchId: number) =>
    api.get<{ messages: ChatMessageView[] }>(`/chat/channels/${branchId}/messages`),

  sendChannelMessage: (branchId: number, body: string, images: File[]) => {
    const form = new FormData();
    form.append('body', body);
    for (const image of images) form.append('images', image);
    return api.postForm<{ message: ChatMessageView }>(`/chat/channels/${branchId}/messages`, form);
  },

  markChannelRead: (branchId: number) => api.post<{ ok: true }>(`/chat/channels/${branchId}/read`, {}),

  listConversations: () =>
    api.get<{ conversations: ChatConversationView[] }>('/chat/conversations'),

  conversation: (id: string) =>
    api.get<{ conversation: ChatConversationView }>(`/chat/conversations/${id}`),

  messages: (id: string) =>
    api.get<{ messages: ChatMessageView[] }>(`/chat/conversations/${id}/messages`),

  /**
   * Opens a thread. `anonymous` is sent as the literal string 'true'/'false'
   * because this is multipart — the server compares against 'true' rather than
   * coercing, since `Boolean('false')` is `true`.
   */
  createConversation: (
    category: ChatCategory,
    body: string,
    images: File[],
    anonymous = false,
  ) => {
    const form = new FormData();
    form.append('category', category);
    form.append('body', body);
    form.append('anonymous', anonymous ? 'true' : 'false');
    for (const image of images) form.append('images', image);
    return api.postForm<{ conversation: ChatConversationView; message: ChatMessageView }>(
      '/chat/conversations',
      form,
    );
  },

  sendMessage: (id: string, body: string, images: File[]) => {
    const form = new FormData();
    form.append('body', body);
    for (const image of images) form.append('images', image);
    return api.postForm<{ message: ChatMessageView }>(
      `/chat/conversations/${id}/messages`,
      form,
    );
  },

  /** Admin: mark handled. The note is recorded BESIDE the thread, never in it. */
  close: (id: string, adminNote?: string) =>
    api.post<{ conversation: ChatConversationView }>(`/chat/conversations/${id}/close`, {
      adminNote,
    }),
};
