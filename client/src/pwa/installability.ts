/**
 * Why this browser can or cannot install Kas.
 *
 * WHY THIS EXISTS. Chrome and Edge only treat `https://`, `localhost` and
 * `127.0.0.1` as secure contexts. Kas is documented to be reached over the
 * server's LAN address — `http://192.168.x.x:3001` — which is NOT one of them.
 * On such an origin `navigator.serviceWorker` is undefined, the worker never
 * registers, and the browser therefore never fires `beforeinstallprompt`.
 *
 * The visible symptom is that the install affordance simply is not there: no
 * button in Kas and no install icon in the address bar. Nothing in the manifest
 * or the icons can change that — it is browser policy, not configuration.
 *
 * So rather than render nothing and let an operator conclude the feature is
 * broken, the app states the reason. Pure functions, no DOM, no React, so the
 * rule can be tested directly.
 */

export type InstallBlockReason =
  /** Already running as an installed app — nothing left to install. */
  | 'ALREADY_INSTALLED'
  /** The origin is not a secure context, so no service worker, so no install. */
  | 'INSECURE_ORIGIN'
  /** The browser has no service-worker support at all. */
  | 'NO_SERVICE_WORKER'
  /** Installable in principle; the browser has not offered the prompt (yet). */
  | 'PROMPT_NOT_OFFERED';

/** The window facts the rule depends on. Injected so tests need no globals. */
export interface InstallEnvironment {
  isSecureContext: boolean;
  hasServiceWorker: boolean;
  /** True when the page is already running in an installed window. */
  isStandalone: boolean;
  /** True once `beforeinstallprompt` has fired and been captured. */
  hasPrompt: boolean;
}

/** Reads the environment from the real browser. */
export function readInstallEnvironment(hasPrompt: boolean): InstallEnvironment {
  const standalone =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches;

  return {
    isSecureContext: typeof window !== 'undefined' && window.isSecureContext === true,
    hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    isStandalone: standalone,
    hasPrompt,
  };
}

/**
 * `null` when the install button should be shown; otherwise why it cannot be.
 *
 * Order matters. "Already installed" wins over everything — an installed window
 * on an insecure origin must not nag about HTTPS. Then the secure-context rule,
 * because it is the cause of the missing service worker rather than a separate
 * problem, and reporting the symptom would send someone debugging the wrong end.
 */
export function installBlockReason(env: InstallEnvironment): InstallBlockReason | null {
  if (env.isStandalone) return 'ALREADY_INSTALLED';
  if (!env.isSecureContext) return 'INSECURE_ORIGIN';
  if (!env.hasServiceWorker) return 'NO_SERVICE_WORKER';
  if (!env.hasPrompt) return 'PROMPT_NOT_OFFERED';
  return null;
}

/**
 * What to tell the operator, in their own language.
 *
 * `null` for the two reasons that are not problems: an installed app, and a
 * browser that simply has not offered the prompt yet (which is the normal state
 * for a few seconds after load, and permanently in Firefox).
 */
/**
 * An explanation for EVERY state, including the two that are not problems.
 *
 * The top-bar button is always visible, so pressing it must always say
 * something. `installBlockMessage` deliberately returns null for an installed
 * app and for a prompt the browser has not offered yet — correct for a passive
 * notice, useless for a control someone just pressed.
 */
export function installExplanation(reason: InstallBlockReason | null): string {
  switch (reason) {
    case null:
      return 'Có thể cài ứng dụng. Bấm để mở hộp thoại cài đặt của trình duyệt.';
    case 'ALREADY_INSTALLED':
      return 'Ứng dụng đã được cài trên máy này. Hãy mở Kas từ Desktop hoặc Start Menu.';
    case 'PROMPT_NOT_OFFERED':
      return (
        'Trình duyệt chưa cho phép cài ngay lúc này. Nếu Kas đã được cài, hãy mở từ Desktop. ' +
        'Nếu chưa, hãy dùng biểu tượng cài trên thanh địa chỉ, hoặc tải lại trang rồi thử lại.'
      );
    default:
      return installBlockMessage(reason) ?? 'Không cài được ứng dụng trên trình duyệt này.';
  }
}

export function installBlockMessage(reason: InstallBlockReason | null): string | null {
  switch (reason) {
    case 'INSECURE_ORIGIN':
      return (
        'Không cài được ứng dụng vì trang đang mở qua kết nối không bảo mật (http). ' +
        'Chrome và Edge chỉ cho cài khi mở bằng https hoặc localhost. ' +
        'Hãy mở Kas qua địa chỉ https của máy chủ.'
      );
    case 'NO_SERVICE_WORKER':
      return 'Trình duyệt này không hỗ trợ cài ứng dụng. Hãy dùng Chrome hoặc Edge.';
    default:
      return null;
  }
}
