/**
 * THE MANAGEMENT ENTRIES — "Theo dõi công việc" (two planned screens) and
 * "Individual Performance": every Quản lý / Tổng quản lý and the Admin see them,
 * marked "Sẽ phát triển"; no ordinary employee does, by menu or by address.
 * The screens read nothing from the server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, HOUSEKEEPING_USER, RECEPTIONIST_USER, TECHNICAL_USER, installApiMock, renderApp } from '../test/utils';
import { MANAGEMENT_ROLES, type UserRole } from '../auth/types';
import { navForRole, type NavItem } from './navigation';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TD', hotelName: 'KAS', address: '05 Trương Định', branchNumber: 1 };
const ALL_ROLES: UserRole[] = [
  'ADMIN',
  'RECEPTIONIST',
  'BOOKING_DEPARTMENT',
  'TECHNICAL',
  'TECHNICAL_MANAGER',
  'TECHNICAL_GENERAL_MANAGER',
  'HOUSEKEEPING',
  'HOUSEKEEPING_MANAGER',
  'RECEPTION_MANAGER',
  'RECEPTION_GENERAL_MANAGER',
];
const PLANNED = ['/app/work-tracking/assigned', '/app/work-tracking/mine', '/app/performance'];
const flat = (items: NavItem[]): NavItem[] => items.flatMap((i) => [i, ...flat(i.children ?? [])]);

function shell(user: unknown) {
  return installApiMock({
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({ status: 200, body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } } }),
    'GET /api/nav-badges': () => ({ status: 200, body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } } }),
    'GET /api/chat/channels': () => ({ status: 200, body: { channels: [] } }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH] } }),
  });
}

describe('who sees the management entries', () => {
  it('gives them to exactly the management roles — no ordinary employee or the booking department', () => {
    for (const role of ALL_ROLES) {
      const links = flat(navForRole(role)).map((i) => i.to);
      const has = PLANNED.every((p) => links.includes(p));
      const none = PLANNED.every((p) => !links.includes(p));
      expect(MANAGEMENT_ROLES.includes(role) ? has : none, role).toBe(true);
    }
    expect([...MANAGEMENT_ROLES].sort()).toEqual(['ADMIN', 'HOUSEKEEPING_MANAGER', 'RECEPTION_GENERAL_MANAGER', 'RECEPTION_MANAGER', 'TECHNICAL_GENERAL_MANAGER', 'TECHNICAL_MANAGER']);
  });

  it('keeps "Theo dõi công việc" a folded parent of exactly two planned screens, and "Individual Performance" its own entry', () => {
    const nav = navForRole('RECEPTION_MANAGER');
    const tracking = nav.find((i) => i.label === 'Theo dõi công việc')!;
    expect(tracking.children!.map((c) => [c.label, c.to, c.status])).toEqual([
      ['Theo dõi công việc đã giao', '/app/work-tracking/assigned', 'Sẽ phát triển'],
      ['Theo dõi công việc được giao và phải xử lí', '/app/work-tracking/mine', 'Sẽ phát triển'],
    ]);
    expect(nav.find((i) => i.to === '/app/performance')).toMatchObject({ label: 'Individual Performance', status: 'Sẽ phát triển' });
  });
});

describe('on screen', () => {
  it('shows a Quản lý the folded group with its "Sẽ phát triển" marks, and a planned page that fetches nothing', async () => {
    const manager = { id: 3, username: 'qlletan', fullName: 'Quản lý lễ tân', role: 'RECEPTION_MANAGER' as const, branch: null, active: true, mustChangePassword: false, managedBranchIds: [1] };
    const fetchMock = shell(manager);
    renderApp('/app/performance');
    expect(await within(await screen.findByRole('main')).findByRole('heading', { level: 1, name: 'Individual Performance' })).toBeInTheDocument();
    expect(screen.getByTestId('planned-feature')).toHaveTextContent('Sẽ phát triển');
    expect(screen.getByTestId('planned-feature')).toHaveTextContent('chưa hoạt động');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getByRole('link', { name: /Individual Performance/ })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByTestId('nav-status-/app/performance')).toHaveTextContent('Sẽ phát triển');
    const group = within(nav).getByTestId('nav-group-Theo dõi công việc');
    expect(group).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(group);
    expect(within(group.parentElement!).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/app/work-tracking/assigned', '/app/work-tracking/mine']);
    expect(within(nav).getByTestId('nav-status-/app/work-tracking/assigned')).toHaveTextContent('Sẽ phát triển');
    expect(within(nav).getByTestId('nav-status-/app/work-tracking/mine')).toHaveTextContent('Sẽ phát triển');
    // Nothing asked of the server for the planned screen itself.
    expect(fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => /work-tracking|performance/.test(u))).toEqual([]);
  });

  it('opens each "Theo dõi công việc" screen for the Admin, with the group open around it', async () => {
    shell(ADMIN_USER);
    renderApp('/app/work-tracking/mine');
    expect(await within(await screen.findByRole('main')).findByRole('heading', { level: 1, name: 'Theo dõi công việc được giao và phải xử lí' })).toBeInTheDocument();
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getByTestId('nav-group-Theo dõi công việc')).toHaveAttribute('aria-expanded', 'true');
  });

  it('refuses the planned screens to ordinary employees, by address too — and their menus do not offer them', async () => {
    for (const user of [RECEPTIONIST_USER, HOUSEKEEPING_USER, TECHNICAL_USER]) {
      shell(user);
      const view = renderApp('/app/work-tracking/assigned');
      const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
      expect(within(nav).queryByText('Theo dõi công việc')).not.toBeInTheDocument();
      expect(within(nav).queryByText('Individual Performance')).not.toBeInTheDocument();
      expect(screen.queryByTestId('planned-feature')).not.toBeInTheDocument();
      view.unmount();
      vi.unstubAllGlobals();
    }
  });
});
