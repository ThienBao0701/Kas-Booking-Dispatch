/**
 * The page shown when the hotel server is not answering.
 *
 * THE PROPERTY THIS FILE PROTECTS: a receptionist standing in front of a guest
 * never sees a stack trace, a URL, a status code or the words "fetch failed".
 * Those read as "the application is broken" rather than "the server is off",
 * and they turn a five-minute fix into a phone call about software.
 *
 * The second property is that the page tells them it will clear ITSELF. Without
 * that sentence, the honest response to a server outage is to sit pressing
 * Retry, which is exactly the wrong thing to be doing during a queue.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServerUnavailable } from './ServerUnavailable';
import { probeServer } from '../api/useServerReachable';

const mount = (over: Partial<React.ComponentProps<typeof ServerUnavailable>> = {}) =>
  render(<ServerUnavailable onRetry={vi.fn()} retrying={false} {...over} />);

/* ================================================================== */
/* What it says                                                        */
/* ================================================================== */
describe('the message', () => {
  it('names the server, not the application', () => {
    mount();
    expect(screen.getByText('Không kết nối được máy chủ')).toBeInTheDocument();
    expect(screen.getByText(/không liên lạc được với máy chủ khách sạn/i)).toBeInTheDocument();
  });

  it('lists what to check, in the order a non-technical person can check it', () => {
    mount();
    expect(screen.getByText(/Máy chủ Kas có đang bật không/)).toBeInTheDocument();
    expect(screen.getByText(/Máy này có đang nối mạng không/)).toBeInTheDocument();
    expect(screen.getByText(/Wi-Fi \/ dây mạng/)).toBeInTheDocument();
  });

  it('promises it will clear by itself', () => {
    // Otherwise the reasonable response is to sit and press Retry.
    mount();
    expect(screen.getByText(/tự đóng ngay khi máy chủ hoạt động trở lại/)).toBeInTheDocument();
  });

  it('says what to tell the administrator', () => {
    // People freeze on what to report, not on whether to report.
    mount();
    expect(screen.getByText(/Máy chủ Kas không phản hồi/)).toBeInTheDocument();
    expect(screen.getByText(/--diagnose/)).toBeInTheDocument();
  });

  it('shows no stack trace, URL, status code or exception wording', () => {
    mount();
    const text = document.body.textContent ?? '';
    for (const forbidden of [
      'fetch',
      'Failed to',
      'TypeError',
      'NetworkError',
      'ERR_',
      'http://',
      'https://',
      '500',
      '502',
      '503',
      'undefined',
      'at Object.',
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});

/* ================================================================== */
/* Retry                                                               */
/* ================================================================== */
describe('retry', () => {
  it('asks again when pressed', async () => {
    const onRetry = vi.fn();
    mount({ onRetry });
    await userEvent.click(screen.getByTestId('server-unavailable-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says it is working and cannot be pressed twice', async () => {
    const onRetry = vi.fn();
    mount({ onRetry, retrying: true });
    const button = screen.getByTestId('server-unavailable-retry');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Đang thử lại');
    await userEvent.click(button).catch(() => undefined);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/* Accessibility                                                       */
/* ================================================================== */
describe('the dialog', () => {
  it('announces itself, because it takes over the screen', () => {
    mount();
    const dialog = screen.getByTestId('server-unavailable');
    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });
});

/* ================================================================== */
/* The probe                                                           */
/* ================================================================== */
describe('probing the server', () => {
  it('treats any answer as the server being there', async () => {
    // A 503 is Kas reporting its own database is down. That is a different
    // fault with its own reporting, and showing "cannot reach the server"
    // would send someone to check the network instead of the database.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    expect(await probeServer(100)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('treats a healthy answer as reachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect(await probeServer(100)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('treats a refused connection as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect(await probeServer(100)).toBe(false);
    vi.unstubAllGlobals();
  });

  /** A fetch mock that records its arguments, so the call can be inspected. */
  const recordingFetch = () =>
    vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{}', { status: 200 }),
    );

  it('asks the origin it was served from, never a configured address', async () => {
    // THE RULE FOR AN INSTALLED CLIENT: a relative path means the app can only
    // ever talk back to the server it was installed from. There is no address
    // to get wrong and no way to point a branch at the wrong machine.
    const fetchMock = recordingFetch();
    vi.stubGlobal('fetch', fetchMock);
    await probeServer(100);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/health');
    vi.unstubAllGlobals();
  });

  it('never serves a cached answer', async () => {
    // A service worker replaying yesterday's 200 would report a healthy server
    // that has been off since this morning.
    const fetchMock = recordingFetch();
    vi.stubGlobal('fetch', fetchMock);
    await probeServer(100);
    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe('no-store');
    vi.unstubAllGlobals();
  });
});
