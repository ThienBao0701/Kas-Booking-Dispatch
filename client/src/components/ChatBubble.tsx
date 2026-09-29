/**
 * THE CHAT BUBBLE — one persistent chat for Admin and Reception.
 *
 * Rendered ONCE, by `AppShell`, so it is on every page of both roles and keeps its
 * open branch, its draft and its scroll position while the person moves between
 * pages. There is no Admin chat and no Reception chat: it is the same component
 * reading the same endpoints, and the SERVER decides what is in the list.
 *
 *   LEFT   the branches. For an Admin, every active branch — the very rows
 *          "Khách sạn & chi nhánh" edits, so a hotel added tomorrow is here
 *          tomorrow with no change on this side. For a receptionist, their own
 *          branch alone: this is not a way to read another hotel's messages.
 *   RIGHT  the conversation with the selected branch, newest at the bottom.
 *
 * UNREAD comes from the server's per-reader cursor (`ChatReadState`), never from
 * anything remembered here: the badge on the bubble is the sum of the branches',
 * a branch's dot clears when its conversation is opened and read, and the count is
 * still right after a reload or in a second tab.
 *
 * There is no realtime transport in this application, so both lists poll — the
 * branch list every twenty seconds for the badge, and an open conversation every
 * six for the messages (`CHAT_POLL_MS`).
 *
 * THE OLD QUESTION THREADS ARE STILL THERE. Their pages are unchanged and one
 * link in the panel's footer opens them; only the menu entry went.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ImagePlus, MessagesSquare, Search, Send, X } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import {
  CHAT_CHANNELS_POLL_MS,
  CHAT_POLL_MS,
  chatApi,
  chatAttachmentUrl,
  type ChatChannelView,
  type ChatMessageView,
} from '../api/chat';
import { toUserMessage } from '../api/errors';
import { branchOptionLabel, branchTone } from '../lib/branchTone';
import { relativeTime } from '../lib/format';

/** The channel list, shared so a page that changes chat state can refresh the badge. */
export const CHAT_CHANNELS_KEY = ['chat', 'channels'] as const;

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_IMAGES = 10;
const MAX_BYTES = 10 * 1024 * 1024;

/** "05 Trương Định" — the address without the branch number, for a tight list row. */
function shortName(channel: Pick<ChatChannelView, 'address' | 'hotelName'>): string {
  return channel.address || channel.hotelName;
}

