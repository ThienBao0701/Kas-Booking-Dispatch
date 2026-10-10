/**
 * The Admin UI revision, as an Admin experiences it.
 *
 * These cover the four screen changes: the dashboard's date selector, the
 * renamed/extended source list on Nhập đơn, the stripped-down History filters,
 * and the all-branches recipient on Nhắc nhở.
 *
 * The point of most of them is what is ABSENT — a removed sorting control, a
 * removed filter group. Those are asserted by querying for the thing and
 * expecting nothing, which only means something because the same file asserts
 * the controls that remain are still present and still work.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // These pages persist filters; a leaked selection would change the next case.
  localStorage.clear();
});

type Handler = (init: RequestInit) => { status: number; body?: unknown };

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'Saigon Hotel', address: '05 Trương Định' };

/*
  The summary response as the server now sends it.

  `range` and the per-branch `sent` are not optional extras: the page reads both,
  so a fixture without them describes a shape the server cannot produce and the
  screen renders `undefined` where a count belongs. `date` is the first day of
  the scope, so it tracks `range.from` by default; a range case passes its own
  `range` through `over`.
*/
function summaryBody(over: Record<string, unknown> = {}) {
  const date = typeof over.date === 'string' ? over.date : '2026-08-11';
  return {
    date,
    range: { from: date, to: date },
    totals: { waiting: 3, confirmedToday: 2, lastMinute: 1, sentToday: 5 },
    branches: [{ branch: BRANCH, waiting: 3, confirmedToday: 2, lastMinute: 1, sent: 5 }],
    issues: { reported: 4, stillOpen: 2 },
    ...over,
  };
}

function mount(routes: Record<string, Handler> = {}) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/nav-badges': () => ({
      status: 200,
      body: {
        counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 },
        serverNow: '2026-08-11T05:00:00.000Z',
      },
    }),
    'GET /api/issues/summary': () => ({
      status: 200,
      body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } },
    }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH] } }),
    ...routes,
  });
}

/* ================================================================== */
/* Dashboard — single-date overview                                    */
/* ================================================================== */

