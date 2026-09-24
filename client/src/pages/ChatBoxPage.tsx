/**
 * Chat box — the conversation list.
 *
 * ONE SCREEN, TWO AUDIENCES. An Admin sees every thread and needs to know who
 * asked and from where, so the row carries the sender and branch. A
 * receptionist sees only their own and already knows both, so those columns
 * would be noise — the row leads with the subject instead.
 *
 * "Chưa trả lời" is the Admin's working set, and it is a SERVER-DERIVED status
 * (WAITING_ADMIN), not a guess made here from timestamps. The filter is a plain
 * client-side narrowing of the already-fetched list; the meaning of the word is
 * decided in `chatService`.
 *
 * Only a receptionist can open a thread. That is the feature as specified —
 * reception asks, Admin answers — and the server refuses anything else.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, EyeOff, MessageSquarePlus, Paperclip } from 'lucide-react';
import {
  CHAT_CATEGORIES,
  CHAT_STATUS_LABEL,
  CHAT_STATUS_TONE,
  chatApi,
  type ChatCategory,
  type ChatConversationStatus,
} from '../api/chat';
import { toUserMessage } from '../api/errors';
import { Card } from '../components/Card';
import { DataTable, type DataColumn } from '../components/DataTable';
import { Button } from '../components/Button';
import { ErrorAlert } from '../components/ErrorAlert';
import { Modal } from '../components/Modal';
import { DateRangeField, type DateRangeValue } from '../components/DateRangeField';
import { chatReportPdfUrl } from '../api/reports';
import { EmptyState } from '../components/EmptyState';
import { PageHeader, QueryState } from '../components/PageState';
import { formatDateTime, hcmToday } from '../lib/format';
import { useAuth } from '../auth/AuthProvider';

export function ChatStatusChip({ status }: { status: ChatConversationStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${CHAT_STATUS_TONE[status]}`}
    >
      {CHAT_STATUS_LABEL[status]}
    </span>
  );
}

/**
 * The receptionist's submission form. Collapsed until asked for.
 *
 * THE TITLE IS A CATEGORY NOW, NOT A SENTENCE. A typed title could not be wrong,
 * so it could not be validated, and the Admin's list became a pile of one-off
 * phrases that could not be counted or compared across eight properties —
 * "Máy lạnh hỏng", "may lanh phong 302" and "AC broken" are one question written
 * three ways. Three stable values make "what do reception keep raising?"
 * answerable.
 *
 * TWO SEND BUTTONS, AND THEY DO DIFFERENT THINGS. "Gửi ẩn danh" is not a
 * cosmetic flag: the thread disappears from this screen the moment it is sent,
 * the Admin sees "Ẩn danh" instead of a name, and no reply can come back. The
 * confirmation says so before it happens, because a receptionist who expected an
 * answer and never gets one has been quietly failed.
 */
function NewConversationForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ChatCategory | ''>('');
  const [body, setBody] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmAnonymous, setConfirmAnonymous] = useState(false);

  const create = useMutation({
    mutationFn: (anonymous: boolean) =>
      chatApi.createConversation(category as ChatCategory, body.trim(), images, anonymous),
    onSuccess: () => {
      setCategory('');
      setBody('');
      setImages([]);
      setOpen(false);
      setConfirmAnonymous(false);
      void queryClient.invalidateQueries({ queryKey: ['chat-conversations'] });
      onDone();
    },
    onError: (err) => setFormError(toUserMessage(err)),
  });

  /** The same rule the server applies, so the buttons and the API agree. */
  function validate(): boolean {
    setFormError(null);
    if (category === '') {
      setFormError('Vui lòng chọn loại vấn đề.');
      return false;
    }
    if (body.trim().length === 0) {
      setFormError('Vui lòng nhập nội dung.');
      return false;
    }
    return true;
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} data-testid="chat-new">
        <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
        Đặt câu hỏi
      </Button>
    );
  }

  return (
    <Card className="p-5">
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm text-slate-600" htmlFor="chat-category">
            Loại vấn đề
          </label>
          <select
            id="chat-category"
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            value={category}
            disabled={create.isPending}
            onChange={(e) => setCategory(e.target.value as ChatCategory | '')}
          >
            {/*
              No preselected value. Ca A and Ca A4 taught the same lesson as this
              one: a default the operator did not choose is accepted without
              anybody noticing it was never a decision.
            */}
            <option value="">— Chọn —</option>
            {CHAT_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm text-slate-600" htmlFor="chat-body">
            Nội dung
          </label>
          <textarea
            id="chat-body"
            className="min-h-[96px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={create.isPending}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm text-slate-600" htmlFor="chat-images">
            Ảnh đính kèm (không bắt buộc)
          </label>
          <input
            id="chat-images"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="block w-full text-sm text-slate-600"
            disabled={create.isPending}
            onChange={(e) => setImages(Array.from(e.target.files ?? []))}
          />
          {images.length > 0 ? (
            <p className="mt-1 text-xs text-slate-500">{images.length} ảnh đã chọn</p>
          ) : null}
        </div>
        {formError ? <ErrorAlert>{formError}</ErrorAlert> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={create.isPending}
            data-testid="chat-send"
            onClick={() => {
              if (validate()) create.mutate(false);
            }}
          >
            {create.isPending ? 'Đang gửi…' : 'Gửi'}
          </Button>
          <Button
            variant="secondary"
            disabled={create.isPending}
            data-testid="chat-send-anonymous"
            onClick={() => {
              if (validate()) setConfirmAnonymous(true);
            }}
          >
            <EyeOff className="h-4 w-4" aria-hidden="true" />
            Gửi ẩn danh
          </Button>
          <Button
            variant="secondary"
            disabled={create.isPending}
            onClick={() => {
              setOpen(false);
              setFormError(null);
            }}
          >
            Huỷ
          </Button>
        </div>
      </div>

      {confirmAnonymous ? (
        <Modal
          open
          title="Gửi ẩn danh"
          onClose={() => setConfirmAnonymous(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmAnonymous(false)}>
                Hủy
              </Button>
              <Button
                onClick={() => create.mutate(true)}
                loading={create.isPending}
                data-testid="chat-anonymous-confirm"
              >
                Gửi ẩn danh
              </Button>
            </>
          }
        >
          {/*
            Said plainly BEFORE it happens. All three consequences are real and
            none of them is reversible: the thread leaves this screen, the Admin
            cannot see who wrote it, and there is nowhere for an answer to go.
          */}
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li>Admin sẽ thấy người gửi là “Ẩn danh”.</li>
            <li>Phản ánh này sẽ không còn hiển thị trong danh sách của bạn.</li>
            <li>Bạn sẽ không nhận được câu trả lời cho phản ánh này.</li>
          </ul>
        </Modal>
      ) : null}
    </Card>
  );
}

export function ChatBoxPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [onlyUnanswered, setOnlyUnanswered] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const list = useQuery({
    queryKey: ['chat-conversations'],
    queryFn: () => chatApi.listConversations(),
  });

  const conversations = (list.data?.conversations ?? []).filter((c) =>
    onlyUnanswered ? c.status === 'WAITING_ADMIN' : true,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Chat box"
        description={
          isAdmin
            ? 'Câu hỏi từ lễ tân. Mở một cuộc trò chuyện để trả lời.'
            : 'Đặt câu hỏi cho Admin và xem câu trả lời.'
        }
        actions={
          isAdmin ? (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={onlyUnanswered}
                  onChange={(e) => setOnlyUnanswered(e.target.checked)}
                />
                Chỉ hiện chưa trả lời
              </label>
              <Button variant="secondary" onClick={() => setExportOpen(true)}>
                <Download className="h-4 w-4" aria-hidden="true" />
                Xuất báo cáo
              </Button>
            </div>
          ) : undefined
        }
      />

      {!isAdmin ? <NewConversationForm onDone={() => list.refetch()} /> : null}

      <QueryState isLoading={list.isLoading} isError={list.isError} error={list.error}>
        {conversations.length === 0 ? (
          <EmptyState
            title="Chưa có cuộc trò chuyện nào"
            message={
              isAdmin ? 'Khi lễ tân đặt câu hỏi, nó sẽ xuất hiện ở đây.' : 'Hãy đặt câu hỏi đầu tiên.'
            }
          />
        ) : (
          /*
            ONE ROW PER THREAD, not a card. Forty threads used to be forty tall
            boxes; a row per thread lets an Admin scan status, subject, sender and
            age down a column. The last message sits under the subject, clamped
            to one line — the thread itself is one click away.
          */
          <DataTable
            testId="chat-conversations"
            title={isAdmin ? 'Cuộc trò chuyện' : 'Câu hỏi của bạn'}
            badge={conversations.length}
            columns={chatColumns(isAdmin)}
            rows={conversations}
            rowKey={(c) => c.id}
            emptyTitle="Chưa có cuộc trò chuyện nào"
            emptyMessage="Hãy đặt câu hỏi đầu tiên."
            actions={(c) => (
              <Link
                to={`/app/chat/${c.id}`}
                className="inline-flex items-center rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Mở
              </Link>
            )}
          />
        )}
      </QueryState>

      <p className="flex items-center gap-1.5 text-xs text-slate-400">
        <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
        Ảnh đính kèm chỉ hiển thị cho người trong cuộc trò chuyện.
      </p>

      {exportOpen ? <ChatExportModal onClose={() => setExportOpen(false)} /> : null}
    </div>
  );
}

