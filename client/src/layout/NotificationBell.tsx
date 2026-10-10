import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellRing, CheckCheck } from 'lucide-react';
import { notificationsApi, type NotificationItem } from '../api/notifications';
import { relativeTime } from '../lib/format';
import { useAuth } from '../auth/AuthProvider';
import { disablePush, enablePush, pushState, type PushState } from '../pwa/push';

/*
  THE BELL IS THE IN-APP FALLBACK of the device push: the same notices, read
  here when push is off, denied, unsupported or the phone was offline. It polls
  a cheap count; it no longer raises an OS notification of its own — the server
  pushes the real one, once, and a second one from here would be a duplicate.
*/
const POLL_MS = 20_000;

/** The roles whose assignments are pushed to their devices (version 1). */
const PUSH_ROLES = new Set(['TECHNICAL', 'HOUSEKEEPING']);

/** Where a press on a notice goes: its own in-app link, else its booking. */
function noticeTarget(n: NotificationItem): string | null {
  if (n.link && n.link.startsWith('/app')) return n.link;
  return n.bookingId ? `/app/booking/${n.bookingId}` : null;
}

/** "Bật thông báo" for this device — asked only when pressed. */
function PushControl() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    pushState()
      .then((s) => alive && setState(s))
      .catch(() => alive && setState('unsupported'));
    return () => {
      alive = false;
    };
  }, []);
  if (state === null || state === 'unsupported' || state === 'unconfigured') return null;
  const run = (job: () => Promise<PushState | void>, after?: PushState) => {
    setBusy(true);
    job()
      .then((s) => setState(s ?? after ?? 'off'))
      .catch(() => setState('off'))
      .finally(() => setBusy(false));
  };
  return (
    <div data-testid="push-control" className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-600">
      {state === 'on' ? (
        <p className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
            <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
            Đã bật thông báo trên thiết bị này
          </span>
          <button type="button" disabled={busy} onClick={() => run(disablePush, 'off')} className="font-medium text-slate-500 hover:text-slate-800">
            Tắt
          </button>
        </p>
      ) : state === 'off' ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => run(enablePush)}
          data-testid="push-enable"
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
        >
          <BellRing className="h-4 w-4" aria-hidden="true" />
          Bật thông báo
        </button>
      ) : state === 'denied' ? (
        <p>Thông báo đang bị chặn. Hãy cho phép thông báo cho KAS trong cài đặt của trình duyệt hoặc điện thoại.</p>
      ) : (
        <p>Trên iPhone/iPad: nhấn Chia sẻ → “Thêm vào MH chính”, rồi mở KAS từ biểu tượng đó để bật thông báo.</p>
      )}
    </div>
  );
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Poll the cheap unread count on a timer (no SSE in this phase).
  const unread = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => notificationsApi.unreadCount(),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });

  const list = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => notificationsApi.list(1, 15),
    enabled: open,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  const markOne = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: invalidate,
  });
  const markAll = useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: invalidate,
  });

  const count = unread.data?.count ?? 0;

  const onItem = (n: NotificationItem) => {
    if (!n.read) markOne.mutate(n.id);
    setOpen(false);
    const target = noticeTarget(n);
    if (target) navigate(target);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Thông báo${count > 0 ? ` (${count} chưa đọc)` : ''}`}
        className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {count > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-[1.15rem] items-center justify-center rounded-full bg-red-600 px-1 text-[0.65rem] font-bold leading-none text-white">
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 z-40 mt-2 w-80 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <p className="text-sm font-semibold text-slate-800">Thông báo</p>
              <button
                type="button"
                onClick={() => markAll.mutate()}
                disabled={count === 0 || markAll.isPending}
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 disabled:opacity-40"
              >
                <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Đọc tất cả
              </button>
            </div>
            {user && PUSH_ROLES.has(user.role) ? <PushControl /> : null}
            <div className="max-h-96 overflow-y-auto">
              {list.isLoading ? (
                <p className="px-4 py-6 text-center text-sm text-slate-400">Đang tải…</p>
              ) : list.isError ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-sm text-slate-500">Không thể tải thông báo.</p>
                  <button
                    type="button"
                    onClick={() => void list.refetch()}
                    className="mt-2 text-xs font-medium text-brand-600 hover:text-brand-700"
                  >
                    Thử lại
                  </button>
                </div>
              ) : (list.data?.notifications.length ?? 0) === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-400">Chưa có thông báo.</p>
              ) : (
                list.data!.notifications.map((n) => {
                  const isLastMinute = n.title.toUpperCase().includes('LAST MINUTE');
                  return (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => onItem(n)}
                      className={`block w-full border-b border-slate-100 px-4 py-3 text-left last:border-b-0 hover:bg-slate-50 ${
                        isLastMinute ? 'border-l-4 border-l-red-500' : ''
                      } ${n.read ? '' : 'bg-brand-50/50'}`}
                    >
                      <p className={`flex items-center gap-2 text-sm font-semibold ${isLastMinute ? 'text-red-700' : 'text-slate-800'}`}>
                        {n.read ? null : (
                          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${isLastMinute ? 'bg-red-500' : 'bg-brand-600'}`} />
                        )}
                        {n.title}
                      </p>
                      <p className="mt-0.5 text-sm text-slate-600">{n.body}</p>
                      <p className="mt-1 text-xs text-slate-400">{relativeTime(n.createdAt)}</p>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
