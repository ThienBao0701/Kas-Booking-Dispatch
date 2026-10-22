/**
 * "VII. BÁO CÁO CÁC VẤN ĐỀ VÀ TÌNH HÌNH QUAN TRỌNG" — on screen.
 *
 *   1. A receptionist sends: one of exactly four kinds, the content, and the
 *      superiors the SERVER offers — one checkbox per role, the Admin an
 *      ordinary, selectable choice. It sees no list of what it sent. A manager
 *      is offered the Tổng quản lí and the Admin; the Tổng quản lí the Admin.
 *   2. A manager reads its inbox — "Chưa đọc" / "Đã đọc" — and opening a report
 *      shows it in full and marks it read for this reader.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RECEPTIONIST_USER, installApiMock, renderApp } from '../test/utils';
import type { ConfidentialRecipient } from '../api/confidentialReports';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Handler = (init: RequestInit) => { status: number; body?: unknown };

const recipientLabels = () =>
  within(screen.getByTestId('confidential-recipients'))
    .getAllByRole('checkbox')
    .map((b) => b.closest('label')!.textContent);

const MANAGER_USER = {
  id: 9,
  username: 'quanly',
  fullName: 'Quản lý Một',
  role: 'RECEPTION_MANAGER',
  branch: null,
  managedBranchIds: [1],
  active: true,
  mustChangePassword: false,
};

const CATEGORIES = [
  { code: 'WORK_ENVIRONMENT', label: 'Môi trường làm việc' },
  { code: 'PROCESS_RULES', label: 'Quy trình, quy định' },
  { code: 'COLLEAGUES', label: 'Đồng nghiệp, nhân viên' },
  { code: 'OTHER_IMPORTANT', label: 'Các vấn đề tình hình quan trọng khác' },
];

function shell(user: unknown, extra: Record<string, Handler> = {}): Record<string, Handler> {
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
    'GET /api/reception/shifts/current': () => ({
      status: 200,
      body: {
        session: {
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
        },
      },
    }),
    'GET /api/reception/shifts/options': () => ({ status: 200, body: { shifts: [] } }),
    ...extra,
  };
}

function report(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    category: 'COLLEAGUES',
    categoryLabel: 'Đồng nghiệp, nhân viên',
    sender: { id: 2, name: 'Lễ tân Một', role: 'RECEPTIONIST', roleLabel: 'Lễ tân' },
    branch: { id: 1, branchNumber: 1, address: '05 Trương Định' },
    createdAt: '2026-10-05T03:00:00.000Z',
    preview: 'Đồng nghiệp ca C thường xuyên đến muộn',
    recipients: [
      { id: 9, name: 'Quản lý Một', roleLabel: 'Quản lý lễ tân', always: false },
      { id: 1, name: 'Quản trị viên', roleLabel: 'Admin', always: true },
    ],
    read: false,
    readAt: null,
    ...over,
  };
}

describe('sending a confidential report', () => {
  it('offers exactly four kinds, the server’s superiors by role, and sends once — the Admin selectable', async () => {
    const sent: unknown[] = [];
    installApiMock(
      shell(RECEPTIONIST_USER, {
        'GET /api/confidential-reports/options': () => ({
          status: 200,
          body: {
            title: 'Báo cáo các vấn đề và tình hình quan trọng',
            categories: CATEGORIES,
            canSend: true,
            canRead: false,
            recipientRoles: ['RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER', 'ADMIN'],
            recipients: [
              { id: 9, fullName: 'Quản lý Một', role: 'RECEPTION_MANAGER', roleLabel: 'Quản lý lễ tân', always: false },
              { id: 10, fullName: 'Tổng quản lý', role: 'RECEPTION_GENERAL_MANAGER', roleLabel: 'Tổng quản lý', always: false },
              { id: 1, fullName: 'Quản trị viên', role: 'ADMIN', roleLabel: 'Admin', always: true },
              // A second Admin account is still ONE "Admin" checkbox.
              { id: 2, fullName: 'Admin Hai', role: 'ADMIN', roleLabel: 'Admin', always: true },
            ],
          },
        }),
        'POST /api/confidential-reports': (init) => {
          sent.push(JSON.parse(String(init.body)));
          return { status: 201, body: { report: { id: 'x1', createdAt: '2026-10-05T03:00:00.000Z' } } };
        },
      }),
    );
    renderApp('/app/reports/confidential');

    // The page heading carries no "VII." — it reads exactly as the menu does (the topbar repeats it).
    expect((await screen.findAllByRole('heading', { name: 'Báo cáo các vấn đề và tình hình quan trọng' })).length).toBeGreaterThan(0);
    expect(screen.queryByText(/VII\./)).not.toBeInTheDocument();
    // The sender has no list of what it sent — only the note and the button.
    expect(await screen.findByTestId('confidential-sender-note')).toBeInTheDocument();
    expect(screen.queryByTestId('confidential-inbox')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('confidential-new'));
    const kinds = await screen.findByTestId('confidential-categories');
    expect(within(kinds).getAllByRole('button').map((b) => b.textContent?.replace(/^\d/, ''))).toEqual(CATEGORIES.map((c) => c.label));
    await userEvent.click(screen.getByTestId('confidential-category-COLLEAGUES'));
    expect(screen.getByTestId('confidential-chosen')).toHaveTextContent('Đồng nghiệp, nhân viên');

    // Exactly three choices, nearest first — every one unticked and selectable.
    expect(recipientLabels()).toEqual(['Quản lí lễ tân (Giám sát)', 'Tổng quản lí lễ tân', 'Admin']);
    for (const box of within(screen.getByTestId('confidential-recipients')).getAllByRole('checkbox')) {
      expect(box).toBeEnabled();
      expect(box).not.toBeChecked();
    }
    expect(screen.queryByText(/Admin luôn nhận/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('confidential-recipient-ADMIN'));
    expect(screen.getByTestId('confidential-recipient-ADMIN')).toBeChecked();
    await userEvent.click(screen.getByTestId('confidential-recipient-ADMIN'));
    expect(screen.getByTestId('confidential-recipient-ADMIN')).not.toBeChecked();

    expect(screen.getByTestId('confidential-send')).toBeDisabled();
    await userEvent.type(screen.getByTestId('confidential-content'), 'Đồng nghiệp ca C thường xuyên đến muộn');
    await userEvent.click(screen.getByTestId('confidential-recipient-RECEPTION_MANAGER'));
    await userEvent.click(screen.getByTestId('confidential-send'));
    // The Admin unticked is simply not named — the server adds it anyway.
    await waitFor(() =>
      expect(sent).toEqual([{ category: 'COLLEAGUES', content: 'Đồng nghiệp ca C thường xuyên đến muộn', recipientIds: [9] }]),
    );
    expect(await screen.findByText('Đã gửi báo cáo tới cấp trên.')).toBeInTheDocument();
  });
});

describe('the "Gửi đến" choices follow the sender’s level', () => {
  const offer = (user: unknown, recipients: ConfidentialRecipient[], sent: unknown[], roles: string[]) =>
    installApiMock(
      shell(user, {
        'GET /api/confidential-reports/options': () => ({
          status: 200,
          body: { title: 'x', categories: CATEGORIES, canSend: true, canRead: true, recipients, recipientRoles: roles },
        }),
        'GET /api/confidential-reports': () => ({ status: 200, body: { reports: [], counts: { unread: 0, read: 0 } } }),
        'POST /api/confidential-reports': (init) => {
          sent.push(JSON.parse(String(init.body)));
          return { status: 201, body: { report: { id: 'x1', createdAt: '2026-10-05T03:00:00.000Z' } } };
        },
      }),
    );

  async function compose() {
    renderApp('/app/reports/confidential');
    await userEvent.click(await screen.findByTestId('confidential-new'));
    await userEvent.click(await screen.findByTestId('confidential-category-PROCESS_RULES'));
    await userEvent.type(screen.getByTestId('confidential-content'), 'Quy trình bàn giao ca');
  }

  it('a Quản lí lễ tân chooses among the Tổng quản lí lễ tân and the Admin — both at once', async () => {
    const sent: unknown[] = [];
    offer(
      MANAGER_USER,
      [
        { id: 10, fullName: 'Tổng quản lý', role: 'RECEPTION_GENERAL_MANAGER', roleLabel: 'Tổng quản lý', always: false },
        { id: 1, fullName: 'Quản trị viên', role: 'ADMIN', roleLabel: 'Admin', always: true },
        { id: 2, fullName: 'Admin Hai', role: 'ADMIN', roleLabel: 'Admin', always: true },
      ],
      sent,
      ['RECEPTION_GENERAL_MANAGER', 'ADMIN'],
    );
    await compose();
    expect(recipientLabels()).toEqual(['Tổng quản lí lễ tân', 'Admin']);
    expect(screen.getByTestId('confidential-recipient-ADMIN')).toBeEnabled();
    await userEvent.click(screen.getByTestId('confidential-recipient-RECEPTION_GENERAL_MANAGER'));
    await userEvent.click(screen.getByTestId('confidential-recipient-ADMIN'));
    await userEvent.click(screen.getByTestId('confidential-send'));
    await waitFor(() =>
      expect(sent).toEqual([{ category: 'PROCESS_RULES', content: 'Quy trình bàn giao ca', recipientIds: [10, 1, 2] }]),
    );
  });

  it('a Lễ tân whose branch has no Quản lí lễ tân yet still sees that group — marked empty — beside the Admin', async () => {
    const sent: unknown[] = [];
    offer(
      RECEPTIONIST_USER,
      [
        { id: 10, fullName: 'Tổng quản lý', role: 'RECEPTION_GENERAL_MANAGER', roleLabel: 'Tổng quản lý', always: false },
        { id: 1, fullName: 'Quản trị viên', role: 'ADMIN', roleLabel: 'Admin', always: true },
      ],
      sent,
      ['RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER', 'ADMIN'],
    );
    await compose();
    expect(recipientLabels()).toEqual(['Quản lí lễ tân (Giám sát)— chưa có tài khoản', 'Tổng quản lí lễ tân', 'Admin']);
    expect(screen.getByTestId('confidential-recipient-RECEPTION_MANAGER')).toBeDisabled();
    expect(screen.getByTestId('confidential-recipient-RECEPTION_GENERAL_MANAGER')).toBeEnabled();
    expect(screen.getByTestId('confidential-recipient-ADMIN')).toBeEnabled();
    await userEvent.click(screen.getByTestId('confidential-recipient-RECEPTION_GENERAL_MANAGER'));
    await userEvent.click(screen.getByTestId('confidential-recipient-ADMIN'));
    await userEvent.click(screen.getByTestId('confidential-send'));
    await waitFor(() => expect(sent).toEqual([{ category: 'PROCESS_RULES', content: 'Quy trình bàn giao ca', recipientIds: [10, 1] }]));
  });

  it('a Tổng quản lí lễ tân has the Admin as its only choice', async () => {
    const sent: unknown[] = [];
    offer(
      { ...MANAGER_USER, id: 10, username: 'tongql', fullName: 'Tổng quản lý', role: 'RECEPTION_GENERAL_MANAGER', managedBranchIds: [] },
      [{ id: 1, fullName: 'Quản trị viên', role: 'ADMIN', roleLabel: 'Admin', always: true }],
      sent,
      ['ADMIN'],
    );
    await compose();
    expect(recipientLabels()).toEqual(['Admin']);
    await userEvent.click(screen.getByTestId('confidential-recipient-ADMIN'));
    await userEvent.click(screen.getByTestId('confidential-send'));
    await waitFor(() => expect(sent).toEqual([{ category: 'PROCESS_RULES', content: 'Quy trình bàn giao ca', recipientIds: [1] }]));
  });
});

describe('reading the inbox', () => {
  it('lists unread and read separately, and opening one shows it in full and marks it read', async () => {
    let opened = false;
    installApiMock(
      shell(MANAGER_USER, {
        'GET /api/confidential-reports/options': () => ({
          status: 200,
          body: { title: 'x', categories: CATEGORIES, canSend: true, canRead: true, recipients: [], recipientRoles: ['RECEPTION_GENERAL_MANAGER', 'ADMIN'] },
        }),
        'GET /api/confidential-reports': () => ({
          status: 200,
          body: {
            reports: [report('r1', { read: opened }), report('r2', { read: true, category: 'PROCESS_RULES', categoryLabel: 'Quy trình, quy định' })],
            counts: { unread: opened ? 0 : 1, read: opened ? 2 : 1 },
          },
        }),
        'POST /api/confidential-reports/r1/read': () => {
          opened = true;
          return { status: 200, body: { report: report('r1', { read: true, content: 'Đồng nghiệp ca C thường xuyên đến muộn, đã nhắc 3 lần.' }) } };
        },
      }),
    );
    renderApp('/app/reports/confidential');

    const inbox = await screen.findByTestId('confidential-inbox');
    const unread = await within(inbox).findByTestId('confidential-item-r1');
    expect(unread).toHaveAttribute('data-unread', 'true');
    expect(unread).toHaveTextContent('Lễ tân Một');
    expect(unread).toHaveTextContent('Chi nhánh 1');
    expect(within(inbox).queryByTestId('confidential-item-r2')).not.toBeInTheDocument();
    expect(screen.getByTestId('confidential-tab-UNREAD')).toHaveTextContent('1');

    await userEvent.click(unread);
    const detail = await screen.findByTestId('confidential-detail');
    expect(detail).toHaveTextContent('Đồng nghiệp ca C thường xuyên đến muộn, đã nhắc 3 lần.');
    expect(detail).toHaveTextContent('Lễ tân Một · Lễ tân');
    // Sent to the chosen manager and, always, the Admin.
    expect(detail).toHaveTextContent('Gửi đến: Quản lý Một, Quản trị viên (Admin)');

    await userEvent.click(screen.getByRole('button', { name: /Đóng/ }));
    await userEvent.click(screen.getByTestId('confidential-tab-READ'));
    expect(await within(inbox).findByTestId('confidential-item-r1')).not.toHaveAttribute('data-unread');
    expect(within(inbox).getByTestId('confidential-item-r2')).toBeInTheDocument();
  });
});