type Conversation = Awaited<ReturnType<typeof chatApi.listConversations>>['conversations'][number];

/**
 * The thread list's columns. An Admin sees who asked and from where; a
 * receptionist already knows both, so those columns would be noise.
 */
function chatColumns(isAdmin: boolean): DataColumn<Conversation>[] {
  return [
    {
      key: 'status',
      header: 'Trạng thái',
      className: 'w-[1%] whitespace-nowrap',
      render: (c) => <ChatStatusChip status={c.status} />,
    },
    {
      key: 'subject',
      header: 'Chủ đề',
      className: 'min-w-[14rem] max-w-[28rem]',
      render: (c) => (
        <>
          {/* `title` — the category's label, or a legacy thread's own typed title. */}
          <Link to={`/app/chat/${c.id}`} className="font-medium text-slate-900 hover:text-brand-700">
            {c.title}
          </Link>
          {c.anonymous ? (
            <span className="ml-1.5 inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
              <EyeOff className="h-3 w-3" aria-hidden="true" />
              Ẩn danh
            </span>
          ) : null}
          <span className="mt-0.5 block line-clamp-1 text-xs text-slate-500">{c.lastMessagePreview ?? '—'}</span>
        </>
      ),
    },
    ...(isAdmin
      ? [
          {
            key: 'branch',
            header: 'Chi nhánh / khách sạn',
            secondary: true,
            className: 'whitespace-nowrap text-slate-600',
            render: (c: Conversation) => c.branch?.hotelName ?? '—',
          },
          {
            key: 'sender',
            header: 'Người gửi',
            className: 'whitespace-nowrap text-slate-700',
            // Already "Ẩn danh" when it has to be — the server decided that, so
            // no screen can forget to.
            render: (c: Conversation) => c.senderLabel,
          },
        ]
      : []),
    {
      key: 'at',
      header: 'Thời gian',
      className: 'whitespace-nowrap text-slate-500',
      render: (c) => formatDateTime(c.lastMessageAt),
    },
    {
      key: 'count',
      header: 'Số tin nhắn',
      align: 'right',
      secondary: true,
      className: 'w-[1%] whitespace-nowrap',
      render: (c) => c.messageCount,
    },
  ];
}

/**
 * The internal-reports export.
 *
 * ANONYMITY SURVIVES THE FILE. The report is built on the server from the same
 * serialized view this screen reads, so the author of an anonymous submission
 * was already dropped before anything reached the PDF — there is no column in it
 * that could print a name even by mistake.
 */
function ChatExportModal({ onClose }: { onClose: () => void }) {
  const today = hcmToday();
  const [range, setRange] = useState<DateRangeValue>({ from: today, to: today });
  const [category, setCategory] = useState<ChatCategory | ''>('');
  const [mode, setMode] = useState<'' | 'true' | 'false'>('');
  const ready = range.from !== '' && range.to !== '';

  return (
    <Modal
      open
      title="Xuất báo cáo Chat box"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            disabled={!ready}
            data-testid="chat-export-confirm"
            onClick={() => {
              window.open(
                chatReportPdfUrl({
                  from: range.from,
                  to: range.to,
                  category: category || undefined,
                  anonymous: mode || undefined,
                }),
                '_blank',
                'noopener',
              );
              onClose();
            }}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Tải PDF
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <DateRangeField
          legend="Khoảng thời gian"
          value={range}
          onChange={setRange}
          max={today}
          testId="chat-report-range"
        />
        <label className="block text-sm font-medium text-slate-600">
          Loại vấn đề
          <select
            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            value={category}
            aria-label="Lọc theo loại vấn đề"
            onChange={(e) => setCategory(e.target.value as ChatCategory | '')}
          >
            <option value="">Tất cả loại vấn đề</option>
            {CHAT_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-slate-600">
          Hình thức gửi
          <select
            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            value={mode}
            aria-label="Lọc theo hình thức gửi"
            onChange={(e) => setMode(e.target.value as '' | 'true' | 'false')}
          >
            <option value="">Tất cả</option>
            <option value="false">Bình thường</option>
            <option value="true">Ẩn danh</option>
          </select>
        </label>
        <p className="text-xs text-slate-500">
          Phản ánh ẩn danh hiển thị là “Ẩn danh” trong báo cáo.
        </p>
      </div>
    </Modal>
  );
}
