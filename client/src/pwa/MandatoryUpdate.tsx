/**
 * "CẦN CẬP NHẬT ĐỂ TIẾP TỤC SỬ DỤNG KAS" — the full-screen, mandatory update.
 *
 * Shown only when the service worker reports a NEW VERSION ALREADY DOWNLOADED
 * and waiting (vite-plugin-pwa's `needRefresh`): an actual, verified update.
 * A failed background check or being offline never sets it, so neither ever
 * blocks the application.
 *
 * While it shows, the application underneath is `inert` — no click, no Tab, no
 * sidebar, no shortcut reaches it — and there is no way to dismiss it. The one
 * action, "Cập nhật ngay", runs the existing update lifecycle: the waiting worker
 * is told to take over and the page reloads once it controls the page
 * (`updateServiceWorker(true)`). Success is never claimed before that reload:
 * if it has not happened in time, the screen says the update failed and offers
 * "Thử lại". Nothing here reloads on its own, so it cannot loop, and nothing
 * clears the browser's storage or the session.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Download, Loader2, RefreshCw } from 'lucide-react';

export type UpdatePhase = 'ready' | 'applying' | 'failed';

/** How long the new version has to take over before the attempt is called failed. */
export const UPDATE_TIMEOUT_MS = 20_000;

export function MandatoryUpdate({
  needed,
  apply,
  timeoutMs = UPDATE_TIMEOUT_MS,
}: {
  /** A new version is downloaded and waiting. */
  needed: boolean;
  /** Activate it; the page reloads when it takes over (the existing lifecycle). */
  apply: () => Promise<void>;
  timeoutMs?: number;
}) {
  const [phase, setPhase] = useState<UpdatePhase>('ready');
  const [attempts, setAttempts] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);

  // The application underneath is out of reach while the update is required.
  useEffect(() => {
    if (!needed) return;
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    root?.setAttribute('aria-hidden', 'true');
    return () => {
      root?.removeAttribute('inert');
      root?.removeAttribute('aria-hidden');
    };
  }, [needed]);

  useEffect(() => {
    if (needed && phase !== 'applying') button.current?.focus();
  }, [needed, phase]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  if (!needed) return null;

  const update = async () => {
    setPhase('applying');
    setAttempts((n) => n + 1);
    if (timer.current !== null) window.clearTimeout(timer.current);
    try {
      await apply();
    } catch {
      setPhase('failed');
      return;
    }
    // The reload comes when the new version takes over; until then this is not a success.
    timer.current = window.setTimeout(() => setPhase('failed'), timeoutMs);
  };

  return createPortal(
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="kas-update-title"
      aria-describedby="kas-update-text"
      data-testid="mandatory-update"
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto bg-slate-100 px-4 py-8"
    >
      <div className="w-full max-w-md rounded-2xl border border-line-subtle bg-white p-6 text-center shadow-lg">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-700" aria-hidden="true">
          <Download className="h-7 w-7" />
        </span>
        <h1 id="kas-update-title" className="mt-4 text-xl font-semibold text-slate-900">
          Cần cập nhật để tiếp tục sử dụng KAS
        </h1>
        <p id="kas-update-text" className="mt-2 text-sm text-slate-600">
          Đã có phiên bản mới của KAS. Cần cài đặt bản mới trước khi tiếp tục làm việc — phiên đăng nhập của bạn được giữ nguyên. Nội dung đang
          nhập dở mà chưa lưu sẽ không còn sau khi ứng dụng tải lại.
        </p>

        <div className="mt-5" aria-live="polite" data-testid="mandatory-update-status">
          {phase === 'applying' ? (
            <div className="space-y-2">
              <p className="inline-flex items-center gap-2 text-sm font-medium text-brand-800">
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Đang cài đặt bản mới… ứng dụng sẽ tự tải lại.
              </p>
              <span className="block h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                <span className="block h-full w-1/3 animate-pulse rounded-full bg-brand-600 motion-reduce:animate-none" />
              </span>
            </div>
          ) : phase === 'failed' ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-left text-sm text-red-800" role="alert" data-testid="mandatory-update-error">
              <p className="flex items-start gap-2 font-semibold">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                Chưa cài được bản mới.
              </p>
              <p className="mt-1">Kiểm tra kết nối mạng rồi bấm “Thử lại”.</p>
              {attempts >= 2 ? <p className="mt-1">Nếu vẫn không được: đóng mọi cửa sổ / tab KAS đang mở rồi mở lại KAS.</p> : null}
            </div>
          ) : null}
        </div>

        <button
          ref={button}
          type="button"
          onClick={() => void update()}
          disabled={phase === 'applying'}
          data-testid="mandatory-update-button"
          className="mt-5 inline-flex min-h-[3rem] w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 text-base font-semibold text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-70"
        >
          {phase === 'applying' ? (
            <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-5 w-5" aria-hidden="true" />
          )}
          {phase === 'failed' ? 'Thử lại' : 'Cập nhật ngay'}
        </button>
      </div>
    </div>,
    document.body,
  );
}