describe('dashboard date selector', () => {
  it('defaults to today and asks the server for it', async () => {
    const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fetchMock = mount({
      [`GET /api/admin/dashboard/summary?date=${today}`]: () => ({
        status: 200,
        body: summaryBody({ date: today }),
      }),
    });
    renderApp('/app/dashboard');

    // One control with two ends. Both open on today, so the opening scope is a
    // single day and the request keeps its original `?date=` shape.
    expect(await screen.findByTestId('dashboard-range-from')).toHaveValue(today);
    expect(screen.getByTestId('dashboard-range-to')).toHaveValue(today);

    await waitFor(() => {
      const asked = fetchMock.mock.calls.some(([u]) => String(u).includes(`date=${today}`));
      expect(asked).toBe(true);
    });
  });

  it('shows each branch its share of the total, so the two reconcile', async () => {
    /*
      THE DISCREPANCY THIS CHANGE EXISTS TO END. The branch section used to have
      no column that summed to "Tổng đơn gửi", so an operator could read 5 sent
      at the top and find nothing below it that added up — the counters were
      being taken from different date axes. The row now carries its share of the
      same population, and the server proves the sum (adminDashboard.test.ts,
      CASE 5). This asserts the operator can actually see it.
    */
    const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    mount({
      [`GET /api/admin/dashboard/summary?date=${today}`]: () => ({
        status: 200,
        body: summaryBody({ date: today }),
      }),
    });
    renderApp('/app/dashboard');

    const section = (await screen.findByText('Theo chi nhánh')).parentElement!;
    expect(within(section).getByText('đã gửi')).toBeInTheDocument();
    // 5 is this branch's `sent`, and equals totals.sentToday for the one branch.
    expect(within(section).getByText('5')).toBeInTheDocument();
  });

  it('sends the CHOSEN date to the server, not a client-side filter', async () => {
    const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fetchMock = mount({
      [`GET /api/admin/dashboard/summary?date=${today}`]: () => ({
        status: 200,
        body: summaryBody({ date: today, totals: { waiting: 3, confirmedToday: 2, lastMinute: 1, sentToday: 5 } }),
      }),
      /*
        Mid-edit: the start has moved and the end has not followed yet. That is
        a real request the page makes, so it is answered rather than left to
        404 and blank the screen the assertions below read. Its figures are the
        default ones, which appear in the first payload too — so they can never
        be mistaken for the chosen day's.
      */
      [`GET /api/admin/dashboard/summary?from=2026-08-09&to=${today}`]: () => ({
        status: 200,
        body: summaryBody({ date: '2026-08-09', range: { from: '2026-08-09', to: today } }),
      }),
      'GET /api/admin/dashboard/summary?date=2026-08-09': () => ({
        status: 200,
        body: summaryBody({
          date: '2026-08-09',
          totals: { waiting: 9, confirmedToday: 8, lastMinute: 7, sentToday: 6 },
          issues: { reported: 1, stillOpen: 0 },
        }),
      }),
    });
    renderApp('/app/dashboard');

    // ONE day is now both ends of the range set to it, and that is still the
    // `?date=` request — the single-day view keeps the shape it always had.
    // fireEvent, not userEvent.type: a native date input takes a whole value,
    // and typing it character by character produces intermediate invalid states.
    fireEvent.change(await screen.findByTestId('dashboard-range-from'), {
      target: { value: '2026-08-09' },
    });
    fireEvent.change(screen.getByTestId('dashboard-range-to'), { target: { value: '2026-08-09' } });

    // The request carries the date…
    await waitFor(() => {
      const asked = fetchMock.mock.calls.some(([u]) => String(u).includes('date=2026-08-09'));
      expect(asked).toBe(true);
    });
    // …and the page shows THAT day's numbers, which appear nowhere in the
    // first payload — so they cannot have come from re-filtering it.
    expect(await screen.findByText('9')).toBeInTheDocument();
    expect(await screen.findByText('8')).toBeInTheDocument();
    expect(await screen.findByText('6')).toBeInTheDocument();
  });

  it('never sends an inverted range when an end is cleared', async () => {
    /*
      THE DEFECT THIS PINS. Clearing the start while the end sat on a past day
      used to resolve the blank end to TODAY, producing from=<today>&to=<past>.
      The server refuses that with 422 — correctly — so the operator lost every
      card on the page to an error alert, having done nothing but press Delete
      in a date box.

      A cleared end now collapses onto the other one: the scope becomes the
      remaining day, which is what the boxes on screen actually say.
    */
    const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fetchMock = mount({
      [`GET /api/admin/dashboard/summary?date=${today}`]: () => ({
        status: 200,
        body: summaryBody({ date: today }),
      }),
      [`GET /api/admin/dashboard/summary?from=2026-08-01&to=${today}`]: () => ({
        status: 200,
        body: summaryBody({ date: '2026-08-01', range: { from: '2026-08-01', to: today } }),
      }),
      'GET /api/admin/dashboard/summary?from=2026-08-01&to=2026-08-05': () => ({
        status: 200,
        body: summaryBody({ date: '2026-08-01', range: { from: '2026-08-01', to: '2026-08-05' } }),
      }),
      // What a cleared start must now produce: the remaining day, alone.
      'GET /api/admin/dashboard/summary?date=2026-08-05': () => ({
        status: 200,
        body: summaryBody({ date: '2026-08-05' }),
      }),
    });
    renderApp('/app/dashboard');

    fireEvent.change(await screen.findByTestId('dashboard-range-from'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(screen.getByTestId('dashboard-range-to'), { target: { value: '2026-08-05' } });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) =>
          String(u).includes('from=2026-08-01&to=2026-08-05'),
        ),
      ).toBe(true),
    );

    // Now clear the START, the way an operator does before retyping it.
    fireEvent.change(screen.getByTestId('dashboard-range-from'), { target: { value: '' } });

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) => String(u) === '/api/admin/dashboard/summary?date=2026-08-05'),
      ).toBe(true),
    );
    // No request may ever carry a start later than its end.
    for (const [u] of fetchMock.mock.calls) {
      const m = /[?&]from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})/.exec(String(u));
      if (m) expect(m[1]! <= m[2]!).toBe(true);
    }
    // The page still says which period it is counting, and offers the way back.
    expect(screen.getByRole('button', { name: 'Hôm nay' })).toBeInTheDocument();
  });

  it('sends a RANGE request when the two ends differ', async () => {
    const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fetchMock = mount({
      [`GET /api/admin/dashboard/summary?date=${today}`]: () => ({
        status: 200,
        body: summaryBody({ date: today }),
      }),
      // Again the mid-edit scope: start moved, end still today.
      [`GET /api/admin/dashboard/summary?from=2026-08-01&to=${today}`]: () => ({
        status: 200,
        body: summaryBody({ date: '2026-08-01', range: { from: '2026-08-01', to: today } }),
      }),
      'GET /api/admin/dashboard/summary?from=2026-08-01&to=2026-08-05': () => ({
        status: 200,
        body: summaryBody({
          date: '2026-08-01',
          range: { from: '2026-08-01', to: '2026-08-05' },
          totals: { waiting: 9, confirmedToday: 8, lastMinute: 7, sentToday: 66 },
          issues: { reported: 1, stillOpen: 0 },
        }),
      }),
    });
    renderApp('/app/dashboard');

    fireEvent.change(await screen.findByTestId('dashboard-range-from'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.change(screen.getByTestId('dashboard-range-to'), { target: { value: '2026-08-05' } });

    // Two different ends go out as `from`+`to`, in that order, and as nothing
    // else: a period is not a day, so there is no `date=` for this scope.
    await waitFor(() => {
      const asked = fetchMock.mock.calls.some(
        ([u]) => String(u) === '/api/admin/dashboard/summary?from=2026-08-01&to=2026-08-05',
      );
      expect(asked).toBe(true);
    });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('date=2026-08-01'))).toBe(false);
    // The page knows it is showing a period, not a day.
    expect(await screen.findByText('Sự cố trong kỳ')).toBeInTheDocument();
    expect(await screen.findByText('66')).toBeInTheDocument();
  });

  it('shows the day\'s issue count', async () => {
    const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    mount({
      [`GET /api/admin/dashboard/summary?date=${today}`]: () => ({
        status: 200,
        body: summaryBody({ date: today, issues: { reported: 4, stillOpen: 2 } }),
      }),
    });
    renderApp('/app/dashboard');

    expect(await screen.findByText('Sự cố trong ngày')).toBeInTheDocument();
    expect(screen.getByText('2 chưa xử lý')).toBeInTheDocument();
  });
});

