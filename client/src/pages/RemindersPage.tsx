/**
 * "Nhắc nhở" — one screen, two audiences.
 *
 * An Admin writes to ONE named receptionist and sees what they have sent, with
 * whether it was read. A receptionist sees only their own inbox; the filtering
 * is done in the database by `recipientUserId`, so this component never has to
 * be trusted to hide anything.
 *
 * Deliberately separate from the notification bell: that stream is
 * system-generated booking events, and mixing Admin prose into it would distort
 * the unread badge reception uses to spot new work.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, Send } from 'lucide-react';
import { remindersApi, REMINDER_POLL_MS, type ReminderView } from '../api/reminders';
import { adminUsersApi } from '../api/adminUsers';
import { toUserMessage } from '../api/errors';
import { Card } from '../components/Card';
import { DataTable, type DataColumn } from '../components/DataTable';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { PageHeader } from '../components/PageState';
import { Toast } from '../components/Toast';
import { formatDateTime } from '../lib/format';
import { useAuth } from '../auth/AuthProvider';

/**
 * The "everyone" recipient.
 *
 * A sentinel rather than a real id, and deliberately not numeric, so it can
 * never be confused with a user id by `Number()`.
 */
const ALL_BRANCHES = 'ALL_BRANCHES';

/** Admin: pick one receptionist or every branch, write, send. */
function ComposeReminder({ onSent }: { onSent: () => void }) {
  const queryClient = useQueryClient();
  const [recipientId, setRecipientId] = useState<string>('');
  const [body, setBody] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => adminUsersApi.list(),
    staleTime: 5 * 60_000,
  });

  // Only ACTIVE receptionists. A disabled account would take the message and
  // never show it to anyone, while the Admin believed it was delivered.
  const receptionists = (users.data?.users ?? []).filter(
    (u) => u.role === 'RECEPTIONIST' && u.active,
  );

  const send = useMutation({
    /*
      One place decides which call to make, so "send once" holds for both: the
      button fires a single request either way, and the all-branches case is one
      server-side fan-out rather than a loop of requests from the browser that
      could half-succeed and leave some branches told and others not.
    */
    mutationFn: async (): Promise<void> => {
      if (recipientId === ALL_BRANCHES) {
        await remindersApi.createForAllBranches(body.trim());
        return;
      }
      await remindersApi.create(Number(recipientId), body.trim());
    },
    onSuccess: () => {
      setBody('');
      setRecipientId('');
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['reminders'] });
      onSent();
    },
    onError: (e) => setFormError(toUserMessage(e)),
  });

  return (
    <Card className="p-4">
      <p className="mb-2 text-sm font-semibold text-slate-700">Gửi nhắc nhở</p>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-sm text-slate-600" htmlFor="reminder-recipient">
            Người nhận
          </label>
          <select
            id="reminder-recipient"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            value={recipientId}
            disabled={send.isPending}
            onChange={(e) => setRecipientId(e.target.value)}
          >
            <option value="">— Chọn lễ tân —</option>
            {/* Everyone, first — it is the broadest choice, so it reads before
                the list an Admin would otherwise scroll to reach. */}
            <option value={ALL_BRANCHES}>Tất cả chi nhánh</option>
            {receptionists.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName} ({u.username})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm text-slate-600" htmlFor="reminder-body">
            Nội dung
          </label>
          <textarea
            id="reminder-body"
            data-testid="reminder-body"
            className="min-h-[96px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
            value={body}
            disabled={send.isPending}
            onChange={(e) => {
              setBody(e.target.value);
              if (formError) setFormError(null);
            }}
          />
        </div>
        {formError ? <ErrorAlert>{formError}</ErrorAlert> : null}
        <Button
          disabled={send.isPending}
          data-testid="reminder-send"
          onClick={() => {
            if (recipientId === '') {
              setFormError('Vui lòng chọn lễ tân nhận nhắc nhở.');
              return;
            }
            if (body.trim().length === 0) {
              setFormError('Vui lòng nhập nội dung nhắc nhở.');
              return;
            }
            send.mutate();
          }}
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          {send.isPending ? 'Đang gửi…' : 'Gửi'}
        </Button>
      </div>
    </Card>
  );
}

/** "Đánh dấu đã đọc" — the receptionist's one action on a reminder. */
function MarkRead({ reminder: r }: { reminder: ReminderView }) {
  const queryClient = useQueryClient();
  const markRead = useMutation({
    mutationFn: () => remindersApi.markRead(r.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reminders'] });
      void queryClient.invalidateQueries({ queryKey: ['reminders', 'unread-count'] });
    },
  });
  return (
    <Button
      variant="secondary"
      onClick={() => markRead.mutate()}
      disabled={markRead.isPending}
      data-testid={`reminder-read-${r.id}`}
    >
      Đánh dấu đã đọc
    </Button>
  );
}

