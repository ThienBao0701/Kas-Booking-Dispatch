/**
 * The search experience on the history page.
 *
 * The behaviour under test is what the page ASKS THE SERVER FOR.
 *
 * The Admin revision narrowed this screen to one dispatch-date range and removed
 * both the sorting controls and the stay-outcome filter. The API still accepts
 * every parameter it ever did — these cases pin what the UI now sends, including
 * what it deliberately no longer sends.
 *
 * THE WIRE CONTRACT FOR THE RANGE IS UNCHANGED: `sentFrom`/`sentTo` on `sentAt`,
 * exactly as before. Only the control that produces them changed, from two
 * standalone date boxes to the one `DateRangeField` the dashboard also uses.
 *
 * The debounce is tested by counting requests, not by timing them. "One request
 * per pause instead of one per keystroke" is the property that matters and it
 * is observable; wall-clock speed in jsdom is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, RECEPTIONIST_USER, jsonResponse, renderApp } from '../test/utils';
import type { AuthUser } from '../auth/types';

let requested: string[] = [];

function mountHistory(bookings: unknown[] = [], user: AuthUser = ADMIN_USER) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/bookings/history')) {
        requested.push(decodeURIComponent(href));
        return jsonResponse(200, {
          bookings,
          pagination: { page: 1, pageSize: 20, total: bookings.length, totalPages: 1 },
        });
      }
      if (href.includes('/auth/me')) return jsonResponse(200, { user });
      if (href.includes('/notifications')) return jsonResponse(200, { count: 0 });
      if (href.includes('/branches')) {
        return jsonResponse(200, {
          branches: [{ id: 1, code: 'TRUONG_DINH_05', hotelName: 'Saigon Hotel', address: '05 Trương Định' }],
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: href } });
    }),
  );
  renderApp('/app/history');
}

const lastUrl = () => requested[requested.length - 1] ?? '';

/** The one range control's two ends, named by the legend they belong to. */
const RANGE_FROM = 'Khoảng thời gian: từ ngày';
const RANGE_TO = 'Khoảng thời gian: đến ngày';

/**
 * fireEvent.change, never userEvent.type: a native date input takes a whole
 * value, and typing it character by character produces intermediate invalid
 * states that the range control's own min/max clamps reject.
 */