export function ChatBubble() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [search, setSearch] = useState('');

  const channels = useQuery({
    queryKey: CHAT_CHANNELS_KEY,
    queryFn: () => chatApi.channels(),
    refetchInterval: CHAT_CHANNELS_POLL_MS,
    refetchOnWindowFocus: true,
  });
  const list = useMemo(() => channels.data?.channels ?? [], [channels.data]);
  const totalUnread = list.reduce((sum, c) => sum + c.unreadCount, 0);

  // A receptionist has exactly one branch: open it straight away rather than
  // asking them to pick the only thing there is.
  useEffect(() => {
    if (open && activeId === null && list.length === 1) setActiveId(list[0]!.branchId);
  }, [open, activeId, list]);

  // A branch that disappears (deactivated) while selected must not leave a
  // conversation open on nothing.
  useEffect(() => {
    if (activeId !== null && list.length > 0 && !list.some((c) => c.branchId === activeId)) setActiveId(null);
  }, [activeId, list]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!user) return null;
  const active = list.find((c) => c.branchId === activeId) ?? null;
  const single = list.length === 1;
  // Phone: the list and the conversation take turns. Desktop: side by side. A
  // receptionist's single branch has no list to choose from at all.
  const listClass = single ? 'hidden' : active ? 'hidden sm:flex sm:w-64' : 'flex w-full sm:w-64';
  const paneClass = single || active ? 'flex' : 'hidden sm:flex';
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? list.filter((c) => `${c.address} ${c.hotelName} chi nhánh ${c.branchNumber}`.toLowerCase().includes(needle))
    : list;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-3 print:hidden" data-testid="chat-bubble-root">
      {open ? (
        <section
          role="dialog"
          aria-label="Chat với chi nhánh"
          data-testid="chat-panel"
          className="flex h-[min(34rem,calc(100vh-7rem))] w-[min(46rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-slate-300 bg-white shadow-2xl"
        >
          <div className="flex min-h-0 flex-1">
            {/* Branch list. On a phone it and the conversation take turns. */}
            <aside
              aria-label="Danh sách chi nhánh"
              className={`${listClass} shrink-0 flex-col border-r border-slate-200 bg-slate-50`}
            >
              <div className="border-b border-slate-200 px-3 py-2.5">
                <p className="text-sm font-semibold text-slate-900">Chat chi nhánh</p>
                <div className="relative mt-2">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" aria-hidden="true" />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Tìm chi nhánh…"
                    aria-label="Tìm chi nhánh"
                    className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-8 pr-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                  />
                </div>
              </div>
              <ul className="flex-1 overflow-y-auto" data-testid="chat-branch-list">
                {channels.isLoading ? <li className="px-3 py-4 text-sm text-slate-500">Đang tải…</li> : null}
                {channels.isError ? (
                  <li className="px-3 py-4 text-sm text-red-600">{toUserMessage(channels.error)}</li>
                ) : null}
                {shown.map((c) => (
                  <BranchRow key={c.branchId} channel={c} active={c.branchId === activeId} onSelect={() => setActiveId(c.branchId)} />
                ))}
                {!channels.isLoading && shown.length === 0 && !channels.isError ? (
                  <li className="px-3 py-4 text-sm text-slate-500">Không có chi nhánh phù hợp.</li>
                ) : null}
              </ul>
            </aside>

            <div className={`${paneClass} min-w-0 flex-1 flex-col`}>
              {active ? (
                <Conversation
                  key={active.branchId}
                  channel={active}
                  myId={user.id}
                  onBack={single ? undefined : () => setActiveId(null)}
                  onClose={() => setOpen(false)}
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-sm text-slate-500">
                  <MessagesSquare className="mb-2 h-8 w-8 text-slate-300" aria-hidden="true" />
                  Chọn một chi nhánh để bắt đầu cuộc trò chuyện.
                </div>
              )}
            </div>
          </div>
          {/*
            The old question threads, one link away — in a footer of its own so a
            receptionist, whose single branch has no list column, still reaches them.
          */}
          <Link
            to="/app/chat"
            onClick={() => setOpen(false)}
            className="border-t border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-white"
          >
            Gửi vấn đề riêng / ẩn danh →
          </Link>
        </section>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={totalUnread > 0 ? `Chat — ${totalUnread} tin chưa đọc` : 'Chat'}
        aria-expanded={open}
        data-testid="chat-bubble"
        className="relative flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
      >
        {open ? <X className="h-6 w-6" aria-hidden="true" /> : <MessagesSquare className="h-6 w-6" aria-hidden="true" />}
        {totalUnread > 0 ? (
          <span
            data-testid="chat-bubble-unread"
            className="absolute -right-1 -top-1 inline-flex min-w-[1.4rem] items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-bold leading-none text-white ring-2 ring-white"
          >
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        ) : null}
      </button>
    </div>
  );
}

