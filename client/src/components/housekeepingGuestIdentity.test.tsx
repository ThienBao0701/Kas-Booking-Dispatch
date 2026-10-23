/**
 * A REQUEST BỘ PHẬN BUỒNG PHÒNG RECORDED, AT THE DESK — six compact columns
 * (STT, Tên khách, Mức độ, Mã EZ, Nội dung, Trạng thái): "Chưa xác định khách"
 * until Reception names one, with a small "Nhập thông tin khách" in that cell;
 * beneath the content, once, "Buồng phòng · Chị Lan · Ghi nhận: …" to the second.
 * Plus the review of a new work group, by floor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../auth/AuthProvider';
import { GuestRequestTable } from './OperationalTables';
import { HOUSEKEEPING_USER, RECEPTIONIST_USER, installApiMock } from '../test/utils';
import type { OperationalReport } from '../api/receptionReports';
import { draftsByFloor, type PlaceDraft } from '../lib/workPlaces';
import { formatHcmDateTimeSeconds } from '../lib/format';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TD', hotelName: 'KAS', address: '05 Trương Định', branchNumber: 1 };

function hkRequest(over: Partial<OperationalReport['guestRequest']> = {}) {
  return {
    id: 'r1',
    category: 'GUEST_REQUEST',
    branchId: 1,
    branch: BRANCH,
    createdBy: { id: 6, fullName: 'Chị Lan' },
    createdByName: 'Chị Lan',
    createdByRole: 'HOUSEKEEPING',
    sourceLabel: 'Buồng phòng · Chị Lan',
    originDepartment: 'HOUSEKEEPING',
    taskId: 't1',
    createdAt: '2026-10-05T02:03:07.000Z',
    voided: false,
    audits: [],
    guestRequest: {
      guestName: null,
      ezCode: null,
      roomNumber: 'Phòng - 101',
      content: 'Khách xin thêm khăn',
      note: 'Khách xin thêm khăn',
      severity: 'MEDIUM',
      severityLabel: 'Trung bình',
      completed: false,
      completedAt: null,
      completedByName: null,
      resolution: null,
      ...over,
    },
  } as unknown as OperationalReport;
}

function renderTable(
  user: unknown,
  rows: OperationalReport[],
  routes: Record<string, (init: RequestInit) => { status: number; body?: unknown }> = {},
  variant: 'detail' | 'summary' = 'detail',
) {
  installApiMock({ 'GET /api/auth/me': () => ({ status: 200, body: { user } }), ...routes });
  const onChanged = vi.fn(async () => undefined);
  const onToast = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AuthProvider>
          <GuestRequestTable rows={rows} onChanged={onChanged} onToast={onToast} canEdit variant={variant} />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onChanged, onToast };
}

describe('a Housekeeping request at the desk', () => {
  it('reads in compact columns — no room, no action column — the source and time once, beneath the content', async () => {
    renderTable(RECEPTIONIST_USER, [hkRequest()], {}, 'summary');
    const table = await screen.findByTestId('guest-request-table');
    await screen.findByTestId('identify-r1');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent).filter(Boolean)).toEqual(['STT', 'Tên khách', 'Mức độ', 'Mã EZ', 'Nội dung', 'Trạng thái', 'Người xử lý']);
    expect(table).not.toHaveTextContent('Khu vực');
    expect(table).not.toHaveTextContent('Phòng - 101');
    expect(screen.getByTestId('request-guest-r1')).toHaveTextContent('Chưa xác định khách');
    // Never the reporter or the content as the guest.
    expect(screen.getByTestId('request-guest-r1')).not.toHaveTextContent('Chị Lan');
    expect(screen.getByTestId('request-meta-r1')).toHaveTextContent('Buồng phòng · Chị Lan · Ghi nhận: 05/10/2026 09:03:07');
    // Who reported it: once in the row.
    expect(within(table).getAllByText(/Chị Lan/)).toHaveLength(1);
    expect(within(table).queryByTestId('source-tag')).not.toBeInTheDocument();
  });

  it('"Nhập thông tin khách" sends the name and Mã EZ — nothing else', async () => {
    const sent: unknown[] = [];
    const { onChanged, onToast } = renderTable(RECEPTIONIST_USER, [hkRequest()], {
      'PATCH /api/reception/reports/r1/guest': (init) => {
        sent.push(JSON.parse(String(init.body)));
        return { status: 200, body: { report: hkRequest({ guestName: 'Nguyễn Văn B', ezCode: 'EZ900' }) } };
      },
    });
    await userEvent.click(await screen.findByTestId('identify-r1'));
    const dialog = await screen.findByRole('dialog', { name: 'Nhập thông tin khách' });
    expect(within(dialog).getByTestId('identify-save')).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('identify-guest'), 'Nguyễn Văn B');
    await userEvent.type(within(dialog).getByTestId('identify-ez'), 'EZ900');
    await userEvent.click(within(dialog).getByTestId('identify-save'));
    await waitFor(() => expect(sent).toEqual([{ guestName: 'Nguyễn Văn B', ezCode: 'EZ900' }]));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Đã lưu thông tin khách.'));
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows the named guest in "Tên khách" and its code in "Mã EZ" — the source and time unchanged', async () => {
    renderTable(RECEPTIONIST_USER, [hkRequest({ guestName: 'Nguyễn Văn B', ezCode: 'EZ900' })], {}, 'summary');
    expect(await screen.findByTestId('identify-r1')).toHaveTextContent('Sửa thông tin khách');
    expect(screen.getByTestId('request-guest-r1')).toHaveTextContent(/^Nguyễn Văn B/);
    const row = screen.getByTestId('request-guest-r1').closest('tr')!;
    expect(within(row).getByText('EZ900')).toBeInTheDocument();
    expect(screen.getByTestId('request-meta-r1')).toHaveTextContent('Buồng phòng · Chị Lan · Ghi nhận: 05/10/2026 09:03:07');
  });

  it('shows Housekeeping no guest columns and no way to name one', async () => {
    renderTable(HOUSEKEEPING_USER, [hkRequest()], {}, 'summary');
    const table = await screen.findByTestId('guest-request-table');
    await waitFor(() => expect(within(table).getAllByRole('columnheader').map((h) => h.textContent).filter(Boolean)).toEqual(['STT', 'Mức độ', 'Nội dung', 'Trạng thái', 'Người xử lý']));
    expect(screen.queryByText('Chưa xác định khách')).not.toBeInTheDocument();
    expect(screen.queryByTestId('identify-r1')).not.toBeInTheDocument();
  });

  it('keeps Reception’s own request as it was — its guest, its "Admin tạo" tag beside the guest, no naming action', async () => {
    const desk = { ...hkRequest({ guestName: 'Khách lễ tân', ezCode: 'EZ1', roomNumber: null }), originDepartment: 'RECEPTION', sourceLabel: 'Admin tạo', createdByRole: 'ADMIN' } as unknown as OperationalReport;
    renderTable(RECEPTIONIST_USER, [desk], {}, 'summary');
    expect(await screen.findByTestId('request-guest-r1')).toHaveTextContent('Khách lễ tân');
    expect(within(screen.getByTestId('request-guest-r1')).getByTestId('source-tag')).toHaveTextContent('Admin tạo');
    expect(screen.getByTestId('request-meta-r1')).toHaveTextContent(/^Ghi nhận: 05\/10\/2026 09:03:07$/);
    expect(screen.queryByTestId('identify-r1')).not.toBeInTheDocument();
  });

  it('keeps the category screen’s status actions — "Cách xử lý" with the completion — after the six', async () => {
    renderTable(RECEPTIONIST_USER, [hkRequest()]);
    const table = await screen.findByTestId('guest-request-table');
    await screen.findByTestId('identify-r1');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent).filter(Boolean)).toEqual([
      'STT',
      'Tên khách',
      'Mức độ',
      'Mã EZ',
      'Nội dung',
      'Trạng thái',
      'Người xử lý',
      'Cách xử lý (nếu có)',
    ]);
    // Bộ phận buồng phòng completes its own request; the desk follows it.
    expect(within(table).getByText('Buồng phòng xử lý')).toBeInTheDocument();
  });
});

describe('the pure pieces', () => {
  it('formats a time in Asia/Ho_Chi_Minh with seconds', () => {
    expect(formatHcmDateTimeSeconds('2026-10-21T17:00:05.000Z')).toBe('22/10/2026 00:00:05');
    expect(formatHcmDateTimeSeconds(null)).toBe('—');
  });

  it('groups a new work group’s places by floor — a common area under its floor, an unknown floor in its own labelled section', () => {
    const d = (key: string, groupLabel: string, label: string): PlaceDraft => ({ key, section: 1, areaKind: 'ROOM', groupLabel, label, codes: ['OUT'], note: '' });
    const groups = draftsByFloor([
      d('ROOM:101', 'Tầng 1', 'Phòng 101'),
      d('ROOM:201', 'Tầng 2', 'Phòng 201'),
      { ...d('HALLWAY:1', 'Tầng 1', 'Hành lang'), areaKind: 'HALLWAY', codes: [] },
      d('ROOM:X1', 'Phòng chưa xác định tầng', 'Phòng X1'),
      d('ROOM:X2', ' ', 'Phòng X2'),
    ]);
    expect(groups.map((g) => [g.heading, g.places.map((p) => p.label)])).toEqual([
      ['Tầng 1', ['Phòng 101', 'Hành lang']],
      ['Tầng 2', ['Phòng 201']],
      ['Phòng chưa xác định tầng', ['Phòng X1']],
      ['Chưa xác định tầng', ['Phòng X2']],
    ]);
  });
});
