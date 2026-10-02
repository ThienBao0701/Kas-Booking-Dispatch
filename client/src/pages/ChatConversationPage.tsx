/**
 * Chat box — one conversation.
 *
 * Message bubbles are aligned by AUTHORSHIP, not by role: your own messages sit
 * right, the other person's sit left. An Admin and a receptionist looking at
 * the same thread therefore see mirror images of each other, which is what
 * every messaging UI has trained both of them to expect.
 *
 * IMAGES LOAD THROUGH AN AUTHENTICATED ENDPOINT. The `<img src>` points at
 * `/api/chat/attachments/:id/file`, which re-checks on every request that the
 * caller may read this conversation. There is no public URL and no signed link
 * to leak — a copied image URL is useless to anyone not already entitled to it.
 *
 * The thread polls while it is open (`CHAT_POLL_MS`). The application has no
 * realtime transport, and adding one for this would be a connection lifecycle,
 * an auth handshake and a reconnect story in exchange for a few seconds.
 */
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCheck, Send } from 'lucide-react';
import {
  CHAT_POLL_MS,
  chatApi,
  chatAttachmentUrl,
  type ChatMessageView,
} from '../api/chat';
import { toUserMessage } from '../api/errors';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { ErrorAlert } from '../components/ErrorAlert';
import { Modal } from '../components/Modal';
import { PageHeader, QueryState } from '../components/PageState';
import { formatDateTime } from '../lib/format';
import { useAuth } from '../auth/AuthProvider';
import { ChatStatusChip } from './ChatBoxPage';