function ReadState({ reminder: r, canRead }: { reminder: ReminderView; canRead: boolean }) {
  if (r.read) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
        Đã đọc
        {r.readAt ? <span className="font-normal text-slate-400">· {formatDateTime(r.readAt)}</span> : null}
      </span>
    );
  }
  if (canRead) return <MarkRead reminder={r} />;
  return (
    <span className="whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
      Chưa đọc
    </span>
  );
}

/**
 * ONE ROW PER REMINDER, not a padded block. An Admin reviewing a week of
 * reminders scans recipient, branch and read status down a column; the message
 * is clamped to two lines here and shown whole when the row is opened.
 */
function reminderColumns(isAdmin: boolean, branchOf: (userId: number) => string | null): DataColumn<ReminderView>[] {
  const body: DataColumn<ReminderView> = {
    key: 'body',
    header: 'Nội dung',
    className: 'min-w-[16rem] max-w-[32rem]',
    render: (r) => (
      <span className={`line-clamp-2 whitespace-pre-wrap break-words ${r.read ? 'text-slate-700' : 'font-medium text-slate-900'}`}>
        {r.body}
      </span>
    ),
  };
  const sender: DataColumn<ReminderView> = {
    key: 'sender',
    header: 'Người gửi',
    secondary: true,
    className: 'whitespace-nowrap text-slate-600',
    render: (r) => r.sender?.fullName ?? '—',
  };
  const at: DataColumn<ReminderView> = {
    key: 'at',
    header: 'Thời gian',
    className: 'whitespace-nowrap text-slate-500',
    render: (r) => formatDateTime(r.createdAt),
  };
  const state: DataColumn<ReminderView> = {
    key: 'state',
    header: 'Trạng thái',
    className: 'w-[1%] whitespace-nowrap',
    render: (r) => <ReadState reminder={r} canRead={!isAdmin} />,
  };
  if (!isAdmin) return [body, sender, at, state];
  return [
    {
      key: 'recipient',
      header: 'Người nhận',
      className: 'whitespace-nowrap font-medium text-slate-800',
      render: (r) => r.recipient?.fullName ?? '—',
    },
    body,
    {
      key: 'branch',
      header: 'Chi nhánh',
      secondary: true,
      className: 'whitespace-nowrap text-slate-500',
      render: (r) => (r.recipient ? (branchOf(r.recipient.id) ?? '—') : '—'),
    },
    sender,
    at,
    state,
  ];
}

export function RemindersPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [toast, setToast] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['reminders'],
    queryFn: () => remindersApi.list(),
    refetchInterval: isAdmin ? false : REMINDER_POLL_MS,
  });

  // The same account list the recipient picker reads — only the Admin has it,
  // and only the Admin's table has a branch column.
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => adminUsersApi.list(),
    staleTime: 5 * 60_000,
    enabled: isAdmin,
  });
  const branchOf = (id: number) => users.data?.users.find((u) => u.id === id)?.branch?.address ?? null;

  const reminders = list.data?.reminders ?? [];
  const unread = reminders.filter((r) => !r.read).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title={unread > 0 && !isAdmin ? `Nhắc nhở (${unread})` : 'Nhắc nhở'}
        description={
          isAdmin
            ? 'Gửi nhắc nhở riêng cho một lễ tân và xem họ đã đọc chưa.'
            : 'Nhắc nhở Admin gửi riêng cho bạn.'
        }
      />

      {isAdmin ? <ComposeReminder onSent={() => setToast('Đã gửi nhắc nhở.')} /> : null}

      {reminders.length === 0 && !list.isLoading && !list.isError ? (
        <EmptyState
          icon={<Bell className="h-6 w-6" aria-hidden="true" />}
          title="Chưa có nhắc nhở"
          message={isAdmin ? 'Nhắc nhở bạn gửi sẽ hiện ở đây.' : 'Khi Admin gửi nhắc nhở, nó sẽ hiện ở đây.'}
        />
      ) : (
        <DataTable
          testId="reminder-list"
          title={isAdmin ? 'Nhắc nhở đã gửi' : 'Nhắc nhở của bạn'}
          badge={reminders.length}
          columns={reminderColumns(isAdmin, branchOf)}
          rows={reminders}
          rowKey={(r) => r.id}
          rowClassName={(r) => (r.read ? '' : 'bg-amber-50/60')}
          isLoading={list.isLoading}
          isError={list.isError}
          error={list.error}
          onRetry={() => void list.refetch()}
          emptyTitle="Chưa có nhắc nhở"
          emptyMessage=""
          renderDetail={(r) => <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{r.body}</p>}
        />
      )}

      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
