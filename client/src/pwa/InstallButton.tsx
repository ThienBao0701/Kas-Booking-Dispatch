import { useState } from 'react';
import { Download, Info } from 'lucide-react';
import { installBlockMessage, installExplanation } from './installability';
import { useInstallPrompt } from './useInstallPrompt';

/**
 * The reusable install affordance.
 *
 * Three states, and the middle one is the reason this component exists:
 *
 *   installable      — a button that opens the browser's install dialog;
 *   blocked, and the
 *   operator can act — a short explanation of why installation is impossible;
 *   nothing to say   — renders null.
 *
 * An operator on `http://<lan-ip>:3001` gets the explanation rather than an
 * empty corner of the screen. Silence there costs a support call and an
 * afternoon of debugging the manifest, which is not where the problem is.
 */
/**
 * `card` — the floating affordance in the screen corner (PwaManager). Appears
 *   only when there is something to say.
 * `inline` — the top bar, on every Admin and Reception screen. ALWAYS visible:
 *   it is enabled when the browser offers a prompt, and otherwise stays put,
 *   greyed, and explains itself when pressed.
 */
export type InstallButtonVariant = 'card' | 'inline';

export function InstallButton({
  className = '',
  variant = 'card',
}: {
  className?: string;
  variant?: InstallButtonVariant;
}) {
  const { canInstall, reason, promptInstall } = useInstallPrompt();
  const [busy, setBusy] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const message = installBlockMessage(reason);

  // The top bar always shows the control. Chrome only fires
  // `beforeinstallprompt` when IT decides the app qualifies — and never again
  // once the app is installed — so hiding the button on that signal makes it
  // vanish exactly when someone goes looking for it. It stays, and says why.
  if (variant === 'inline') {
    const enabled = canInstall && !busy;
    return (
      <div className="relative">
        <button
          type="button"
          // aria-disabled, NOT disabled: a disabled button fires no click, and
          // this one has to be able to explain itself when pressed.
          aria-disabled={!canInstall}
          onClick={() => {
            if (!canInstall) {
              setShowWhy((open) => !open);
              return;
            }
            if (busy) return;
            setBusy(true);
            void promptInstall().finally(() => setBusy(false));
          }}
          data-testid="pwa-install-button"
          className={`inline-flex min-h-[2.75rem] items-center gap-2 rounded-xl border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
            enabled
              ? 'border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100'
              : 'border-slate-200 bg-white text-slate-400 hover:bg-slate-50'
          } ${className}`}
        >
          <Download
            className={`h-4 w-4 ${enabled ? 'text-brand-600' : 'text-slate-400'}`}
            aria-hidden="true"
          />
          Tải ứng dụng
        </button>

        {showWhy ? (
          <div
            role="status"
            data-testid="pwa-install-explanation"
            className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-600 shadow-lg"
          >
            <div className="flex gap-2">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
              <p>{installExplanation(reason)}</p>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (canInstall) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          // Guard inside the handler: a double click must not open two dialogs.
          if (busy) return;
          setBusy(true);
          void promptInstall().finally(() => setBusy(false));
        }}
        data-testid="pwa-install-button"
        className={`inline-flex min-h-[2.75rem] items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 shadow-lg hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 disabled:opacity-60 ${className}`}
      >
        <Download className="h-4 w-4 text-brand-600" aria-hidden="true" />
        Tải ứng dụng
      </button>
    );
  }

  if (message) {
    return (
      <div
        role="note"
        data-testid="pwa-install-blocked"
        className={`max-w-sm rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 shadow-lg ${className}`}
      >
        <div className="flex gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{message}</p>
        </div>
      </div>
    );
  }

  return null;
}