function setDate(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Every history URL this render produced carries no `status` parameter. */
function expectNoStatusParam(): void {
  expect(requested.length).toBeGreaterThan(0);
  for (const url of requested) {
    // Anchored on the separator so `paymentStatus=` cannot satisfy it.
    expect(url).not.toMatch(/[?&]status=/);
  }
}

/** The saved-filter shape this page writes, for the restore cases below. */
const EMPTY_SAVED = {
  search: '',
  paymentStatus: '',
  isLastMinute: false,
  sentFrom: '',
  sentTo: '',
  branchId: '',
};

beforeEach(() => {
  requested = [];
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

/* ================================================================== */
/* Debounce                                                            */
/* ================================================================== */
describe('the search box settles before it queries', () => {
  it('sends one request for a burst of typing, not one per character', async () => {
    mountHistory();
    const box = await screen.findByLabelText('Tìm kiếm');
    requested = [];

    await userEvent.type(box, 'nguyen');
    // Every keystroke re-renders, but only the settled value reaches the query.
    await waitFor(() => expect(lastUrl()).toContain('search=nguyen'));

    const searches = requested.filter((u) => u.includes('search='));
    expect(searches.length).toBeLessThan(6);
    expect(searches[searches.length - 1]).toContain('search=nguyen');
  });

  it('never sends an intermediate prefix as the final query', async () => {
    mountHistory();
    await userEvent.type(await screen.findByLabelText('Tìm kiếm'), 'abc');
    await waitFor(() => expect(lastUrl()).toContain('search=abc'));
  });
});

/* ================================================================== */
/* The stay-outcome filter is gone                                     */
/* ================================================================== */
describe('the stay-outcome filter', () => {
  /*
    It offered CHECKED_IN / CHECKED_OUT / CANCELLED / NO_SHOW as toggle buttons
    and sent them as a comma-separated `status=`. The control is gone from this
    screen, so the parameter must be gone from the wire — not merely unset by
    default, but unreachable no matter which remaining filter is exercised.

    NOTHING WAS REMOVED FROM THE SYSTEM: the API still accepts `status`, and
    every BookingStatus value is still written and still filterable there. This
    case pins the History UI's own narrowing.
  */
  it('is offered by no control and never reaches the query', async () => {
    mountHistory();
    const form = await screen.findByRole('form', { name: 'Bộ lọc lịch sử' });

    expect(within(form).queryByText('Trạng thái')).toBeNull();
    expect(screen.queryByTestId('filter-status')).toBeNull();
    for (const gone of ['CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW']) {
      expect(screen.queryByTestId(`filter-status-${gone}`)).toBeNull();
    }

    // Everything this screen still offers, all at once — if any of them could
    // smuggle a status through, this is where it would show up.
    await userEvent.selectOptions(screen.getByLabelText('Thanh toán'), 'PAY_BEFORE');
    await userEvent.click(screen.getByLabelText('Last minute'));
    await screen.findByRole('option', { name: '05 Trương Định' });
    await userEvent.selectOptions(screen.getByLabelText('Chi nhánh'), '1');
    setDate(RANGE_FROM, '2026-08-10');
    await userEvent.type(screen.getByLabelText('Tìm kiếm'), 'nguyen');

    await waitFor(() => expect(lastUrl()).toContain('search=nguyen'));
    // The filters that survived did reach the server…
    expect(lastUrl()).toContain('paymentStatus=PAY_BEFORE');
    expect(lastUrl()).toContain('isLastMinute=true');
    expect(lastUrl()).toContain('branchId=1');
    expect(lastUrl()).toContain('sentFrom=2026-08-10');
    // …and not one request in the whole session carried a status.
    expectNoStatusParam();
  });
});

/* ================================================================== */
/* Sorting and the wider query                                         */
/* ================================================================== */
describe('the rest of the query', () => {
  it('never sends a sort key or order, leaving the API default in force', async () => {
    // The sorting controls are gone from this screen. The list is still newest
    // dispatch first, because that is what the API does when asked for nothing.
    mountHistory();
    await screen.findByLabelText('Tìm kiếm');
    await waitFor(() => expect(requested.length).toBeGreaterThan(0));
    for (const url of requested) {
      expect(url).not.toContain('sort=');
      expect(url).not.toContain('order=');
    }
  });

  it('sends the single date range on the dispatch date', async () => {
    mountHistory();
    await screen.findByLabelText(RANGE_FROM);

    setDate(RANGE_FROM, '2026-08-10');
    await waitFor(() => expect(lastUrl()).toContain('sentFrom=2026-08-10'));

    setDate(RANGE_TO, '2026-08-12');
    await waitFor(() => expect(lastUrl()).toContain('sentTo=2026-08-12'));
  });

  it('offers no other date axis, and the range is one control', async () => {
    mountHistory();
    const form = await screen.findByRole('form', { name: 'Bộ lọc lịch sử' });

    // One labelled group, not two standalone date questions.
    expect(within(form).getByRole('group', { name: 'Khoảng thời gian' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Từ ngày')).toBeNull();
    expect(screen.queryByLabelText('Đến ngày')).toBeNull();

    expect(screen.queryByText('Lọc theo ngày')).toBeNull();
    for (const gone of ['Nhận phòng từ', 'Trả phòng từ', 'Xác nhận từ', 'Gửi từ']) {
      expect(screen.queryByLabelText(gone)).toBeNull();
    }
  });
});

/* ================================================================== */
/* Chips                                                               */
/* ================================================================== */
describe('active filter chips', () => {
  it('shows nothing when no filter is set', async () => {
    mountHistory();
    await screen.findByLabelText('Tìm kiếm');
    expect(screen.queryByTestId('filter-chips')).toBeNull();
  });

  it('shows one chip per active filter', async () => {
    mountHistory();
    await userEvent.selectOptions(await screen.findByLabelText('Thanh toán'), 'PAY_BEFORE');
    await userEvent.click(screen.getByLabelText('Last minute'));
    await screen.findByRole('option', { name: '05 Trương Định' });
    await userEvent.selectOptions(screen.getByLabelText('Chi nhánh'), '1');

    await waitFor(() => expect(screen.getAllByTestId('filter-chip')).toHaveLength(3));
    // Read off the chips themselves: "Last minute" is also the checkbox's own
    // label, so a document-wide text query would not prove it is a chip.
    expect(screen.getAllByTestId('filter-chip').map((c) => c.textContent?.trim())).toEqual([
      'Thanh toán: Đã thanh toán',
      'Last minute',
      'Chi nhánh: 05 Trương Định',
    ]);
  });

  it('removes just that filter when its chip is dismissed', async () => {
    mountHistory();
    await userEvent.selectOptions(await screen.findByLabelText('Thanh toán'), 'PAY_BEFORE');
    await userEvent.click(screen.getByLabelText('Last minute'));
    await waitFor(() => expect(screen.getAllByTestId('filter-chip')).toHaveLength(2));

    await userEvent.click(screen.getByLabelText('Bỏ lọc Last minute'));
    await waitFor(() => expect(screen.getAllByTestId('filter-chip')).toHaveLength(1));

    // Asserted on state, not on the next URL: the payment-only query was
    // already fetched a moment ago, so react-query serves it from cache and
    // correctly issues no new request to inspect.
    expect(screen.getByTestId('filter-chip')).toHaveTextContent('Thanh toán: Đã thanh toán');
    expect(screen.getByLabelText('Thanh toán')).toHaveValue('PAY_BEFORE');
    expect(screen.getByLabelText('Last minute')).not.toBeChecked();
  });

  it('gives the date range its own chips', async () => {
    mountHistory();
    await screen.findByLabelText(RANGE_FROM);

    setDate(RANGE_FROM, '2026-08-10');
    await waitFor(() => expect(screen.getAllByTestId('filter-chip')).toHaveLength(1));
    expect(screen.getByText('Từ ngày: 2026-08-10')).toBeInTheDocument();

    setDate(RANGE_TO, '2026-08-12');
    await waitFor(() => expect(screen.getAllByTestId('filter-chip')).toHaveLength(2));
    expect(screen.getByText('Đến ngày: 2026-08-12')).toBeInTheDocument();
  });

  it('clears everything at once', async () => {
    mountHistory();
    await userEvent.selectOptions(await screen.findByLabelText('Thanh toán'), 'PAY_BEFORE');
    await userEvent.click(screen.getByLabelText('Last minute'));
    setDate(RANGE_FROM, '2026-08-10');
    await waitFor(() => expect(screen.getAllByTestId('filter-chip')).toHaveLength(3));

    await userEvent.click(screen.getByTestId('filter-clear-all'));
    await waitFor(() => expect(screen.queryByTestId('filter-chips')).toBeNull());
    // Every control is released; the unfiltered result comes from cache.
    expect(screen.getByLabelText('Thanh toán')).toHaveValue('');
    expect(screen.getByLabelText('Last minute')).not.toBeChecked();
    expect(screen.getByLabelText(RANGE_FROM)).toHaveValue('');
  });
});

/* ================================================================== */
/* Saved state                                                         */
/* ================================================================== */
describe('saved filter state', () => {
  it('restores the filters on a later visit', async () => {
    mountHistory();
    await userEvent.selectOptions(await screen.findByLabelText('Thanh toán'), 'PAY_AFTER');
    await waitFor(() => expect(lastUrl()).toContain('paymentStatus=PAY_AFTER'));

    requested = [];
    mountHistory();
    await waitFor(() => expect(requested.length).toBeGreaterThan(0));
    expect(lastUrl()).toContain('paymentStatus=PAY_AFTER');
  });

  it('starts clean when the saved value is corrupt', async () => {
    // A half-written or outdated entry must not break the page.
    window.localStorage.setItem('kas.history.filters', '{not json');
    mountHistory();
    await screen.findByRole('form', { name: 'Bộ lọc lịch sử' });
    await waitFor(() => expect(requested.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('filter-chips')).toBeNull();
    expectNoStatusParam();
  });

  it('ignores a saved status this screen no longer offers', async () => {
    /*
      These filters outlive the page. A browser that used History before the
      stay-outcome filter was removed still holds a `status` key, and the danger
      now runs the other way from what it used to: if that key reached the query
      it would keep hiding rows from a control that is no longer on screen —
      nothing selected to explain the gap, and no way to clear it.

      The page reads the saved object field by field for exactly this reason, so
      the legacy key is dropped while the filters it still offers are restored.
    */
    window.localStorage.setItem(
      'kas.history.filters',
      JSON.stringify({
        ...EMPTY_SAVED,
        // Written by an older build; there is no control for it any more.
        status: ['CHECKED_IN', 'CANCELLED'],
        paymentStatus: 'PAY_BEFORE',
      }),
    );
    mountHistory();
    await waitFor(() => expect(lastUrl()).toContain('paymentStatus=PAY_BEFORE'));

    // The surviving filter is applied and visible…
    expect(screen.getAllByTestId('filter-chip').map((c) => c.textContent?.trim())).toEqual([
      'Thanh toán: Đã thanh toán',
    ]);
    // …and the stale key never reached the server on any request.
    expectNoStatusParam();
  });
});

/* ================================================================== */
/* Reception sees the same screen                                      */
/* ================================================================== */
describe('the receptionist view', () => {
  it('gets the same single range control and no stay-outcome filter', async () => {
    // The status filter went for everyone; its absence is not a permission.
    mountHistory([], RECEPTIONIST_USER);
    const form = await screen.findByRole('form', { name: 'Bộ lọc lịch sử' });

    expect(within(form).getByRole('group', { name: 'Khoảng thời gian' })).toBeInTheDocument();
    expect(within(form).queryByText('Trạng thái')).toBeNull();
    for (const gone of ['CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW']) {
      expect(screen.queryByTestId(`filter-status-${gone}`)).toBeNull();
    }

    // And the one control drives the same wire contract it does for the Admin.
    setDate(RANGE_FROM, '2026-08-10');
    await waitFor(() => expect(lastUrl()).toContain('sentFrom=2026-08-10'));
    expectNoStatusParam();
  });
});
