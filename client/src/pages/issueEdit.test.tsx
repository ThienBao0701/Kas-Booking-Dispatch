/**
 * "SỬA VẤN ĐỀ" — reception corrects an open incident from the facility board.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. Every open incident has one "Sửa vấn đề" action; a completed one has none.
 *   2. The dialog is the report form, filled with what is stored, and says the
 *      report time, status and repair history are kept.
 *   3. Save is enabled only for a real change; it sends the fields the area asks
 *      for and nulls the ones it does not.
 *   4. A legacy report (no area) can only have its description corrected.
 *   5. The repair history and the edit history are one click down at any width.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';
import { withLifecycle } from '../test/issueFixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SESSION = {
  id: 's1',
  branchId: 1,
  shiftType: 'A',
  shiftName: 'Ca A',
  shiftWindow: '06:00 – 14:00',
  receptionistName: 'Nguyễn Văn A',
  startedAt: '2026-09-18T23:00:00.000Z',
  nominalEndAt: '2026-09-19T07:00:00.000Z',
  graceEndAt: '2026-09-19T07:10:00.000Z',
  closedAt: null,
  promptDue: false,
};

function issue(id: string, over: Record<string, unknown> = {}) {
  return withLifecycle({
    id,
    branchId: 1,
    branch: null,
    areaCategory: 'ROOM',
    roomNumber: '301',
    floorNumber: null,
    areaSubtype: null,
    locationDetail: null,
    locationLabel: 'Phòng · Phòng 301',
    category: 'AIR_CONDITIONER',
    description: 'Máy lạnh không mát',
    photoUrl: null,
    status: 'NEW',
    needsRework: false,
    reportedByName: 'Nguyễn Văn A',
    technicianName: null,
    technicianPhone: null,
    completedAt: null,
    createdAt: '2026-09-19T02:00:00.000Z',
    updatedAt: '2026-09-19T02:00:00.000Z',
    attempts: [],
    edits: [],
    ...over,
  });
}

type Handler = (init: RequestInit) => { status: number; body?: unknown };

function routes(issues: unknown[], extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
    'GET /api/notifications/unread-count': () => ({ status: 200, body: { count: 0 } }),
    'GET /api/issues/summary': () => ({
      status: 200,
      body: { summary: { totalUnresolved: 0, newCount: 0, inProgressCount: 0, byBranch: [] } },
    }),
    'GET /api/nav-badges': () => ({
      status: 200,
      body: { counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } },
    }),
    'GET /api/chat/channels': () => ({ status: 200, body: { channels: [] } }),
    'GET /api/reception/shifts/current': () => ({ status: 200, body: { session: SESSION } }),
    'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: [] } }),
    'GET /api/reception/reports/options': () => ({
      status: 200,
      body: {
        categories: [],
        paymentMethods: [],
        roomServiceTypes: [],
        paymentSources: [],
        deliveryDepartments: [],
        deliveryTitle: 'Giao nhận hàng hóa của khách sạn',
        deliveryArchiveHours: 12,
      },
    }),
    'GET /api/reception/reports?shiftSessionId=s1': () => ({
      status: 200,
      body: { reports: [], counts: { PAYMENT: 0, GUEST_REQUEST: 0, FACILITY_ISSUE: 0, CUSTOMER_COMPLAINT: 0, ROOM_SERVICE: 0, HOTEL_DELIVERY: 0 } },
    }),
    'GET /api/reception/shifts/cash': () => ({ status: 200, body: { cash: { openingCash: null, cashCollected: 0, transferCollected: 0, cardCollected: 0, receivable: 0, cashExpense: 0, endingCash: null, paymentCount: 0, voidedCount: 0 } } }),
    'GET /api/hotel-deliveries?scope=active': () => ({ status: 200, body: { scope: 'active', deliveries: [] } }),
        'GET /api/reception/reports/active': () => ({
      status: 200,
      body: { reports: [], totals: { GUEST_REQUEST: 0, CUSTOMER_COMPLAINT: 0 }, archiveAfterHours: 12 },
    }),
    'GET /api/issues?scope=active&pageSize=100': () => ({
      status: 200,
      body: { issues, pagination: { page: 1, pageSize: 100, total: issues.length, totalPages: 1 } },
    }),
    ...extra,
  };
}

async function openBoard() {
  renderApp('/app/reports?category=FACILITY_ISSUE');
  return screen.findByTestId('facility-board');
}

describe('the "Sửa vấn đề" action', () => {
  it('is on every open incident, and not on a completed one', async () => {
    installApiMock(
      routes([
        issue('i1'),
        issue('i2', { status: 'IN_PROGRESS', technicianName: 'Bảo' }),
        issue('i3', { status: 'COMPLETED', completedAt: '2026-09-19T05:00:00.000Z' }),
      ]),
    );
    const board = await openBoard();
    await within(board).findByTestId('edit-issue-i1');

    expect(within(board).getByTestId('edit-issue-i1')).toHaveTextContent('Sửa vấn đề');
    expect(within(board).getByTestId('edit-issue-i2')).toBeInTheDocument();
    expect(within(board).queryByTestId('edit-issue-i3')).not.toBeInTheDocument();
    // The old column is gone.
    expect(within(board).queryByText('Lần sửa')).not.toBeInTheDocument();
  });
});

describe('the dialog', () => {
  it('is the report form filled with what is stored, and says what is kept', async () => {
    installApiMock(routes([issue('i1')]));
    const board = await openBoard();
    await userEvent.click(await within(board).findByTestId('edit-issue-i1'));

    const dialog = await screen.findByRole('dialog', { name: 'Sửa vấn đề' });
    expect(within(dialog).getByLabelText('Khu vực')).toHaveValue('ROOM');
    expect(within(dialog).getByPlaceholderText('Ví dụ: 301')).toHaveValue('301');
    expect(within(dialog).getByLabelText('Loại sự cố')).toHaveValue('AIR_CONDITIONER');
    expect(within(dialog).getByLabelText('Sự cố')).toHaveValue('Máy lạnh không mát');
    expect(dialog).toHaveTextContent('Thời gian báo cáo, trạng thái và lịch sử sửa chữa được giữ nguyên');
    // Nothing that belongs to the repair is editable here.
    expect(within(dialog).queryByText(/Kỹ thuật viên|Trạng thái|Tiếp nhận/)).not.toBeInTheDocument();
  });

  it('saves only a real change', async () => {
    installApiMock(routes([issue('i1')]));
    const board = await openBoard();
    await userEvent.click(await within(board).findByTestId('edit-issue-i1'));
    const dialog = await screen.findByRole('dialog', { name: 'Sửa vấn đề' });

    expect(within(dialog).getByTestId('edit-issue-save')).toBeDisabled();
    const description = within(dialog).getByLabelText('Sự cố');
    await userEvent.type(description, ' — rò nước');
    expect(within(dialog).getByTestId('edit-issue-save')).toBeEnabled();
    await userEvent.clear(description);
    expect(within(dialog).getByTestId('edit-issue-save')).toBeDisabled();
  });

  it('sends the corrected fields, and the ones the area does not use as null', async () => {
    const put: Record<string, unknown>[] = [];
    installApiMock(
      routes([issue('i1')], {
        'PUT /api/issues/i1': (init) => {
          put.push(JSON.parse(String(init.body)));
          return { status: 200, body: { issue: issue('i1') } };
        },
      }),
    );
    const board = await openBoard();
    await userEvent.click(await within(board).findByTestId('edit-issue-i1'));
    const dialog = await screen.findByRole('dialog', { name: 'Sửa vấn đề' });

    // A room becomes a hallway: the room number and the fault type stop applying.
    await userEvent.selectOptions(within(dialog).getByLabelText('Khu vực'), 'HALLWAY');
    await userEvent.type(within(dialog).getByPlaceholderText('Ví dụ: 3'), '3');
    await userEvent.click(within(dialog).getByTestId('edit-issue-save'));

    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0]).toEqual({
      areaCategory: 'HALLWAY',
      description: 'Máy lạnh không mát',
      category: null,
      roomNumber: null,
      floorNumber: '3',
      areaSubtype: null,
      locationDetail: null,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('will not save a room report with no room number', async () => {
    installApiMock(routes([issue('i1')]));
    const board = await openBoard();
    await userEvent.click(await within(board).findByTestId('edit-issue-i1'));
    const dialog = await screen.findByRole('dialog', { name: 'Sửa vấn đề' });

    await userEvent.clear(within(dialog).getByPlaceholderText('Ví dụ: 301'));
    await userEvent.type(within(dialog).getByLabelText('Sự cố'), '!');
    expect(within(dialog).getByTestId('edit-issue-save')).toBeDisabled();
  });

  it('lets a legacy report correct its description and nothing else', async () => {
    const put: Record<string, unknown>[] = [];
    installApiMock(
      routes([issue('old', { areaCategory: null, roomNumber: '12', locationLabel: 'Phòng 12', category: null })], {
        'PUT /api/issues/old': (init) => {
          put.push(JSON.parse(String(init.body)));
          return { status: 200, body: { issue: issue('old') } };
        },
      }),
    );
    const board = await openBoard();
    await userEvent.click(await within(board).findByTestId('edit-issue-old'));
    const dialog = await screen.findByRole('dialog', { name: 'Sửa vấn đề' });

    // It was never asked where it was, and is not asked now.
    expect(within(dialog).queryByLabelText('Khu vực')).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox'), ' (đã kiểm tra)');
    await userEvent.click(within(dialog).getByTestId('edit-issue-save'));
    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0]).toEqual({ description: 'Máy lạnh không mát (đã kiểm tra)' });
  });

  it('shows the server’s refusal in the dialog and keeps it open', async () => {
    installApiMock(
      routes([issue('i1')], {
        'PUT /api/issues/i1': () => ({
          status: 409,
          body: { error: { code: 'CONFLICT', message: 'Không thể sửa sự cố đã hoàn thành.' } },
        }),
      }),
    );
    const board = await openBoard();
    await userEvent.click(await within(board).findByTestId('edit-issue-i1'));
    const dialog = await screen.findByRole('dialog', { name: 'Sửa vấn đề' });
    await userEvent.type(within(dialog).getByLabelText('Sự cố'), '!');
    await userEvent.click(within(dialog).getByTestId('edit-issue-save'));
    expect(await within(dialog).findByText(/Không thể sửa sự cố đã hoàn thành/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Sửa vấn đề' })).toBeInTheDocument();
  });

  it('Hủy closes it without sending anything', async () => {
    const fetchMock = installApiMock(routes([issue('i1')]));
    const board = await openBoard();
    await userEvent.click(await within(board).findByTestId('edit-issue-i1'));
    await userEvent.click(await screen.findByTestId('edit-issue-cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(false);
  });
});

describe('the history, one click down', () => {
  it('shows what was corrected, by whom and when, beside the repair history', async () => {
    installApiMock(
      routes([
        issue('i1', {
          edits: [
            {
              id: 'e1',
              field: 'roomNumber',
              fieldLabel: 'Số phòng',
              oldValue: '301',
              newValue: '302',
              actorName: 'Lễ tân Một',
              createdAt: '2026-09-19T03:00:00.000Z',
            },
          ],
          attempts: [
            {
              id: 'a1',
              attemptNumber: 1,
              technicianName: 'Minh',
              technicianPhone: '0909000222',
              acceptedByName: 'Minh',
              acceptedAt: '2026-09-19T02:10:00.000Z',
              outcome: 'CANNOT_REPAIR',
              outcomeAt: '2026-09-19T02:40:00.000Z',
              reason: 'Thiếu phụ tùng',
              durationSeconds: 1800,
              durationLabel: '30 phút',
            },
          ],
        }),
      ]),
    );
    const board = await openBoard();
    await userEvent.click(await within(board).findByTestId('row-toggle-i1'));

    const detail = await within(board).findByTestId('row-detail-i1');
    expect(within(detail).getByTestId('issue-timeline')).toHaveTextContent('Thiếu phụ tùng');
    const history = within(detail).getByTestId('issue-edit-history');
    expect(history).toHaveTextContent('Số phòng: 301 → 302');
    expect(history).toHaveTextContent('Lễ tân Một');
  });

  it('shows no edit history for an incident that was never corrected', async () => {
    installApiMock(routes([issue('i1')]));
    const board = await openBoard();
    await userEvent.click(await within(board).findByTestId('row-toggle-i1'));
    const detail = await within(board).findByTestId('row-detail-i1');
    expect(within(detail).queryByTestId('issue-edit-history')).not.toBeInTheDocument();
  });
});
