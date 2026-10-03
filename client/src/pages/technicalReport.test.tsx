/**
 * "Báo cáo vấn đề → Kỹ thuật" — the incidents of the reader's branches, grouped
 * Branch → Room, with the status counts, assignment and the department export.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, TECHNICAL_MANAGER_USER, installApiMock, renderApp } from '../test/utils';
import { withLifecycle } from '../test/issueFixtures';
import { hcmToday } from '../lib/format';
import { daysBefore } from '../lib/shiftGroups';

/** The report's default period: the last 30 days. */
const TODAY = hcmToday();
const LIST = `GET /api/issues?from=${daysBefore(TODAY, 29)}&to=${TODAY}&pageSize=500`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const B1 = { id: 1, code: 'TD', hotelName: 'KAS', address: '05 Trương Định', branchNumber: 1 };
const B2 = { id: 2, code: 'LT', hotelName: 'KAS 2', address: '260 Lý Tự Trọng', branchNumber: 2 };

function issue(id: string, over: Record<string, unknown> = {}) {
  return withLifecycle({
    id,
    branchId: 1,
    branch: B1,
    areaCategory: 'ROOM',
    roomNumber: '301',
    floorNumber: null,
    areaSubtype: null,
    locationDetail: null,
    locationLabel: 'Phòng 301',
    category: 'AIR_CONDITIONER',
    description: 'Máy lạnh không lạnh',
    photoUrl: null,
    status: 'NEW',
    reportedBy: null,
    reportedByName: 'Lễ tân Một',
    reporterName: 'Lễ tân Một',
    acceptedBy: null,
    acceptedByName: null,
    acceptedAt: null,
    technicianName: null,
    technicianPhone: null,
    completedBy: null,
    completedByName: null,
    completedAt: null,
    createdAt: '2026-09-17T02:00:00.000Z',
    updatedAt: '2026-09-17T02:00:00.000Z',
    shiftType: null,
    shiftReceptionistName: null,
    durationSeconds: null,
    durationLabel: null,
    attempts: [],
    cannotRepairCount: 0,
    needsRework: false,
    assignmentState: 'UNASSIGNED',
    assignmentStateLabel: 'Chưa giao kỹ thuật',
    ...over,
  });
}

const ISSUES = [
  issue('a'),
  issue('a2', { category: 'TV', description: 'TV không lên hình', locationDetail: 'Cạnh cửa sổ', locationLabel: 'Phòng 301 · Cạnh cửa sổ' }),
  issue('b', { roomNumber: '102', locationLabel: 'Phòng 102', status: 'IN_PROGRESS', assignmentState: 'IN_PROGRESS', assignmentStateLabel: 'Đang sửa' }),
  issue('c', { branchId: 2, branch: B2, status: 'COMPLETED', assignmentState: 'COMPLETED', assignmentStateLabel: 'Đã hoàn thành' }),
];

function routes(user: unknown, extra: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {}) {
  return {
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({
      status: 200,
      body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } },
    }),
    'GET /api/nav-badges': () => ({
      status: 200,
      body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } },
    }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [B1, B2] } }),
    'GET /api/issues/technicians': () => ({ status: 200, body: { technicians: [{ id: 4, fullName: 'Kỹ thuật viên trực' }] } }),
    [LIST]: () => ({
      status: 200,
      body: { issues: ISSUES, pagination: { page: 1, pageSize: 500, total: ISSUES.length, totalPages: 1 } },
    }),
    ...extra,
  };
}

