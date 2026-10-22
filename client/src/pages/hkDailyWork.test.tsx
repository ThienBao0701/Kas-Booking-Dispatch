/**
 * "CÔNG VIỆC MỖI NGÀY CẦN LÀM" — one page, one selector — and the reception
 * managers' own "Công việc buồng phòng" with "Giao lại".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, installApiMock, renderApp } from '../test/utils';
import type { AuthUser } from '../auth/types';
import { hcmToday } from '../lib/format';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Handler = (init: RequestInit) => { status: number; body: unknown };
const BRANCH = { id: 1, code: 'TD', hotelName: 'KAS', address: '05 Trương Định', branchNumber: 1 };
const MANAGER: AuthUser = { id: 9, username: 'qlbp', fullName: 'Quản lý Buồng', role: 'HOUSEKEEPING_MANAGER', branch: BRANCH, active: true, mustChangePassword: false };
const RECEPTION_MANAGER = { id: 3, username: 'qlletan', fullName: 'Quản lý lễ tân', role: 'RECEPTION_MANAGER' as const, branch: null, active: true, mustChangePassword: false, managedBranchIds: [1] };
const TODAY = hcmToday();

function shell(user: unknown, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/me': () => ({ status: 200, body: { user } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({ status: 200, body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } } }),
    'GET /api/nav-badges': () => ({ status: 200, body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } } }),
    'GET /api/chat/channels': () => ({ status: 200, body: { channels: [] } }),
    'GET /api/branches': () => ({ status: 200, body: { branches: [BRANCH] } }),
    ...extra,
  };
}

function task(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    branchId: 1,
    branch: BRANCH,
    workDate: TODAY,
    roomNumber: '101',
    statusCode: 'OUT',
    areaKind: 'ROOM',
    floor: '1',
    areaLabel: 'Phòng - 101',
    taskLabel: 'OUT',
    priority: false,
    note: null,
    assignee: { id: 6, name: 'Chị Lan' },
    state: 'NOT_STARTED',
    stateLabel: 'Chưa bắt đầu',
    phase: 'ACCEPTED',
    phaseLabel: 'Đã nhận',
    startedAt: null,
    completedAt: null,
    durationSeconds: null,
    elapsedSeconds: null,
    inspection: null,
    cleaning: null,
    cleanedBy: null,
    createdByName: 'Quản lý',
    createdAt: '2026-10-05T01:00:00.000Z',
    updatedAt: '2026-10-05T01:00:00.000Z',
    voided: false,
    voidedAt: null,
    voidedByName: null,
    voidReason: null,
    cycleNumber: 1,
    reclean: null,
    review: null,
    nextCycleId: null,
    events: [],
    workGroup: { id: 'g1', number: 1, name: null },
    ...over,
  };
}

const TASKS = [
  task('a1'),
  task('a2', { roomNumber: '102', areaLabel: 'Phòng - 102', assignee: null, phase: 'UNCLAIMED', phaseLabel: 'Chưa có người nhận' }),
  task('a3', { roomNumber: '201', floor: '2', areaLabel: 'Phòng - 201', state: 'COMPLETED', stateLabel: 'Hoàn thành', phase: 'COMPLETED', phaseLabel: 'Hoàn thành', review: { status: 'PENDING', label: 'Chờ đánh giá', reviewedAt: null, reviewedByName: null, failureReason: null, recleanRequested: false } }),
  task('a4', { roomNumber: '0', areaKind: 'HALLWAY', areaKindLabel: 'Hành lang', areaLabel: 'Hành lang - Tầng 1', state: 'INSPECTED', phase: 'AWAITING_CLEANING', phaseLabel: 'Chờ dọn phòng', assignee: { id: 7, name: 'Chị Hoa' } }),
];

describe('"Công việc mỗi ngày cần làm"', () => {
  it('opens on "Tổng": today’s counts and every item with who has it and what comes next — searchable', async () => {
    installApiMock(shell(MANAGER, { [`GET /api/housekeeping/manager/tasks?date=${TODAY}&branchId=1`]: () => ({ status: 200, body: { tasks: TASKS } }) }));
    renderApp('/app/hk/daily');
    expect(await within(await screen.findByRole('main')).findByRole('heading', { level: 1, name: 'Công việc mỗi ngày cần làm' })).toBeInTheDocument();
    // One selector: the manager's five tabs, "Tổng" first and chosen.
    expect(within(screen.getByTestId('daily-tabs')).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Tổng',
      'Dọn phòng',
      'Kiểm kho',
      'Phân công ca, việc làm',
      'Phân công việc ngày hôm sau',
    ]);
    expect(screen.getByTestId('daily-tab-overview')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByTestId('daily-card-total')).toHaveTextContent('4'));
    expect(screen.getByTestId('daily-card-unassigned')).toHaveTextContent('1');
    expect(screen.getByTestId('daily-card-review')).toHaveTextContent('1');
    const table = screen.getByTestId('daily-table');
    expect(table).toHaveTextContent('Tầng 1 · Phòng 101');
    expect(table).toHaveTextContent('Kiểm phòng');
    expect(table).toHaveTextContent('Giao người làm');
    expect(table).toHaveTextContent('Đánh giá sau dọn');
    expect(table).toHaveTextContent('Bắt đầu dọn');
    await userEvent.type(screen.getByTestId('daily-search'), 'Hoa');
    await waitFor(() => expect(table).not.toHaveTextContent('Phòng 101'));
    expect(table).toHaveTextContent('Hành lang');
  });

  it('gives the Admin no "Dọn phòng" tab — it works no shift — and lands old addresses on their tab', async () => {
    installApiMock(
      shell(ADMIN_USER, {
        [`GET /api/housekeeping/manager/tasks?date=${TODAY}`]: () => ({ status: 200, body: { tasks: [] } }),
      }),
    );
    renderApp('/app/hk/daily');
    const tabs = await screen.findByTestId('daily-tabs');
    expect(within(tabs).getAllByRole('button').map((b) => b.textContent)).toEqual(['Tổng', 'Kiểm kho', 'Phân công ca, việc làm', 'Phân công việc ngày hôm sau']);
    expect(await screen.findByText('Hôm nay chưa có công việc')).toBeInTheDocument();
    // One sidebar link for the page — no duplicates of its tabs.
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getAllByRole('link', { name: 'Công việc mỗi ngày cần làm' })).toHaveLength(1);
    for (const name of ['Kiểm kho', 'Phân công ca, việc làm', 'Phân công việc ngày hôm sau', 'Dọn phòng']) {
      expect(within(nav).queryByRole('link', { name })).not.toBeInTheDocument();
    }
  });
});

describe('the reception managers’ "Công việc buồng phòng"', () => {
  it('lists today’s housekeeping work of its branches and offers "Giao lại" on an item waiting for cleaning', async () => {
    const reassigned: unknown[] = [];
    installApiMock(
      shell(RECEPTION_MANAGER, {
        [`GET /api/housekeeping/work-orders?date=${TODAY}`]: () => ({ status: 200, body: { tasks: TASKS } }),
        'GET /api/housekeeping/work-orders/staff?branchId=1': () => ({ status: 200, body: { staff: [{ id: 6, fullName: 'Chị Lan' }, { id: 7, fullName: 'Chị Hoa' }] } }),
        'POST /api/housekeeping/work-orders/a4/reassign': (init) => {
          reassigned.push(JSON.parse(String(init.body)));
          return { status: 200, body: { task: task('a4', { assignee: { id: 6, name: 'Chị Lan' } }) } };
        },
      }),
    );
    renderApp('/app/hk-work-orders');
    expect(await within(await screen.findByRole('main')).findByRole('heading', { level: 1, name: 'Công việc buồng phòng' })).toBeInTheDocument();
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getByRole('link', { name: 'Công việc buồng phòng' })).toHaveAttribute('href', '/app/hk-work-orders');
    const table = await screen.findByTestId('supervisor-work-orders');
    expect(await within(table).findByText('Hành lang - Tầng 1')).toBeInTheDocument();
    // Only the item waiting for cleaning can be given to someone else.
    expect(within(table).queryByTestId('work-reassign-a1')).not.toBeInTheDocument();
    await userEvent.click(within(table).getByTestId('work-reassign-a4'));
    const dialog = await screen.findByTestId('reassign-dialog');
    await userEvent.selectOptions(within(dialog).getByRole('combobox'), '6');
    await userEvent.click(screen.getByTestId('reassign-next'));
    await userEvent.click(await screen.findByTestId('reassign-confirm'));
    await waitFor(() => expect(reassigned).toEqual([expect.objectContaining({ assigneeUserId: 6 })]));
  });
});
