import { useRegisterSW } from 'virtual:pwa-register/react';
import { InstallButton } from './InstallButton';
import { MandatoryUpdate } from './MandatoryUpdate';

/** How often an open tab asks the server whether a new version was published. */
const UPDATE_CHECK_MS = 30 * 60_000;

/**
 * PWA install + update surface. Mounted once from main.tsx (outside the test
 * tree), so the virtual SW module is never pulled into unit tests.
 *
 * - "Cài ứng dụng" appears when the browser offers an install prompt; when it
 *   cannot, {@link InstallButton} explains why instead of rendering nothing.
 * - A NEW VERSION, once downloaded and waiting, is MANDATORY: the full-screen
 *   {@link MandatoryUpdate} covers the application until it is installed.
 *   An open tab also checks every half hour, so a tab left open for a shift
 *   does not keep running an old version unnoticed. A failed check (offline)
 *   reports nothing — only a version actually waiting does.
 *
 * The service worker precaches static assets only, so no booking data and no
 * session ever enters a cache — see the runtime-caching note in vite.config.ts.
 */
export function PwaManager() {
  const { needRefresh, updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      window.setInterval(() => {
        // Offline or the server busy: the next check tries again; nothing is shown.
        if (navigator.onLine) void registration.update().catch(() => undefined);
      }, UPDATE_CHECK_MS);
    },
  });
  const [needsUpdate] = needRefresh;

  if (needsUpdate) return <MandatoryUpdate needed apply={() => updateServiceWorker(true)} />;
  return <InstallButton className="fixed bottom-4 left-4 z-[70]" />;
}
