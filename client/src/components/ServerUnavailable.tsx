/**
 * The page a receptionist sees when the hotel server is not answering.
 *
 * WHAT IT REPLACES: a fetch rejection surfacing as "Failed to fetch", or a
 * blank screen, or a spinner that never stops. None of those tell somebody
 * standing in front of a guest what to do, and all of them read as "the
 * application is broken" rather than "the server is off".
 *
 * So this states the one fact that matters — Kas cannot reach the server — and
 * then lists what to check, in the order a non-technical person can check it.
 * It never shows a stack trace, a URL, a status code or an exception message:
 * those belong in the server's own logs, and in front of a guest they are
 * noise that makes a solvable problem look catastrophic.
 *
 * It recovers BY ITSELF. The probe keeps running underneath, so when somebody
 * turns the server back on the page disappears without anyone pressing
 * anything — Retry exists for the operator who does not want to wait, not
 * because waiting fails.
 */
import { RefreshCw, ServerCrash, Wifi } from 'lucide-react';

export interface ServerUnavailableProps {
  /** Runs an immediate probe. The automatic one continues regardless. */
  onRetry: () => void;
  /** True while a probe is in flight, so the button can say so. */
  retrying: boolean;
}

export function ServerUnavailable({ onRetry, retrying }: ServerUnavailableProps) {
  return (
    <div
      // Covers the application: continuing to show stale data behind a dialog
      // invites someone to act on figures the server can no longer confirm.
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-50 px-4"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="server-unavailable-title"
      data-testid="server-unavailable"
    >
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-50">
            <ServerCrash className="h-6 w-6 text-amber-600" aria-hidden="true" />
          </span>
          <div>
            <h1 id="server-unavailable-title" className="text-lg font-semibold text-slate-900">
              Không kết nối được máy chủ
            </h1>
            <p className="text-sm text-slate-500">Kas không liên lạc được với máy chủ khách sạn.</p>
          </div>
        </div>

        <div className="mt-5 rounded-xl bg-slate-50 px-4 py-3">
          <p className="text-sm font-medium text-slate-700">Hãy kiểm tra:</p>
          <ul className="mt-2 space-y-1.5 text-sm text-slate-600">
            <li className="flex gap-2">
              <span aria-hidden="true">✓</span>
              Máy chủ Kas có đang bật không
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true">✓</span>
              Máy này có đang nối mạng không
            </li>
            <li className="flex gap-2">
              <Wifi className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
              Wi-Fi / dây mạng của khách sạn
            </li>
          </ul>
        </div>

        {/*
          Said explicitly, because the alternative is a receptionist sitting and
          pressing Retry every few seconds during a queue.
        */}
        <p className="mt-4 text-sm text-slate-500">
          Trang này sẽ tự đóng ngay khi máy chủ hoạt động trở lại.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            data-testid="server-unavailable-retry"
            className="inline-flex min-h-[2.75rem] items-center gap-2 rounded-xl bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:opacity-60"
          >
            <RefreshCw
              className={`h-4 w-4 ${retrying ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            {retrying ? 'Đang thử lại...' : 'Thử lại'}
          </button>

          {/*
            Not a mailto or a phone number: this is deployed to eight branches
            whose administrator differs, and a wrong contact is worse than
            none. It tells them WHAT to say, which is the part people freeze on.
          */}
          <details className="min-h-[2.75rem] flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm">
            <summary className="cursor-pointer font-medium text-slate-700">
              Báo quản trị viên
            </summary>
            <p className="mt-2 text-slate-600">
              Nhắn cho quản trị viên khách sạn: <strong>&ldquo;Máy chủ Kas không phản hồi&rdquo;</strong>,
              kèm giờ bắt đầu gặp lỗi. Trên máy chủ, chạy <code className="rounded bg-slate-100 px-1">Kas.cmd --diagnose</code>.
            </p>
          </details>
        </div>
      </div>
    </div>
  );
}