function BranchRow({ channel, active, onSelect }: { channel: ChatChannelView; active: boolean; onSelect: () => void }) {
  const tone = branchTone({ id: channel.branchId, branchNumber: channel.branchNumber });
  const unread = channel.unreadCount > 0;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        data-testid={`chat-branch-${channel.branchId}`}
        className={`flex w-full items-center gap-2.5 border-l-4 px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 ${
          active ? `bg-white ${tone.rail}` : 'border-l-transparent hover:bg-white/70'
        }`}
      >
        <span
          aria-hidden="true"
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${tone.solid}`}
        >
          {String(channel.branchNumber || '·').padStart(2, '0')}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={`truncate text-sm ${unread ? 'font-bold text-slate-900' : 'font-medium text-slate-800'}`}>
              {shortName(channel)}
            </span>
            {channel.lastMessage ? (
              <span className="shrink-0 text-[10px] text-slate-400">{relativeTime(channel.lastMessage.createdAt)}</span>
            ) : null}
          </span>
          <span className="flex items-center justify-between gap-2">
            <span className={`truncate text-xs ${unread ? 'font-medium text-slate-700' : 'text-slate-500'}`}>
              {channel.lastMessage
                ? `${channel.lastMessage.mine ? 'Bạn: ' : ''}${channel.lastMessage.preview || '[Hình ảnh]'}`
                : 'Chưa có tin nhắn'}
            </span>
            {unread ? (
              <span
                data-testid={`chat-unread-${channel.branchId}`}
                aria-label={`${channel.unreadCount} tin chưa đọc`}
                className="inline-flex min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-[11px] font-bold leading-none text-white"
              >
                {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

function Conversation({
  channel,
  myId,
  onBack,
  onClose,
}: {
  channel: ChatChannelView;
  myId: number;
  onBack?: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastReadKey = useRef<string>('');

  const messages = useQuery({
    queryKey: ['chat', 'channel', channel.branchId, 'messages'],
    queryFn: () => chatApi.channelMessages(channel.branchId),
    refetchInterval: CHAT_POLL_MS,
    refetchOnWindowFocus: true,
  });
  const items = useMemo(() => messages.data?.messages ?? [], [messages.data]);

  // Opening a conversation reads it: once the messages are on screen, tell the
  // server, so the unread dot goes and stays gone. Keyed on the newest message so
  // a reply that arrives while it is open is read too, without a call per poll.
  const newest = items[items.length - 1]?.id ?? '';
  const read = useMutation({
    mutationFn: () => chatApi.markChannelRead(channel.branchId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: CHAT_CHANNELS_KEY }),
  });
  useEffect(() => {
    if (!messages.isSuccess) return;
    const key = `${channel.branchId}:${newest}`;
    if (lastReadKey.current === key) return;
    lastReadKey.current = key;
    if (channel.unreadCount > 0 || items.some((m) => m.sender?.id !== myId)) read.mutate();
    // `read` is stable enough; depending on it would re-run on every mutation state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.isSuccess, newest, channel.branchId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [newest]);

  const send = useMutation({
    mutationFn: () => chatApi.sendChannelMessage(channel.branchId, draft.trim(), images),
    onSuccess: async () => {
      setDraft('');
      setImages([]);
      setError(null);
      if (fileRef.current) fileRef.current.value = '';
      await queryClient.invalidateQueries({ queryKey: ['chat', 'channel', channel.branchId, 'messages'] });
      await queryClient.invalidateQueries({ queryKey: CHAT_CHANNELS_KEY });
    },
    onError: (e) => setError(toUserMessage(e)),
  });

  function submit() {
    if (send.isPending) return;
    if (draft.trim().length === 0 && images.length === 0) return;
    send.mutate();
  }

  function pick(files: FileList | null) {
    const picked = Array.from(files ?? []);
    const bad = picked.find((f) => !ACCEPTED.includes(f.type) || f.size > MAX_BYTES);
    if (bad) {
      setError(!ACCEPTED.includes(bad.type) ? 'Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP.' : 'Ảnh vượt quá 10 MB.');
      return;
    }
    if (images.length + picked.length > MAX_IMAGES) {
      setError(`Tối đa ${MAX_IMAGES} ảnh mỗi tin nhắn.`);
      return;
    }
    setError(null);
    setImages((prev) => [...prev, ...picked]);
    if (fileRef.current) fileRef.current.value = '';
  }

  const tone = branchTone({ id: channel.branchId, branchNumber: channel.branchNumber });
  return (
    <>
      <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Quay lại danh sách chi nhánh"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 sm:hidden"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        <span aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${tone.solid}`}>
          {String(channel.branchNumber || '·').padStart(2, '0')}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900" data-testid="chat-active-branch">
            {branchOptionLabel(channel)}
          </p>
          <p className="truncate text-xs text-slate-500">{channel.hotelName}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng chat"
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto bg-slate-100/60 px-3 py-3" data-testid="chat-messages" aria-live="polite">
        {messages.isLoading ? <p className="text-center text-sm text-slate-500">Đang tải…</p> : null}
        {messages.isError ? <p className="text-center text-sm text-red-600">{toUserMessage(messages.error)}</p> : null}
        {messages.isSuccess && items.length === 0 ? (
          <p className="pt-8 text-center text-sm text-slate-500">Chưa có tin nhắn. Hãy gửi tin đầu tiên.</p>
        ) : null}
        {items.map((m) => (
          <Bubble key={m.id} message={m} mine={m.sender?.id === myId} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-slate-200 bg-white px-3 py-2.5">
        {error ? (
          <p role="alert" className="mb-1.5 text-xs text-red-600">
            {error}
          </p>
        ) : null}
        {images.length > 0 ? (
          <ul className="mb-1.5 flex flex-wrap gap-1.5" aria-label="Ảnh đã chọn">
            {images.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2.5 pr-1 text-xs text-slate-700">
                <span className="max-w-[9rem] truncate">{f.name}</span>
                <button
                  type="button"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Bỏ ảnh ${f.name}`}
                  className="rounded-full p-0.5 hover:bg-slate-200"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-end gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED.join(',')}
            multiple
            className="sr-only"
            aria-label="Ảnh đính kèm"
            data-testid="chat-bubble-images"
            onChange={(e) => pick(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="Đính kèm ảnh"
            className="rounded-xl border border-slate-300 p-2.5 text-slate-500 hover:bg-slate-50"
          >
            <ImagePlus className="h-4 w-4" aria-hidden="true" />
          </button>
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter is a new line — like every messaging app.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            maxLength={5000}
            placeholder="Nhập tin nhắn…"
            aria-label="Tin nhắn"
            data-testid="chat-bubble-input"
            className="max-h-28 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          />
          <button
            type="button"
            onClick={submit}
            disabled={send.isPending || (draft.trim().length === 0 && images.length === 0)}
            aria-label="Gửi"
            data-testid="chat-bubble-send"
            className="rounded-xl bg-brand-600 p-2.5 text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </>
  );
}

const ROLE_TAG: Record<string, string> = { ADMIN: 'Admin', RECEPTIONIST: 'Lễ tân' };

function Bubble({ message, mine }: { message: ChatMessageView; mine: boolean }) {
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`} data-testid="chat-message">
      <div
        className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
          mine ? 'rounded-br-md bg-brand-600 text-white' : 'rounded-bl-md bg-white text-slate-800'
        }`}
      >
        {mine ? null : (
          <p className="mb-0.5 text-[11px] font-semibold text-slate-500">
            {message.senderLabel} · {ROLE_TAG[message.senderRole] ?? message.senderRole}
          </p>
        )}
        {message.body ? <p className="whitespace-pre-wrap break-words">{message.body}</p> : null}
        {message.attachments.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {message.attachments.map((a) => (
              <a key={a.id} href={chatAttachmentUrl(a.id)} target="_blank" rel="noopener noreferrer">
                <img
                  src={chatAttachmentUrl(a.id)}
                  alt={a.originalFileName}
                  className="h-24 w-24 rounded-lg border border-black/10 object-cover"
                />
              </a>
            ))}
          </div>
        ) : null}
        <p className={`mt-1 text-right text-[10px] ${mine ? 'text-white/70' : 'text-slate-400'}`}>
          {relativeTime(message.createdAt)}
        </p>
      </div>
    </div>
  );
}
