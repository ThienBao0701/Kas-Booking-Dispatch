/**
 * The install button both roles actually reach.
 *
 * THE REQUIREMENT THIS FILE PROTECTS: an Admin and a receptionist each have a
 * working "Tải ứng dụng" control on the screens they use, without a second
 * implementation and without a per-role variant.
 *
 * It lives in the shared top bar, so this asserts it through the REAL shell for
 * each role rather than by rendering the component alone — a component that
 * works in isolation and is mounted nowhere is exactly the failure this phase
 * was reported for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';

const EMPTY_NEW = {
  status: 200,
  body: { bookings: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } },
};

function mockShell(user: unknown) {
  installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/bookings/new?page=1&pageSize=20': () => EMPTY_NEW,
    'GET /api/bookings/new?pageSize=100': () => EMPTY_NEW,
    'GET /api/branches': () => ({ status: 200, body: { branches: [] } }),
  });
}

/**
 * A Chrome-like installable context. jsdom implements neither `serviceWorker`
 * nor `matchMedia`, so without this every case would collapse to "this browser
 * cannot install" and pass for the wrong reason.
 */
function installableBrowser(secure = true) {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register: vi.fn() },
    configurable: true,
  });
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

/** Dispatches the event the browser fires when installation becomes possible. */
function fireInstallPrompt() {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  };
  const prompt = vi.fn(async () => undefined);
  event.prompt = prompt;
  event.userChoice = Promise.resolve({ outcome: 'accepted' });
  window.dispatchEvent(event);
  return prompt;
}

beforeEach(() => installableBrowser());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the install button in the shared shell', () => {
  it.each([
    ['Admin', ADMIN_USER, '/app/dashboard'],
    ['Reception', RECEPTIONIST_USER, '/app/new'],
  ])('is on the %s screen', async (_role, user, route) => {
    mockShell(user);
    renderApp(route);
    // Wait for the shell before firing: the listener is mounted with the bar.
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    fireInstallPrompt();

    const button = await screen.findByTestId('pwa-install-button');
    expect(button).toHaveTextContent('Tải ứng dụng');
  });

  it.each([
    ['Admin', ADMIN_USER, '/app/dashboard'],
    ['Reception', RECEPTIONIST_USER, '/app/new'],
  ])('opens the browser install dialog for %s', async (_role, user, route) => {
    mockShell(user);
    renderApp(route);
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    const prompt = fireInstallPrompt();

    await userEvent.click(await screen.findByTestId('pwa-install-button'));
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('uses ONE implementation, not one per role', async () => {
    // Both roles reach the same component through the same bar. A second
    // button would mean two code paths to keep working.
    mockShell(ADMIN_USER);
    renderApp('/app/dashboard');
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    fireInstallPrompt();

    await screen.findByTestId('pwa-install-button');
    expect(screen.getAllByTestId('pwa-install-button')).toHaveLength(1);
  });

  it('is visible before the browser offers any prompt', async () => {
    // The reported bug: Chrome had already accepted the app, so it never fired
    // beforeinstallprompt again and the button was nowhere to be found.
    mockShell(ADMIN_USER);
    renderApp('/app/dashboard');
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(await screen.findByTestId('pwa-install-button')).toHaveTextContent('Tải ứng dụng');
  });

  it('is visible for Reception on an insecure origin too', async () => {
    installableBrowser(false);
    mockShell(RECEPTIONIST_USER);
    renderApp('/app/new');
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(await screen.findByTestId('pwa-install-button')).toBeInTheDocument();
  });

  it('explains itself instead of doing nothing when unavailable', async () => {
    installableBrowser(false);
    mockShell(RECEPTIONIST_USER);
    renderApp('/app/new');
    await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    await userEvent.click(await screen.findByTestId('pwa-install-button'));
    expect(screen.getByTestId('pwa-install-explanation')).toBeInTheDocument();
  });
});
