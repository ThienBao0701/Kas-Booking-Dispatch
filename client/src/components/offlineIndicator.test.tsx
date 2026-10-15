/**
 * The connection banner.
 *
 * The behaviour that matters operationally is what does NOT happen: going
 * offline must not clear the screen. A receptionist mid-check-in needs the
 * booking in front of them more than they need an empty page, and the service
 * worker caches no booking data, so what is on screen is all there is.
 *
 * Retry exists because `navigator.onLine` describes the network INTERFACE, not
 * reachability. A machine on Wi-Fi with a dead uplink reports "online", so the
 * operator needs a way to ask again that does not wait on a browser event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OfflineIndicator } from './OfflineIndicator';

let client: QueryClient;

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
}

function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OfflineIndicator />
    </QueryClientProvider>,
  );
}

beforeEach(() => setOnline(true));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('while connected', () => {
  it('shows nothing at all', () => {
    mount();
    expect(screen.queryByTestId('offline-banner')).toBeNull();
    expect(screen.queryByTestId('online-banner')).toBeNull();
  });
});

describe('when the connection drops', () => {
  it('warns that the data on screen may be stale', () => {
    setOnline(false);
    mount();
    const banner = screen.getByTestId('offline-banner');
    expect(banner).toHaveTextContent('Mất kết nối mạng');
    // An alert, so a screen reader announces it without being asked.
    expect(banner).toHaveAttribute('role', 'alert');
  });

  it('appears when the browser fires the offline event', async () => {
    mount();
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(await screen.findByTestId('offline-banner')).toBeInTheDocument();
  });

  it('offers a retry that refetches rather than reloading the page', async () => {
    setOnline(false);
    mount();
    const refetch = vi.spyOn(client, 'refetchQueries').mockResolvedValue(undefined);

    await userEvent.click(screen.getByTestId('offline-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
    // A reload would throw away everything on screen, which is the one thing
    // this banner exists to preserve.
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
  });
});

describe('when the connection returns', () => {
  it('says so and refetches', async () => {
    setOnline(false);
    mount();
    const refetch = vi.spyOn(client, 'refetchQueries').mockResolvedValue(undefined);

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });

    expect(await screen.findByTestId('online-banner')).toHaveTextContent('Đã kết nối lại');
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('clears the confirmation after a few seconds', async () => {
    vi.useFakeTimers();
    setOnline(false);
    mount();

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByTestId('online-banner')).toBeInTheDocument();

    // A permanent green bar would become furniture and stop meaning anything.
    // Asserted directly rather than through waitFor, which drives its own
    // timers and would deadlock against the fake ones.
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByTestId('online-banner')).toBeNull();
  });
});
