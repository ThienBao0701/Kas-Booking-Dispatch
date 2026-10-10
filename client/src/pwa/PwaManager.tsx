import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw, X } from 'lucide-react';
import { InstallButton } from './InstallButton';

/**
 * PWA install + update surface. Mounted once from main.tsx (outside the test
 * tree), so the virtual SW module is never pulled into unit tests.
 *
 * - "Cài ứng dụng" appears when the browser offers an install prompt; when it
 *   cannot, {@link InstallButton} explains why instead of rendering nothing.
 * - "Có phiên bản mới" appears when the service worker has an update ready.
 *
 * The service worker precaches static assets only, so no booking data and no
 * session ever enters a cache — see the runtime-caching note in vite.config.ts.
 */
export function PwaManager() {
  const { needRefresh, updateServiceWorker } = useRegisterSW();
  const [needsUpdate, setNeedsUpdate] = needRefresh;

  // The update prompt owns the corner while it is showing: a new build is
  // time-sensitive, installation is not.
  if (needsUpdate) {
    return (
      <div
        className="fixed bottom-4 left-4 z-[70] flex items-center gap-3 rounded-2xl border border-brand-200 bg-white px-4 py-3 shadow-lg"
        data-testid="pwa-update-prompt"
      >
        <RefreshCw className="h-5 w-5 text-brand-600" aria-hidden="true" />
        <div className="text-sm">
          <p className="font-semibold text-slate-800">Có phiên bản mới</p>
          <p className="text-slate-500">Tải lại để cập nhật Kas.</p>
        </div>
        <button
          type="button"
          onClick={() => void updateServiceWorker(true)}
          className="rounded-xl bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          Cập nhật
        </button>
        <button
          type="button"
          onClick={() => setNeedsUpdate(false)}
          aria-label="Bỏ qua"
          className="text-slate-400 hover:text-slate-600"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return <InstallButton className="fixed bottom-4 left-4 z-[70]" />;
}
