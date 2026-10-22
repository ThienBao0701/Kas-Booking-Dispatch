import { useCallback, useEffect, useState } from 'react';
import {
  installBlockReason,
  readInstallEnvironment,
  type InstallBlockReason,
} from './installability';

/** The non-standard event Chrome and Edge fire when a site is installable. */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

/**
 * The install prompt, as state.
 *
 * The browser fires `beforeinstallprompt` once and expects the page to hold the
 * event until the user asks. `preventDefault()` suppresses the browser's own
 * mini-infobar so Kas can offer installation where it makes sense instead.
 *
 * The captured event is single-use: once `prompt()` has been called the browser
 * will not accept it again, so it is dropped either way. If the user dismisses,
 * the browser re-fires `beforeinstallprompt` on a later visit when it decides
 * the site is worth offering again — which is why a dismissal is not recorded
 * as a permanent refusal here.
 */
export function useInstallPrompt() {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      // The event is spent the moment the app is installed; keeping it would
      // leave a button that can no longer do anything.
      setEvent(null);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<InstallOutcome> => {
    if (!event) return 'unavailable';
    await event.prompt();
    const { outcome } = await event.userChoice;
    // Spent regardless of the answer — the browser refuses a second prompt().
    setEvent(null);
    return outcome;
  }, [event]);

  const environment = readInstallEnvironment(event !== null);
  const reason: InstallBlockReason | null = installed
    ? 'ALREADY_INSTALLED'
    : installBlockReason(environment);

  return {
    /** True only when the browser has offered a prompt we still hold. */
    canInstall: reason === null,
    reason,
    installed,
    promptInstall,
  };
}