function MessageBubble({ message, mine }: { message: ChatMessageView; mine: boolean }) {
  return (
    <li className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        data-testid="chat-message"
        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm ${
          mine ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-900'
        }`}
      >
        {/*
          `senderLabel` rather than `sender?.fullName`: on an anonymous thread the
          server has already dropped the account, and the label it sends in its
          place is "Ẩn danh" — so this bubble cannot print a name the rule says it
          must not, and cannot print a bare "—" that looks like a bug.
        */}
        {!mine ? (
          <p className="mb-0.5 text-xs font-medium text-slate-500">{message.senderLabel}</p>
        ) : null}

        {message.body.trim().length > 0 ? (
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        ) : null}

        {message.attachments.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {message.attachments.map((a) => (
              <li key={a.id}>
                <a
                  href={chatAttachmentUrl(a.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-lg ring-1 ring-black/10"
                >
                  <img
                    src={chatAttachmentUrl(a.id)}
                    alt={a.originalFileName}
                    className="h-24 w-24 object-cover"
                  />
                </a>
              </li>
            ))}
          </ul>
        ) : null}

        <p className={`mt-1 text-[11px] ${mine ? 'text-white/70' : 'text-slate-400'}`}>
          {formatDateTime(message.createdAt)}
        </p>
      </div>
    </li>
  );
}

export function ChatConversationPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [adminNote, setAdminNote] = useState('');

  const conversation = useQuery({
    queryKey: ['chat-conversation', id],
    queryFn: () => chatApi.conversation(id),
    enabled: !!id,
  });

  const messages = useQuery({
    queryKey: ['chat-messages', id],
    queryFn: () => chatApi.messages(id),
    enabled: !!id,
    refetchInterval: CHAT_POLL_MS,
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['chat-messages', id] });
    void queryClient.invalidateQueries({ queryKey: ['chat-conversation', id] });
    void queryClient.invalidateQueries({ queryKey: ['chat-conversations'] });
  }

  const send = useMutation({
    mutationFn: () => chatApi.sendMessage(id, draft.trim(), images),
    onSuccess: () => {
      setDraft('');
      setImages([]);
      refresh();
    },
    onError: (err) => setSendError(toUserMessage(err)),
  });

  const close = useMutation({
    mutationFn: (adminNote: string | undefined) => chatApi.close(id, adminNote),
    onSuccess: () => {
      setClosing(false);
      refresh();
    },
    onError: (err) => setSendError(toUserMessage(err)),
  });

  const conv = conversation.data?.conversation;

  return (
    <div className="space-y-5">
      <PageHeader
        title={conv?.title ?? 'Cuộc trò chuyện'}
        description={
          conv
            ? `${conv.senderLabel}${conv.branch ? ` · ${conv.branch.hotelName}` : ''}`
            : undefined
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {conv ? <ChatStatusChip status={conv.status} /> : null}
            {isAdmin && conv && conv.status !== 'CLOSED' ? (
              <Button
                variant="secondary"
                onClick={() => setClosing(true)}
                disabled={close.isPending}
                data-testid="chat-close"
              >
                <CheckCheck className="h-4 w-4" aria-hidden="true" />
                Đã xử lý
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => navigate('/app/chat')}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Danh sách
            </Button>
          </div>
        }
      />

      <QueryState
        isLoading={conversation.isLoading || messages.isLoading}
        isError={conversation.isError || messages.isError}
        error={conversation.error ?? messages.error}
      >
        <Card className="p-5">
          {/*
            AN ANONYMOUS THREAD IS ONE-WAY, AND THE ADMIN IS TOLD SO.

            The author cannot see this thread any more — that is what anonymity
            means here — so a reply typed into the box below is recorded but is
            never read by them. An Admin who believed otherwise would answer into
            silence and think the matter was handled.
          */}
          {conv?.anonymous ? (
            <p
              data-testid="chat-anonymous-notice"
              className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900"
            >
              Phản ánh ẩn danh. Người gửi không xem được cuộc trò chuyện này và sẽ không nhận
              được trả lời. Hãy ghi nhận cách xử lý khi đóng phản ánh.
            </p>
          ) : null}
          <ul className="space-y-3" data-testid="chat-thread">
            {(messages.data?.messages ?? []).map((m) => (
              <MessageBubble key={m.id} message={m} mine={m.sender?.id === user?.id} />
            ))}
            {(messages.data?.messages ?? []).length === 0 ? (
              <li className="text-sm text-slate-400">Chưa có tin nhắn.</li>
            ) : null}
          </ul>
        </Card>
      </QueryState>

      <Card className="p-5">
        {sendError ? <ErrorAlert>{sendError}</ErrorAlert> : null}
        <label className="mb-1 block text-sm text-slate-600" htmlFor="chat-reply">
          Tin nhắn
        </label>
        <textarea
          id="chat-reply"
          data-testid="chat-input"
          className="min-h-[80px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          value={draft}
          disabled={send.isPending}
          onChange={(e) => {
            setDraft(e.target.value);
            if (sendError) setSendError(null);
          }}
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <input
            aria-label="Ảnh đính kèm"
            data-testid="chat-images"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="block text-sm text-slate-600"
            disabled={send.isPending}
            onChange={(e) => setImages(Array.from(e.target.files ?? []))}
          />
          <Button
            disabled={send.isPending}
            onClick={() => {
              if (draft.trim().length === 0 && images.length === 0) {
                setSendError('Vui lòng nhập nội dung hoặc đính kèm ảnh.');
                return;
              }
              send.mutate();
            }}
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            {send.isPending ? 'Đang gửi…' : 'Gửi'}
          </Button>
          {images.length > 0 ? (
            <span className="text-xs text-slate-500">{images.length} ảnh đã chọn</span>
          ) : null}
        </div>
      </Card>

      {closing ? (
        <Modal
          open
          title="Đã xử lý phản ánh"
          onClose={() => setClosing(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setClosing(false)}>
                Hủy
              </Button>
              <Button
                onClick={() => close.mutate(adminNote.trim() || undefined)}
                loading={close.isPending}
                data-testid="chat-close-confirm"
              >
                Xác nhận
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            {/*
              THE ORIGINAL IS NEVER EDITED. The verdict is stored beside the
              thread, not inside the message somebody wrote — an internal report
              a reviewer could rewrite is worth nothing, and an anonymous one
              doubly so.
            */}
            <p className="text-sm text-slate-600">
              Nội dung phản ánh được giữ nguyên. Ghi chú dưới đây được lưu riêng cùng người và
              thời điểm xử lý.
            </p>
            <label className="block text-sm font-medium text-slate-600">
              Ghi chú xử lý <span className="font-normal text-slate-400">(không bắt buộc)</span>
              <textarea
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                rows={3}
                maxLength={2000}
                value={adminNote}
                onChange={(e) => setAdminNote(e.target.value)}
                data-testid="chat-admin-note"
              />
            </label>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