describe('the technical report', () => {
  it('groups Branch → Room, counts the states, and exports the technical section', async () => {
    installApiMock(routes(ADMIN_USER));
    renderApp('/app/reports/technical');

    const first = await screen.findByTestId('tr-branch-1');
    expect(within(first).getByRole('heading', { level: 2 })).toHaveTextContent('Chi nhánh 1 — 05 Trương Định');
    // Rooms in order within the branch — and Phòng 301's two faults are ONE room
    // (different descriptions and details do not split it).
    expect(within(first).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Phòng 1021 vấn đề',
      'Phòng 3012 vấn đề',
    ]);
    expect(screen.getByTestId('tr-branch-2')).toHaveTextContent('Chi nhánh 2 — 260 Lý Tự Trọng');

    expect(screen.getByTestId('tr-count-UNASSIGNED')).toHaveTextContent('2');
    expect(screen.getByTestId('tr-count-IN_PROGRESS')).toHaveTextContent('1');
    expect(screen.getByTestId('tr-count-COMPLETED')).toHaveTextContent('1');
    // A status press narrows the rows.
    await userEvent.click(screen.getByTestId('tr-count-COMPLETED'));
    await waitFor(() => expect(screen.queryByTestId('tr-branch-1')).not.toBeInTheDocument());

    expect(screen.getByTestId('technical-export-pdf').getAttribute('href')).toMatch(/section=TECHNICAL/);
    expect(screen.getByTestId('technical-export-xlsx').getAttribute('href')).toMatch(/operational\.xlsx.*section=TECHNICAL/);
  });

  it('lets the Quản lý kỹ thuật give a room’s chosen faults to a technician', async () => {
    let sent: unknown = null;
    installApiMock(
      routes(TECHNICAL_MANAGER_USER, {
        'POST /api/issues/assign': (init) => {
          sent = JSON.parse(String(init.body));
          return { status: 200, body: { issues: [issue('a', { assignedTechnician: { id: 4, name: 'Kỹ thuật viên trực' } })] } };
        },
      }),
    );
    renderApp('/app');

    expect(await screen.findByRole('heading', { name: 'Quản lý sự cố kỹ thuật' })).toBeInTheDocument();
    // ONE "Giao kỹ thuật" for Phòng 301's two waiting faults; none where nothing waits.
    const room = await screen.findByTestId('tr-room-1|ROOM|301||');
    expect(within(room).getAllByRole('button', { name: /Giao kỹ thuật/ })).toHaveLength(1);
    expect(screen.queryByTestId('tr-room-assign-1|ROOM|102||')).not.toBeInTheDocument();
    await userEvent.click(within(room).getByTestId('tr-room-assign-1|ROOM|301||'));
    const dialog = await screen.findByRole('dialog', { name: 'Giao kỹ thuật — Phòng 301' });
    // Nothing is pre-ticked: a fault is never assigned for sharing a room.
    expect(within(dialog).getByTestId('room-assign-count')).toHaveTextContent('0/2 đã chọn');
    await userEvent.click(within(dialog).getByTestId('room-assign-pick-a'));
    expect(within(dialog).getByTestId('room-assign-count')).toHaveTextContent('1/2 đã chọn');
    const select = within(dialog).getByTestId('room-assign-technician');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    await userEvent.selectOptions(select, '4');
    await userEvent.click(within(dialog).getByTestId('room-assign-confirm'));
    await waitFor(() => expect(sent).toEqual({ issueIds: ['a'], technicianUserId: 4 }));
  });
});

describe('"Báo cáo vấn đề" in the menu', () => {
  it('is one collapsible group: Lễ tân (its categories), Kỹ thuật, Buồng phòng — open where you are', async () => {
    installApiMock(routes(ADMIN_USER));
    renderApp('/app/reports/technical');
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });

    const here = await within(nav).findByRole('link', { name: 'Kỹ thuật' });
    expect(here).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Buồng phòng' })).toHaveAttribute('href', '/app/reports/housekeeping');
    // Lễ tân stays folded until opened; then each category is its own address.
    expect(within(nav).queryByRole('link', { name: 'Tổng' })).not.toBeInTheDocument();
    await userEvent.click(within(nav).getByTestId('nav-group-Lễ tân'));
    expect(within(nav).getByRole('link', { name: 'Tổng' })).toHaveAttribute('href', '/app/reports');
    expect(within(nav).getAllByRole('link').some((l) => l.getAttribute('href') === '/app/reports?category=PAYMENT')).toBe(true);
    expect(within(nav).getByTestId('nav-group-Hoàn thành vấn đề')).toBeInTheDocument();
  });
});
