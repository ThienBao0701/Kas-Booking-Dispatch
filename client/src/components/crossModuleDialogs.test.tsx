/**
 * THE CROSS-MODULE SUPERVISION DIALOGS — what each one sends, and what it refuses
 * to send.
 *
 *   1. "Xóa" (VoidDialog, delete mode): a danger confirmation that needs a reason.
 *   2. "Sửa bản ghi": a Quản lý lễ tân correcting the desk's record must give a
 *      reason; the Admin keeps it optional.
 *   3. "Lịch sử xóa": who created, who deleted (with the role), when and why.
 *   4. "Nhập bù": branch → date → finished shift → category → reason, and only
 *      then the form, which posts to the late-entry endpoint with the shift.
 *   5. "Giao việc" / "Thuê ngoài" / "Hoàn thành thuê ngoài": required notes,
 *      phone and company checks, and the required repair cost (0 allowed).
 *
 * The server checks all of it again; these prove the screens do not send what
 * it would refuse, and send exactly what it expects.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AuthProvider } from '../auth/AuthProvider';
import type { AuthUser } from '../auth/types';
import type { Issue } from '../api/issues';
import type { OperationalReport } from '../api/receptionReports';
import { ADMIN_USER, installApiMock } from '../test/utils';
import { RecordEditDialog, VoidDialog } from './RecordDialogs';
import { DeletedHistoryDialog, LateEntryDialog } from './ReportManagementDialogs';
import { CompleteExternalDialog, ExternalDispatchDialog, GiveWorkDialog } from './TechnicalDispatchDialogs';
import { phoneProblem } from '../lib/contractorPhone';

afterEach(() => {
  vi.unstubAllGlobals();
});

const RECEPTION_MANAGER: AuthUser = {
  id: 20,
  username: 'qllt',
  fullName: 'Quản lý Lan',
  role: 'RECEPTION_MANAGER',
  branch: null,
  active: true,
  mustChangePassword: false,
};

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>,
  );
}

const body = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;

const BRANCH = { id: 11, code: 'TRUONG_DINH_05', hotelName: 'KAS A', address: '05 Trương Định', branchNumber: 1, active: true };

const REPORT = {
  id: 'g1',
  branchId: 11,
  branch: BRANCH,
  category: 'GUEST_REQUEST',
  categoryLabel: 'Vấn đề khách yêu cầu',
  summary: 'Khách Minh · Thêm gối',
  shiftSessionId: 's1',
  shiftType: 'A',
  shiftName: 'Ca A',
  shiftWindow: '06:00 – 14:00',
  shiftDate: '2026-10-05',
  shiftClosed: true,
  createdBy: { id: 2, fullName: 'Lễ tân Một' },
  createdByName: 'Nguyễn A',
  createdByRole: 'RECEPTIONIST',
  createdAt: '2026-10-05T01:00:00.000Z',
  updatedAt: '2026-10-05T01:00:00.000Z',
  voided: false,
  voidedAt: null,
  voidedBy: null,
  voidedByName: null,
  voidReason: null,
  payment: null,
  guestRequest: { guestName: 'Khách Minh', ezCode: null, note: 'Thêm gối' },
  facility: null,
  complaint: null,
  roomService: null,
  delivery: null,
  audits: [],
} as unknown as OperationalReport;

const EDIT_FIELDS = [{ name: 'note', label: 'Nội dung', kind: 'textarea' as const, required: true }];

describe('Xóa — the supervisor confirmation', () => {
  it('says it is a deletion, needs a reason, and sends it once confirmed', async () => {
    const sent: unknown[] = [];
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'POST /api/reception/reports/g1/void': (init) => {
        sent.push(body(init));
        return { status: 200, body: { report: { ...REPORT, voided: true } } };
      },
    });
    const onVoided = vi.fn();
    wrap(<VoidDialog id="g1" mode="delete" onClose={() => undefined} onVoided={onVoided} />);

    expect(screen.getByRole('heading', { name: 'Xóa bản ghi' })).toBeInTheDocument();
    expect(screen.getByText(/Lịch sử xóa/)).toBeInTheDocument();
    const confirm = screen.getByTestId('void-confirm');
    expect(confirm).toHaveTextContent('Xác nhận xóa');
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByTestId('void-reason'), 'Nhập trùng');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(onVoided).toHaveBeenCalledTimes(1));
    expect(sent).toEqual([{ reason: 'Nhập trùng' }]);
  });
});

describe('Sửa bản ghi — the edit reason', () => {
  it('a Quản lý lễ tân cannot save the desk’s record without a reason', async () => {
    const sent: Record<string, unknown>[] = [];
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTION_MANAGER } }),
      'PATCH /api/reception/reports/g1': (init) => {
        sent.push(body(init));
        return { status: 200, body: { report: REPORT } };
      },
    });
    const onSaved = vi.fn();
    wrap(<RecordEditDialog report={REPORT} fields={EDIT_FIELDS} block="guestRequest" onClose={() => undefined} onSaved={onSaved} />);

    expect(await screen.findByTestId('record-edit-reason-required')).toBeInTheDocument();
    expect(screen.getByText('Lý do sửa (bắt buộc)')).toBeInTheDocument();
    const save = screen.getByTestId('record-edit-save');
    expect(save).toBeDisabled();

    await userEvent.type(screen.getByTestId('record-edit-reason'), 'Sai nội dung');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(sent[0]).toMatchObject({ reason: 'Sai nội dung', guestRequest: { note: 'Thêm gối' } });
  });

  it('the Admin keeps the optional reason', async () => {
    installApiMock({ 'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }) });
    wrap(<RecordEditDialog report={REPORT} fields={EDIT_FIELDS} block="guestRequest" onClose={() => undefined} onSaved={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('record-edit-save')).toBeEnabled());
    expect(screen.queryByTestId('record-edit-reason-required')).not.toBeInTheDocument();
  });
});

describe('Lịch sử xóa', () => {
  it('lists each deleted record with its creator, original shift, and who deleted it in what role', async () => {
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/reception/reports/deleted?from=2026-10-05&to=2026-10-05&branchId=11': () => ({
        status: 200,
        body: {
          reports: [
            {
              ...REPORT,
              voided: true,
              voidedAt: '2026-10-05T05:00:00.000Z',
              voidedByName: 'Quản lý Lan',
              voidedByRole: 'RECEPTION_MANAGER',
              voidedByRoleLabel: 'Quản lý lễ tân',
              voidReason: 'Nhập trùng',
            },
          ],
        },
      }),
    });
    wrap(
      <DeletedHistoryDialog
        period={{ from: '2026-10-05', to: '2026-10-05' }}
        branchId={11}
        labelOf={() => 'Vấn đề khách yêu cầu'}
        onClose={() => undefined}
      />,
    );
    const row = await screen.findByTestId('deleted-g1');
    expect(row).toHaveTextContent('05/10/2026 · Ca A');
    expect(row).toHaveTextContent('Người tạo: Nguyễn A');
    expect(row).toHaveTextContent('Xóa bởi Quản lý Lan (Quản lý lễ tân)');
    expect(row).toHaveTextContent('Nhập trùng');
  });
});

describe('Nhập bù', () => {
  it('opens the form only after shift, category and reason, and files it on the chosen shift', async () => {
    const sent: Record<string, unknown>[] = [];
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: RECEPTION_MANAGER } }),
      'GET /api/reception/reports/late-entry/sessions?branchId=11&date=2026-10-05': () => ({
        status: 200,
        body: {
          sessions: [
            {
              id: 's9',
              branchId: 11,
              businessDate: '2026-10-05',
              shiftType: 'A',
              shiftName: 'Ca A',
              shiftWindow: '06:00 – 14:00',
              receptionist: { id: 2, name: 'Nguyễn A' },
              startedAt: '2026-10-04T23:00:00.000Z',
              closedAt: '2026-10-05T07:00:00.000Z',
            },
          ],
        },
      }),
      'POST /api/reception/reports/late-entry': (init) => {
        sent.push(body(init));
        return { status: 201, body: { report: REPORT } };
      },
    });
    const onCreated = vi.fn();
    wrap(
      <LateEntryDialog
        branches={[BRANCH]}
        labelOf={(c) => (c === 'GUEST_REQUEST' ? 'Vấn đề khách yêu cầu' : c)}
        onClose={() => undefined}
        onCreated={onCreated}
      />,
    );

    await userEvent.selectOptions(screen.getByTestId('late-branch'), '11');
    await userEvent.type(screen.getByTestId('late-date'), '2026-10-05');
    await userEvent.click(await screen.findByTestId('late-session-s9'));
    // An incident is reported live — never a late entry.
    expect(screen.queryByTestId('late-category-FACILITY_ISSUE')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('late-category-GUEST_REQUEST'));
    expect(screen.getByTestId('late-reason-first')).toBeInTheDocument();
    expect(screen.queryByTestId('guest-request-form')).not.toBeInTheDocument();

    await userEvent.type(screen.getByTestId('late-reason'), 'Lễ tân quên ghi');
    const form = await screen.findByTestId('guest-request-form');
    await userEvent.type(within(form).getByTestId('guest-request-guest'), 'Khách Minh');
    await userEvent.type(within(form).getByTestId('guest-request-content'), 'Thêm gối');
    await userEvent.click(within(form).getByTestId('guest-request-form-add'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      category: 'GUEST_REQUEST',
      shiftSessionId: 's9',
      reason: 'Lễ tân quên ghi',
      guestRequest: { guestName: 'Khách Minh', note: 'Thêm gối' },
    });
    // The branch comes from the shift, never from the client.
    expect(sent[0]).not.toHaveProperty('branchId');
    expect(onCreated.mock.calls[0]![0]).toContain('Nguyễn A');
  });
});

const ISSUE = {
  id: 'i1',
  branchId: 11,
  branch: BRANCH,
  locationLabel: 'Phòng 301',
  description: 'Máy lạnh chảy nước',
  externalWork: { contractor: { name: 'Điện lạnh Phát', company: 'Công ty Phát', typeLabel: 'Công ty' } },
} as unknown as Issue;

describe('Giao việc — Tổng quản lý kỹ thuật', () => {
  it('A. Nhân sự needs a manager and instructions', async () => {
    const sent: Record<string, unknown>[] = [];
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/issues/managers?branchId=11': () => ({ status: 200, body: { managers: [{ id: 7, fullName: 'QLKT Hùng' }] } }),
      'POST /api/issues/i1/dispatch-manager': (init) => {
        sent.push(body(init));
        return { status: 200, body: { issue: ISSUE } };
      },
    });
    const onDone = vi.fn();
    wrap(<GiveWorkDialog issue={ISSUE} onClose={() => undefined} onDone={onDone} />);

    const confirm = screen.getByTestId('give-work-confirm');
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByTestId('give-work-MANAGER'));
    await screen.findByRole('option', { name: 'QLKT Hùng' });
    await userEvent.selectOptions(screen.getByTestId('give-work-person'), '7');
    // A manager without instructions is not a hand-off.
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByTestId('give-work-note'), 'Kiểm tra trước 15:00');
    await userEvent.click(confirm);

    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Đã giao việc cho quản lý kỹ thuật QLKT Hùng.'));
    expect(sent).toEqual([{ managerUserId: 7, note: 'Kiểm tra trước 15:00' }]);
  });

  it('B. Kĩ thuật assigns an in-house technician; the note is optional', async () => {
    const sent: Record<string, unknown>[] = [];
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'GET /api/issues/technicians': () => ({ status: 200, body: { technicians: [{ id: 4, fullName: 'Kỹ thuật Tâm' }] } }),
      'POST /api/issues/i1/assign': (init) => {
        sent.push(body(init));
        return { status: 200, body: { issue: ISSUE } };
      },
    });
    const onDone = vi.fn();
    wrap(<GiveWorkDialog issue={ISSUE} onClose={() => undefined} onDone={onDone} />);
    await userEvent.click(screen.getByTestId('give-work-TECHNICIAN'));
    await screen.findByRole('option', { name: 'Kỹ thuật Tâm' });
    await userEvent.selectOptions(screen.getByTestId('give-work-person'), '4');
    await userEvent.click(screen.getByTestId('give-work-confirm'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(sent).toEqual([{ technicianUserId: 4 }]);
  });
});

describe('Thuê ngoài — Quản lý kỹ thuật', () => {
  it('the phone rule matches the server: 8–15 digits, phone punctuation only', () => {
    expect(phoneProblem('')).toBe('Vui lòng nhập số điện thoại.');
    expect(phoneProblem('0903 123 456')).toBeNull();
    expect(phoneProblem('+84 (90) 312-3456')).toBeNull();
    expect(phoneProblem('1234567')).toBe('Số điện thoại không hợp lệ.');
    expect(phoneProblem('09031234ab')).toBe('Số điện thoại không hợp lệ.');
    expect(phoneProblem('1234567890123456')).toBe('Số điện thoại không hợp lệ.');
  });

  it('refuses an invalid phone and a company without its name, then sends the contractor', async () => {
    const sent: Record<string, unknown>[] = [];
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'POST /api/issues/i1/dispatch-external': (init) => {
        sent.push(body(init));
        return { status: 200, body: { issue: ISSUE } };
      },
    });
    const onDone = vi.fn();
    wrap(<ExternalDispatchDialog issue={ISSUE} onClose={() => undefined} onDone={onDone} />);

    await userEvent.click(screen.getByTestId('external-type-COMPANY'));
    await userEvent.type(screen.getByTestId('external-name'), 'Anh Phát');
    await userEvent.type(screen.getByTestId('external-phone'), '12ab');
    await userEvent.type(screen.getByTestId('external-specialty'), 'Điện lạnh');
    await userEvent.type(screen.getByTestId('external-note'), 'Thay ống thoát nước');
    await userEvent.click(screen.getByTestId('external-confirm'));
    expect(screen.getByText('Số điện thoại không hợp lệ.')).toBeInTheDocument();
    expect(screen.getByText('Vui lòng nhập tên công ty.')).toBeInTheDocument();
    expect(sent).toEqual([]);

    await userEvent.clear(screen.getByTestId('external-phone'));
    await userEvent.type(screen.getByTestId('external-phone'), '0903 123 456');
    await userEvent.type(screen.getByTestId('external-company'), 'Công ty Phát');
    await userEvent.click(screen.getByTestId('external-confirm'));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(sent).toEqual([
      {
        name: 'Anh Phát',
        phone: '0903 123 456',
        specialty: 'Điện lạnh',
        type: 'COMPANY',
        company: 'Công ty Phát',
        note: 'Thay ống thoát nước',
      },
    ]);
  });
});

describe('Hoàn thành thuê ngoài', () => {
  it('requires the repair cost, accepts 0, and sends it', async () => {
    const sent: Record<string, unknown>[] = [];
    installApiMock({
      'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }),
      'POST /api/issues/i1/complete-external': (init) => {
        sent.push(body(init));
        return { status: 200, body: { issue: ISSUE } };
      },
    });
    const onDone = vi.fn();
    wrap(<CompleteExternalDialog issue={ISSUE} onClose={() => undefined} onDone={onDone} />);

    expect(screen.getByTestId('complete-external')).toHaveTextContent('Điện lạnh Phát — Công ty Phát');
    const confirm = screen.getByTestId('complete-external-confirm');
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByTestId('complete-external-cost'), '0');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(sent).toEqual([{ repairCost: 0, verdict: 'CORRECT' }]);
  });
});
