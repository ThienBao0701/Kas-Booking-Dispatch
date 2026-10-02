/**
 * The intake source tabs.
 *
 * Three platforms have a real extraction parser — Booking.com, Agoda and
 * CTrip — and only those may be offered. Tripadvisor and Traveloka are valid
 * platform identities an Admin can configure, but offering them here would
 * promise an intake the system cannot perform.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = {
  id: 1,
  code: 'TRUONG_DINH_05',
  hotelName: 'Saigon Hotel & Ben Thanh',
  address: '05 Trương Định',
};

function mount(onRequest?: (path: string, init: RequestInit) => void) {
  const fetchMock = installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH] } }),
    'POST /api/bookings/extract': (init) => {
      onRequest?.('/api/bookings/extract', init);
      // Deliberately fail: this suite is about the tabs and the request, not
      // the review screen that a success would navigate to.
      return { status: 422, body: { error: { code: 'VALIDATION_ERROR', message: 'Nội dung không hợp lệ.' } } };
    },
    'POST /api/admin/ota/review': (init) => {
      onRequest?.('/api/admin/ota/review', init);
      // Likewise: the panel's own rendering is covered by its own suite.
      return { status: 422, body: { error: { code: 'VALIDATION_ERROR', message: 'Nội dung không hợp lệ.' } } };
    },
  });
  renderApp('/app/dispatch');
  return fetchMock;
}

describe('DispatchPage — intake source tabs', () => {
  it('offers the three parsers plus the three platforms that are announced but not built', async () => {
    mount();
    const tablist = await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });
    const tabs = within(tablist).getAllByRole('tab');

    // Booking.com is shown as "Booking" — the enum value is unchanged, only the
    // label. Tripadvisor, G2J and Traveloka are listed but carry no extraction;
    // selecting one says so rather than accepting text it cannot parse.
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Booking',
      'Agoda',
      'CTrip',
      'Tripadvisor',
      'G2J',
      'Traveloka',
    ]);
    expect(within(tablist).queryByText('Booking.com')).not.toBeInTheDocument();
  });

  it('marks exactly one tab selected, starting on Booking.com', async () => {
    mount();
    const tablist = await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });
    const tabs = within(tablist).getAllByRole('tab');

    expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('moves the selection when another source is chosen', async () => {
    mount();
    const user = userEvent.setup();
    const tablist = await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });

    await user.click(within(tablist).getByRole('tab', { name: 'CTrip' }));

    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(within(tablist).getByRole('tab', { name: 'CTrip' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('changes the label and helper text with the selected platform', async () => {
    mount();
    const user = userEvent.setup();
    const tablist = await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });

    expect(await screen.findByText('Nội dung Booking')).toBeInTheDocument();
    expect(screen.getByText(/Extranet/)).toBeInTheDocument();

    await user.click(within(tablist).getByRole('tab', { name: 'CTrip' }));
    expect(await screen.findByText('Nội dung CTrip')).toBeInTheDocument();
    // CTrip's helper is explicit that some fields may need manual checking.
    expect(screen.getByText(/kiểm tra và bổ sung thủ công/)).toBeInTheDocument();

    await user.click(within(tablist).getByRole('tab', { name: 'Agoda' }));
    expect(await screen.findByText('Nội dung Agoda')).toBeInTheDocument();
    expect(screen.getByText(/YCS/)).toBeInTheDocument();
  });

  /**
   * Booking.com keeps the original extract-to-draft flow. Agoda and CTrip go to
   * the server-authoritative Admin review panel instead, so they must NOT reach
   * the extract API — that endpoint would create a draft the review flow never
   * uses. These two tests pin both halves of that split.
   */
  it('sends Booking.com content to the extract API', async () => {
    const seen: { path: string; body: Record<string, unknown> }[] = [];
    mount((path, init) => {
      seen.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    });
    const user = userEvent.setup();

    await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });
    await user.type(screen.getByRole('textbox'), 'KAS Passion Boutique Hotel');
    await user.click(screen.getByRole('button', { name: /Trích xuất thông tin/ }));

    const extract = seen.find((r) => r.path === '/api/bookings/extract');
    expect(extract).toBeDefined();
    expect(extract!.body.source).toBe('BOOKING_COM');
    expect(extract!.body.rawText).toContain('KAS Passion Boutique Hotel');
  });

  it('transmits the pasted text verbatim, including tabs and blank lines', async () => {
    // The server does all the parsing, so the browser must not tidy the paste:
    // stripping a tab or collapsing a blank line changes what the label reader
    // sees and can silently empty a field.
    const seen: { path: string; body: Record<string, unknown> }[] = [];
    mount((path, init) => {
      seen.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    });
    const user = userEvent.setup();

    const tablist = await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });
    await user.click(within(tablist).getByRole('tab', { name: 'Agoda' }));

    const pasted = 'Booking ID\tMã số đặt phòng\n1756224954\n\nCheck-in Nhận phòng 4-Aug-2026';
    // Paste rather than type: userEvent.type interprets tabs and newlines.
    await user.click(screen.getByRole('textbox'));
    await user.paste(pasted);
    await user.click(screen.getByRole('button', { name: /Trích xuất thông tin/ }));

    const review = await vi.waitFor(() => {
      const hit = seen.find((r) => r.path === '/api/admin/ota/review');
      expect(hit).toBeDefined();
      return hit!;
    });
    expect(review.body.rawText).toBe(pasted);
    expect(review.body.source).toBe('AGODA');
    // The exact property names the route reads — not "content" or "platform".
    expect(Object.keys(review.body).sort()).toEqual(['overrides', 'rawText', 'source']);
  });

  it.each([
    ['CTrip', 'CTRIP'],
    ['Agoda', 'AGODA'],
  ])('routes %s to the review endpoint instead of extract', async (tabName, source) => {
    const seen: { path: string; body: Record<string, unknown> }[] = [];
    mount((path, init) => {
      seen.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    });
    const user = userEvent.setup();

    const tablist = await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });
    await user.click(within(tablist).getByRole('tab', { name: tabName }));
    await user.type(screen.getByRole('textbox'), 'KAS Passion Boutique Hotel');
    await user.click(screen.getByRole('button', { name: /Trích xuất thông tin/ }));

    const review = await vi.waitFor(() => {
      const hit = seen.find((r) => r.path === '/api/admin/ota/review');
      expect(hit).toBeDefined();
      return hit!;
    });
    expect(review.body.source).toBe(source);
    expect(review.body.rawText).toContain('KAS Passion Boutique Hotel');
    // No draft is created for these platforms.
    expect(seen.some((r) => r.path === '/api/bookings/extract')).toBe(false);
  });
});
