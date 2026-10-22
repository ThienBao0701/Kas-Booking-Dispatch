/**
 * The install affordance, end to end in the DOM.
 *
 * `beforeinstallprompt` is a non-standard event no test browser fires, so it is
 * dispatched by hand here with a stub `prompt()` / `userChoice`. That is the
 * real contract: the page must call preventDefault, hold the event, and spend
 * it exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InstallButton } from './InstallButton';

/** Dispatches a `beforeinstallprompt` carrying a stubbed user choice. */
function fireInstallPrompt(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  const prompt = vi.fn(async () => undefined);
  event.prompt = prompt;
  event.userChoice = Promise.resolve({ outcome });
  window.dispatchEvent(event);
  return { event, prompt };
}

/**
 * Shapes the environment the rule reads.
 *
 * jsdom implements neither `serviceWorker` nor `matchMedia`, so a Chrome-like
 * context has to be stated explicitly — otherwise every case would collapse to
 * "this browser cannot install" and the tests below would pass for the wrong
 * reason.
 */
function setContext({ secure = true, serviceWorker = true, standalone = false } = {}) {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });

  if (serviceWorker) {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { register: vi.fn() },
      configurable: true,
    });
  } else if ('serviceWorker' in navigator) {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  }

  window.matchMedia = ((query: string) =>
    ({
      matches: standalone && query.includes('standalone'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

beforeEach(() => setContext());
afterEach(() => {
  vi.restoreAllMocks();
});

/* ================================================================== */
/* The blocked case — the one production actually hits                 */
/* ================================================================== */
describe('on an insecure origin', () => {
  it('explains why instead of rendering nothing', () => {
    setContext({ secure: false });
    render(<InstallButton />);

    const note = screen.getByTestId('pwa-install-blocked');
    expect(note).toHaveTextContent('https');
    expect(screen.queryByTestId('pwa-install-button')).toBeNull();
  });

  it('does not nag once the app is already installed', () => {
    setContext({ secure: false, standalone: true });
    render(<InstallButton />);
    expect(screen.queryByTestId('pwa-install-blocked')).toBeNull();
    expect(screen.queryByTestId('pwa-install-button')).toBeNull();
  });
});

/* ================================================================== */
/* The installable case                                                */
/* ================================================================== */
describe('on a secure origin', () => {
  it('renders nothing until the browser offers a prompt', () => {
    render(<InstallButton />);
    expect(screen.queryByTestId('pwa-install-button')).toBeNull();
    // "Not offered yet" is normal, so it must not be reported as a fault.
    expect(screen.queryByTestId('pwa-install-blocked')).toBeNull();
  });

  it('shows the button once beforeinstallprompt fires', async () => {
    render(<InstallButton />);
    fireInstallPrompt();
    expect(await screen.findByTestId('pwa-install-button')).toBeInTheDocument();
  });

  it('suppresses the browser mini-infobar so Kas can place the button', () => {
    render(<InstallButton />);
    const { event } = fireInstallPrompt();
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens the browser dialog when clicked', async () => {
    render(<InstallButton />);
    const { prompt } = fireInstallPrompt();
    await userEvent.click(await screen.findByTestId('pwa-install-button'));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  });

  it('spends the event after use — a second prompt is impossible', async () => {
    render(<InstallButton />);
    fireInstallPrompt();
    await userEvent.click(await screen.findByTestId('pwa-install-button'));
    // The browser refuses a second prompt() on the same event, so the button
    // must go rather than sit there doing nothing.
    await waitFor(() => expect(screen.queryByTestId('pwa-install-button')).toBeNull());
  });

  it('also clears the button when the user declines', async () => {
    render(<InstallButton />);
    fireInstallPrompt('dismissed');
    await userEvent.click(await screen.findByTestId('pwa-install-button'));
    await waitFor(() => expect(screen.queryByTestId('pwa-install-button')).toBeNull());
  });

  it('hides the button once the app reports itself installed', async () => {
    render(<InstallButton />);
    fireInstallPrompt();
    expect(await screen.findByTestId('pwa-install-button')).toBeInTheDocument();

    window.dispatchEvent(new Event('appinstalled'));
    await waitFor(() => expect(screen.queryByTestId('pwa-install-button')).toBeNull());
    // And it must not then complain about anything either.
    expect(screen.queryByTestId('pwa-install-blocked')).toBeNull();
  });
});

/* ================================================================== */
/* 6.4.2 — the top-bar button is ALWAYS visible                        */
/* ================================================================== */
describe('the inline variant in the top bar', () => {
  it('is visible before the browser has offered anything', () => {
    // Chrome fires beforeinstallprompt when IT decides, and never again once
    // the app is installed. Hiding on that signal makes the button vanish
    // exactly when somebody goes looking for it.
    render(<InstallButton variant="inline" />);
    expect(screen.getByTestId('pwa-install-button')).toHaveTextContent('Tải ứng dụng');
  });

  it('is visible on an insecure origin, where installing is impossible', () => {
    setContext({ secure: false });
    render(<InstallButton variant="inline" />);
    expect(screen.getByTestId('pwa-install-button')).toBeInTheDocument();
  });

  it('is visible when the app is already installed', () => {
    setContext({ standalone: true });
    render(<InstallButton variant="inline" />);
    expect(screen.getByTestId('pwa-install-button')).toBeInTheDocument();
  });

  it('marks itself unavailable without using disabled', () => {
    // A disabled button fires no click, and this one must explain itself.
    render(<InstallButton variant="inline" />);
    const button = screen.getByTestId('pwa-install-button');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
  });

  it('explains itself when pressed while unavailable', async () => {
    setContext({ secure: false });
    render(<InstallButton variant="inline" />);
    await userEvent.click(screen.getByTestId('pwa-install-button'));
    expect(screen.getByTestId('pwa-install-explanation')).toHaveTextContent(/https|localhost/);
  });

  it('explains an already-installed app rather than staying silent', async () => {
    setContext({ standalone: true });
    render(<InstallButton variant="inline" />);
    await userEvent.click(screen.getByTestId('pwa-install-button'));
    expect(screen.getByTestId('pwa-install-explanation')).toHaveTextContent(/Desktop|Start Menu/);
  });

  it('closes the explanation when pressed again', async () => {
    render(<InstallButton variant="inline" />);
    const button = screen.getByTestId('pwa-install-button');
    await userEvent.click(button);
    expect(screen.getByTestId('pwa-install-explanation')).toBeInTheDocument();
    await userEvent.click(button);
    expect(screen.queryByTestId('pwa-install-explanation')).toBeNull();
  });

  it('becomes enabled and opens the dialog once a prompt arrives', async () => {
    render(<InstallButton variant="inline" />);
    const { prompt } = fireInstallPrompt();
    const button = await screen.findByTestId('pwa-install-button');
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'false'));
    await userEvent.click(button);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('pwa-install-explanation')).toBeNull();
  });

  it('still explains itself in the floating variant', () => {
    setContext({ secure: false });
    render(<InstallButton />);
    expect(screen.getByTestId('pwa-install-blocked')).toBeInTheDocument();
  });
});
