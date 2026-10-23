/**
 * "NGƯỜI XỬ LÝ" ON THE REQUEST TABLE — who a request is given to, "Nhận việc"
 * for that person, "Giao người xử lý" for whoever gives work out, and
 * "Hoàn thành" only for the current assignee (the server checks again).
 * Plus the form's "Bộ phận nhận việc" when nobody of it is on shift.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../auth/AuthProvider';
import { GuestRequestTable } from './OperationalTables';
import { GuestRequestForm } from './OperationalForms';
import { ADMIN_USER, RECEPTIONIST_USER, installApiMock } from '../test/utils';
import type { OperationalReport } from '../api/receptionReports';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TD', hotelName: 'KAS', address: '05 Trương Định', branchNumber: 1 };
const BELL_USER = { id: 21, username: 'bell1', fullName: 'Bell Một', role: 'BELL', branch: BRANCH, active: true, mustChangePassword: false };

function request(over: Partial<NonNullable<OperationalReport['guestRequest']>> = {}, id = 'r1') {
  return {
    id,
    category: 'GUEST_REQUEST',
    branchId: 1,
    branch: BRANCH,
    createdBy: { id: 2, fullName: 'Lễ tân A' },
    createdByName: 'Lễ tân A',
    createdByRole: 'RECEPTIONIST',
    sourceLabel: null,
    originDepartment: 'RECEPTION',
    createdAt: '2026-10-05T02:03:07.000Z',
    voided: false,
    audits: [],
    guestRequest: {
      guestName: 'Khách A',
      ezCode: 'EZ1',
      roomNumber: null,
      content: 'Mang thêm nước',
      note: 'Mang thêm nước',
      severity: 'MEDIUM',
      severityLabel: 'Trung bình',
      completed: false,
      completedAt: null,
      completedByName: null,
      resolution: null,
      receivingDepartment: 'BELL',
      receivingDepartmentLabel: 'Bell',
      assignee: { id: 21, name: 'Bell Một', department: 'BELL', departmentLabel: 'Bell' },
      assignedAt: '2026-10-05T02:03:07.000Z',
      acknowledgedAt: null,
      ...over,
    },
  } as unknown as OperationalReport;
}

function renderTable(user: unknown, rows: OperationalReport[], routes: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {}) {
  installApiMock({ 'GET /api/auth/me': () => ({ status: 200, body: { user } }), ...routes });
  const onChanged = vi.fn(async () => undefined);
  const onToast = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <GuestRequestTable rows={rows} onChanged={onChanged} onToast={onToast} canEdit />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onChanged, onToast };
}

describe('"Người xử lý" on the request table', () => {
  it('sits beside "Trạng thái", naming the person and department — and only that person may complete or acknowledge', async () => {
    renderTable(RECEPTIONIST_USER, [request()]);
    const table = await screen.findByTestId('guest-request-table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent).filter(Boolean);
    expect(headers.slice(headers.indexOf('Trạng thái'), headers.indexOf('Trạng thái') + 2)).toEqual(['Trạng thái', 'Người xử lý']);
    expect(await screen.findByTestId('request-assignee-r1')).toHaveTextContent('Bell Một');
    expect(screen.getByTestId('request-assignee-r1')).toHaveTextContent('Chờ nhận việc');
    // The desk is not the assignee: no "Hoàn thành", no "Nhận việc" — it reads who holds it.
    expect(screen.queryByTestId('complete-r1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('acknowledge-r1')).not.toBeInTheDocument();
    expect(screen.getByTestId('request-holder-r1')).toHaveTextContent('Bell Một xử lý');
    // A receptionist does not give work out.
    expect(screen.queryByTestId('assign-r1')).not.toBeInTheDocument();
  });

  it('lets the assignee press "Nhận việc" and "Hoàn thành"', async () => {
    const acknowledged: string[] = [];
    const { onChanged } = renderTable(BELL_USER, [request()], {
      'POST /api/reception/reports/r1/acknowledge': () => {
        acknowledged.push('r1');
        return { status: 200, body: { report: request({ acknowledgedAt: '2026-10-05T02:10:00.000Z' }) } };
      },
    });
    expect(await screen.findByTestId('complete-r1')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('acknowledge-r1'));
    await waitFor(() => expect(acknowledged).toEqual(['r1']));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('hides "Hoàn thành" from the previous holder the moment it is given to someone else', async () => {
    renderTable(BELL_USER, [request({ assignee: { id: 30, name: 'Bell Hai', department: 'BELL', departmentLabel: 'Bell' } })]);
    expect(await screen.findByTestId('request-holder-r1')).toHaveTextContent('Bell Hai xử lý');
    expect(screen.queryByTestId('complete-r1')).not.toBeInTheDocument();
  });

  it('keeps the old rule for a request given to nobody — the desk completes its own', async () => {
    renderTable(RECEPTIONIST_USER, [request({ assignee: null, receivingDepartment: null, receivingDepartmentLabel: null })]);
    expect(await screen.findByTestId('complete-r1')).toBeInTheDocument();
    expect(screen.getByTestId('request-assignee-r1')).toHaveTextContent('Chưa giao');
  });

  it('lets the Admin give it to someone on shift — and never complete it on their behalf', async () => {
    const assigned: unknown[] = [];
    renderTable(ADMIN_USER, [request()], {
      'GET /api/reception/reports/dispatch-staff?branchId=1': () => ({
        status: 200,
        body: {
          branchId: 1,
          onShift: {
            BELL: [{ id: 21, name: 'Bell Một', department: 'BELL' }],
            RECEPTION: [{ id: 2, name: 'Lễ tân A', department: 'RECEPTION' }],
            HOUSEKEEPING: [],
          },
        },
      }),
      'POST /api/reception/reports/r1/assignee': (init) => {
        assigned.push(JSON.parse(String(init.body)));
        return { status: 200, body: { report: request({ assignee: { id: 2, name: 'Lễ tân A', department: 'RECEPTION', departmentLabel: 'Lễ tân' } }) } };
      },
    });
    expect(screen.queryByTestId('complete-r1')).not.toBeInTheDocument();
    await userEvent.click(await screen.findByTestId('assign-r1'));
    const dialog = await screen.findByRole('dialog', { name: 'Giao người xử lý' });
    const select = await within(dialog).findByTestId('assign-select');
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Lễ tân A' })).toBeInTheDocument());
    await userEvent.selectOptions(select, '2');
    await userEvent.click(within(dialog).getByTestId('assign-save'));
    await waitFor(() => expect(assigned).toEqual([{ assigneeUserId: 2 }]));
  });

  it('shows who completed it, and in which department', async () => {
    renderTable(RECEPTIONIST_USER, [
      request({ completed: true, completedAt: '2026-10-05T03:00:00.000Z', completedByName: 'Bell Một', completedDepartment: 'BELL', completedDepartmentLabel: 'Bell' }),
    ]);
    expect(await screen.findByTestId('request-completed-by-r1')).toHaveTextContent('Bell Một · Bell');
  });
});

describe('"Bộ phận nhận việc" with nobody on shift', () => {
  it('says so before saving, and offers "Vẫn lưu, chờ giao" when the server refuses — never assigning someone else', async () => {
    const posted: Record<string, unknown>[] = [];
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTIONIST_USER } }),
      'GET /api/reception/reports/dispatch-staff': () => ({
        status: 200,
        body: { branchId: 1, onShift: { BELL: [], RECEPTION: [{ id: 2, name: 'Lễ tân A', department: 'RECEPTION' }], HOUSEKEEPING: [] } },
      }),
      'POST /api/reception/reports': (init) => {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        return body.allowUnassigned
          ? { status: 201, body: { report: request({ assignee: null }) } }
          : {
              status: 409,
              body: {
                error: {
                  code: 'CONFLICT',
                  message: 'Hiện không có nhân viên Bell nào đang trong ca tại chi nhánh này.',
                  details: { reason: 'NO_STAFF_ON_SHIFT', department: 'BELL' },
                },
              },
            };
      },
    });
    const onCreated = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AuthProvider>
            <GuestRequestForm onCreated={onCreated} />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByTestId('guest-request-guest'), 'Khách B');
    await userEvent.type(screen.getByTestId('guest-request-content'), 'Xách hành lý lên phòng');
    await userEvent.click(screen.getByTestId('guest-request-department-BELL'));
    // "Đang trong ca", by department — and the warning for the chosen one.
    expect(await screen.findByTestId('guest-request-on-shift')).toHaveTextContent('Bell 0 · Lễ tân 1 · Buồng phòng 0');
    expect(screen.getByTestId('guest-request-no-staff-hint')).toHaveTextContent('Hiện không có nhân viên Bell nào đang trong ca');
    await userEvent.click(screen.getByTestId('guest-request-form-add'));
    const box = await screen.findByTestId('guest-request-form-no-staff');
    expect(box).toHaveTextContent('Hiện không có nhân viên Bell nào đang trong ca tại chi nhánh này.');
    expect(onCreated).not.toHaveBeenCalled();
    await userEvent.click(within(box).getByTestId('guest-request-form-save-unassigned'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(posted).toHaveLength(2);
    expect(posted[0]).not.toHaveProperty('allowUnassigned');
    expect(posted[1]).toMatchObject({ allowUnassigned: true, guestRequest: { receivingDepartment: 'BELL' } });
  });
});