/* ================================================================== */
/* Nhập đơn — sources                                                  */
/* ================================================================== */

describe('order input sources', () => {
  it('lists all five sources, with Booking.com renamed to Booking', async () => {
    mount();
    renderApp('/app/dispatch');

    const tabs = await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });
    const names = within(tabs)
      .getAllByRole('tab')
      .map((t) => t.textContent?.trim());
    expect(names).toEqual(['Booking', 'Agoda', 'CTrip', 'Tripadvisor', 'G2J', 'Traveloka']);
    // The old label is gone entirely.
    expect(within(tabs).queryByText('Booking.com')).not.toBeInTheDocument();
  });

  it('keeps the working sources working — Booking, Agoda and CTrip all offer the paste box', async () => {
    mount();
    renderApp('/app/dispatch');

    const tabs = await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });
    for (const name of ['Booking', 'Agoda', 'CTrip']) {
      await userEvent.click(within(tabs).getByRole('tab', { name }));
      expect(screen.getByRole('button', { name: /Trích xuất thông tin/ })).toBeInTheDocument();
      expect(screen.queryByTestId('source-coming-soon')).not.toBeInTheDocument();
    }
  });

  it('shows the coming-soon notice for Tripadvisor, and no way to submit', async () => {
    mount();
    renderApp('/app/dispatch');

    const tabs = await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Tripadvisor' }));

    expect(screen.getByTestId('source-coming-soon')).toHaveTextContent(
      'Ứng dụng sẽ phát triển phần này sớm nhất',
    );
    expect(screen.queryByRole('button', { name: /Trích xuất thông tin/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows the coming-soon notice for G2J, and no way to submit', async () => {
    mount();
    renderApp('/app/dispatch');

    const tabs = await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });
    await userEvent.click(within(tabs).getByRole('tab', { name: 'G2J' }));

    expect(screen.getByTestId('source-coming-soon')).toHaveTextContent(
      'Ứng dụng sẽ phát triển phần này sớm nhất',
    );
    expect(screen.queryByRole('button', { name: /Trích xuất thông tin/ })).not.toBeInTheDocument();
  });

  it('shows the coming-soon notice for Traveloka, and no way to submit', async () => {
    mount();
    renderApp('/app/dispatch');

    const tabs = await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Traveloka' }));

    expect(screen.getByTestId('source-coming-soon')).toHaveTextContent(
      'Ứng dụng sẽ phát triển phần này sớm nhất',
    );
    expect(screen.queryByRole('button', { name: /Trích xuất thông tin/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('never calls an extractor for Traveloka', async () => {
    const fetchMock = mount();
    renderApp('/app/dispatch');

    const tabs = await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Traveloka' }));

    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/extract'))).toBe(false);
  });

  it('never calls an extractor for a placeholder source', async () => {
    const fetchMock = mount();
    renderApp('/app/dispatch');

    const tabs = await screen.findByRole('tablist', { name: 'Nguồn đặt phòng' });
    await userEvent.click(within(tabs).getByRole('tab', { name: 'G2J' }));

    const extracted = fetchMock.mock.calls.some(([u]) => String(u).includes('/extract'));
    expect(extracted).toBe(false);
  });
});

/* ================================================================== */
/* History — filters                                                   */
/* ================================================================== */

function historyMount() {
  return mount({
    'GET /api/bookings/history?page=1&pageSize=20': () => ({
      status: 200,
      body: { bookings: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } },
    }),
  });
}

describe('history filters', () => {
  it('offers no sorting controls', async () => {
    historyMount();
    renderApp('/app/history');

    // The range is the page-ready signal: it is the one filter control that is
    // certain to be on this screen.
    await screen.findByTestId('history-range');
    expect(screen.queryByLabelText('Sắp xếp')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Thứ tự')).not.toBeInTheDocument();
    expect(screen.queryByText('Cập nhật gần nhất')).not.toBeInTheDocument();
    expect(screen.queryByText('Giảm dần')).not.toBeInTheDocument();
    expect(screen.queryByText('Tăng dần')).not.toBeInTheDocument();
  });

  it('offers no status filter at all — the four stay outcomes are gone', async () => {
    /*
      The screen is a record of what was DISPATCHED, read by date and by booking
      code; the outcome filter was not how anyone arrived at a row, and the table
      has no status column for it to narrow. Nothing was removed from the system
      — every BookingStatus is still written and still filterable through the
      API — this is the History filter UI narrowing.
    */
    historyMount();
    renderApp('/app/history');

    await screen.findByTestId('history-range');
    expect(screen.queryByTestId('filter-status')).not.toBeInTheDocument();
    for (const outcome of [
      'Khách đã nhận phòng',
      'Khách đã trả phòng',
      'Đã huỷ',
      'Khách không đến',
    ]) {
      expect(screen.queryByText(outcome)).not.toBeInTheDocument();
    }
  });

  it('offers no source filter and no verification filter', async () => {
    historyMount();
    renderApp('/app/history');

    await screen.findByTestId('history-range');
    expect(screen.queryByTestId('filter-source')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filter-verification')).not.toBeInTheDocument();
  });

  it('offers exactly one date range, and it is ONE control', async () => {
    historyMount();
    renderApp('/app/history');

    await screen.findByTestId('history-range');
    // A fieldset with a legend is one labelled group: the two ends belong to a
    // single field, and there is exactly one such field on the page.
    expect(screen.getAllByRole('group', { name: 'Khoảng thời gian' })).toHaveLength(1);
    // getByRole itself refuses a second match, so this IS the "exactly one".
    const range = screen.getByRole('group', { name: 'Khoảng thời gian' });
    expect(within(range).getByLabelText('Khoảng thời gian: từ ngày')).toBeInTheDocument();
    expect(within(range).getByLabelText('Khoảng thời gian: đến ngày')).toBeInTheDocument();
    // The ends no longer answer to bare labels of their own — that is what made
    // them read as two independent questions.
    expect(screen.queryByLabelText('Từ ngày')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Đến ngày')).not.toBeInTheDocument();
    for (const gone of ['Gửi từ', 'Gửi đến', 'Nhận phòng từ', 'Nhận phòng đến', 'Trả phòng từ', 'Trả phòng đến', 'Xác nhận từ', 'Xác nhận đến']) {
      expect(screen.queryByLabelText(gone)).not.toBeInTheDocument();
    }
  });

  it('still filters — the range reaches the API', async () => {
    const fetchMock = historyMount();
    renderApp('/app/history');

    await screen.findByTestId('history-range');
    // fireEvent, not userEvent.type: a native date input takes a whole value,
    // and typing it character by character produces intermediate invalid states
    // that the range's own min/max then clamp away.
    fireEvent.change(screen.getByLabelText('Khoảng thời gian: từ ngày'), {
      target: { value: '2026-08-01' },
    });

    // THE WIRE CONTRACT IS UNCHANGED: the control is new, `sentFrom`/`sentTo`
    // on `sentAt` are not.
    await waitFor(() => {
      const asked = fetchMock.mock.calls.some(([u]) => String(u).includes('sentFrom=2026-08-01'));
      expect(asked).toBe(true);
    });
  });

  it('sends no status parameter, whatever the operator picks', async () => {
    const fetchMock = historyMount();
    renderApp('/app/history');

    await screen.findByTestId('history-range');
    fireEvent.change(screen.getByLabelText('Khoảng thời gian: đến ngày'), {
      target: { value: '2026-08-31' },
    });

    await waitFor(() => {
      const asked = fetchMock.mock.calls.some(([u]) => String(u).includes('sentTo=2026-08-31'));
      expect(asked).toBe(true);
    });
    const historyCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/bookings/history'));
    for (const [u] of historyCalls) {
      expect(String(u)).not.toContain('status=');
    }
  });

  it('sends no sort or order, leaving the API default in place', async () => {
    const fetchMock = historyMount();
    renderApp('/app/history');

    await screen.findByTestId('history-range');
    const historyCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/bookings/history'));
    expect(historyCalls.length).toBeGreaterThan(0);
    for (const [u] of historyCalls) {
      expect(String(u)).not.toContain('sort=');
      expect(String(u)).not.toContain('order=');
    }
  });
});

/* ================================================================== */
/* Reminders — all branches                                            */
/* ================================================================== */

function reminderMount(extra: Record<string, Handler> = {}) {
  return mount({
    'GET /api/reminders': () => ({ status: 200, body: { reminders: [] } }),
    'GET /api/admin/users': () => ({
      status: 200,
      body: {
        users: [
          { id: 2, username: 'letana', fullName: 'Lễ tân Một', role: 'RECEPTIONIST', active: true, branch: BRANCH },
          { id: 3, username: 'letanb', fullName: 'Lễ tân Hai', role: 'RECEPTIONIST', active: true, branch: BRANCH },
        ],
      },
    }),
    ...extra,
  });
}

describe('reminders recipient', () => {
  it('offers "Tất cả chi nhánh" alongside each receptionist', async () => {
    reminderMount();
    renderApp('/app/reminders');

    const select = await screen.findByLabelText('Người nhận');
    // The receptionist list arrives from its own query, so wait for it rather
    // than reading the select the moment it mounts.
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Lễ tân Một (letana)' })).toBeInTheDocument(),
    );
    const options = within(select).getAllByRole('option').map((o) => o.textContent?.trim());
    expect(options).toContain('Tất cả chi nhánh');
    expect(options).toContain('Lễ tân Hai (letanb)');
  });

  it('sends ONE broadcast request when all branches is chosen', async () => {
    const fetchMock = reminderMount({
      'POST /api/reminders': () => ({ status: 201, body: { recipients: 2 } }),
    });
    renderApp('/app/reminders');

    await userEvent.selectOptions(await screen.findByLabelText('Người nhận'), 'ALL_BRANCHES');
    await userEvent.type(screen.getByTestId('reminder-body'), 'Nhắc cả nhà');
    await userEvent.click(screen.getByTestId('reminder-send'));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([u, init]) =>
          String(u) === '/api/reminders' && (init as RequestInit | undefined)?.method === 'POST',
      );
      // Exactly one request — not one per receptionist.
      expect(posts).toHaveLength(1);
      expect(String((posts[0] as unknown as [string, RequestInit])[1].body)).toContain('ALL_BRANCHES');
    });
  });

  it('still sends to ONE receptionist by id', async () => {
    const fetchMock = reminderMount({
      'POST /api/reminders': () => ({
        status: 201,
        body: { reminder: { id: 'r1', body: 'Riêng A', createdAt: '', readAt: null, recipient: null, sender: null } },
      }),
    });
    renderApp('/app/reminders');

    const select = await screen.findByLabelText('Người nhận');
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'Lễ tân Hai (letanb)' })).toBeInTheDocument(),
    );
    await userEvent.selectOptions(select, '3');
    await userEvent.type(screen.getByTestId('reminder-body'), 'Riêng A');
    await userEvent.click(screen.getByTestId('reminder-send'));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([u, init]) =>
          String(u) === '/api/reminders' && (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts).toHaveLength(1);
      const sent = String((posts[0] as unknown as [string, RequestInit])[1].body);
      expect(sent).toContain('"recipientUserId":3');
      expect(sent).not.toContain('ALL_BRANCHES');
    });
  });
});
