/**
 * Sidebar badges — the numbers beside each menu item.
 *
 * WHAT IS BEING PROVED: that every badge comes from the server payload and
 * nothing else. A count kept in React state or localStorage would pass a naive
 * "does a 3 appear" test and then drift the moment anything happened in another
 * tab, so these assert the mapping from the server's fields to the menu items,
 * and that a changed payload changes the badge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { ADMIN_USER, RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Handler = (init: RequestInit) => { status: number; body?: unknown };

const NO_COUNTS = {
  new: 0,
  pendingReview: 0,
  rejected: 0,
  resendOrders: 0,
  chat: 0,
  reminders: 0,
};

function mount(user: typeof ADMIN_USER, counts: Partial<typeof NO_COUNTS>, extra: Record<string, Handler> = {}) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({
      status: 200,
      body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } },
    }),
    'GET /api/nav-badges': () => ({
      status: 200,
      body: { counts: { ...NO_COUNTS, ...counts }, serverNow: '2026-08-10T03:00:00.000Z' },
    }),
    'GET /api/admin/dashboard/summary': () => ({ status: 200, body: { summary: {} } }),
    ...extra,
  });
}

describe('receptionist sidebar badges', () => {
  it('shows a number on each queue that has work', async () => {
    mount(RECEPTIONIST_USER, { new: 3, pendingReview: 2, rejected: 1, chat: 4, reminders: 2 });
    renderApp('/app/new');

    expect(await screen.findByTestId('nav-badge-new')).toHaveTextContent('3');
    expect(screen.getByTestId('nav-badge-pending-review')).toHaveTextContent('2');
    expect(screen.getByTestId('nav-badge-chat')).toHaveTextContent('4');
    expect(screen.getByTestId('nav-badge-reminders')).toHaveTextContent('2');
    // "Cần tạo lại" left reception's menu, so there is no item to carry a badge.
    expect(screen.queryByTestId('nav-badge-rejected')).not.toBeInTheDocument();
  });

  it('renders NO badge for a queue that is empty', async () => {
    // Zero is not "0" in a red circle — an empty queue should look empty.
    mount(RECEPTIONIST_USER, { new: 2 });
    renderApp('/app/new');

    await screen.findByTestId('nav-badge-new');
    expect(screen.queryByTestId('nav-badge-pending-review')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-badge-rejected')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-badge-chat')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-badge-reminders')).not.toBeInTheDocument();
  });

  it('never shows the Admin-only resend badge', async () => {
    mount(RECEPTIONIST_USER, { new: 1, resendOrders: 9 });
    renderApp('/app/new');

    await screen.findByTestId('nav-badge-new');
    // The menu item does not exist for this role, so neither can its badge.
    expect(screen.queryByTestId('nav-badge-resend-orders')).not.toBeInTheDocument();
  });

  it('reads every number from the server, not from a local tally', async () => {
    mount(RECEPTIONIST_USER, { new: 7 });
    renderApp('/app/new');

    // 7 is not derivable from anything rendered on the page — the list mock is
    // empty — so the only possible source is the payload.
    expect(await screen.findByTestId('nav-badge-new')).toHaveTextContent('7');
  });

  it('caps a very large count rather than breaking the layout', async () => {
    mount(RECEPTIONIST_USER, { new: 245 });
    renderApp('/app/new');

    expect(await screen.findByTestId('nav-badge-new')).toHaveTextContent('99+');
  });
});

describe('admin sidebar badges', () => {
  it('includes "Gửi lại đơn" alongside the shared queues', async () => {
    mount(ADMIN_USER, { new: 5, pendingReview: 3, rejected: 2, resendOrders: 4, chat: 6 });
    renderApp('/app/dashboard');

    expect(await screen.findByTestId('nav-badge-resend-orders')).toHaveTextContent('4');
    expect(screen.getByTestId('nav-badge-pending-review')).toHaveTextContent('3');
    expect(screen.getByTestId('nav-badge-rejected')).toHaveTextContent('2');
    expect(screen.getByTestId('nav-badge-chat')).toHaveTextContent('6');
    // Admin's equivalent of "Đơn mới" is "Chờ chi nhánh tạo".
    expect(screen.getByTestId('nav-badge-waiting')).toHaveTextContent('5');
  });

  it('shows no reminder badge — an Admin has no inbox of their own', async () => {
    mount(ADMIN_USER, { resendOrders: 1, reminders: 0 });
    renderApp('/app/dashboard');

    await screen.findByTestId('nav-badge-resend-orders');
    expect(screen.queryByTestId('nav-badge-reminders')).not.toBeInTheDocument();
  });
});

describe('when the badge endpoint is unavailable', () => {
  it('renders the menu with no badges rather than failing', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
      'GET /api/issues/summary': () => ({
        status: 200,
        body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } },
      }),
      // /api/nav-badges deliberately absent → 404 from the mock.
    });
    renderApp('/app/new');

    // The menu itself still renders; a missing count is simply no badge.
    expect(await screen.findByRole('navigation', { name: 'Điều hướng chính' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('nav-badge-new')).not.toBeInTheDocument());
  });
});
