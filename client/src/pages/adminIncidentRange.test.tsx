/**
 * The Admin's incident date-range monitoring — now the "Sự cố vật chất đang xử
 * lý" category of "Báo cáo vấn đề", where the old "Sự cố khách sạn" address
 * lands.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. The period is the PAGE's period — today by default, like every other
 *      category — and what it leaves out is never silent: the summary counts
 *      what is still open outside it, and every branch's unresolved total is
 *      on screen.
 *   2. The narrowing reaches the SERVER. Filtering a loaded page would only ever
 *      narrow the page that happened to load.
 *   3. "Tồn đọng hiện tại" and a date range are mutually exclusive, and the
 *      screen says which one is in force.
 *   4. "Lượt không sửa được" and "Cần xử lý lại" are shown as two numbers,
 *      because they are two numbers.
 *   5. The export starts from the period already on screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ADMIN_USER, renderApp } from '../test/utils';
import { hcmToday } from '../lib/format';
import { daysBefore } from '../lib/shiftGroups';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'KAS Passion', address: '05 Trương Định' };

const SUMMARY = {
  total: 7,
  newCount: 2,
  inProgressCount: 1,
  completedCount: 4,
  cannotRepairAttempts: 4,
  needsReworkIssues: 1,
  outstandingTotal: 9,
};

function issue(over: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    branchId: 1,
    branch: BRANCH,
    areaCategory: 'ROOM',
    roomNumber: '101',
    floorNumber: null,
    areaSubtype: null,
    locationDetail: null,
    locationLabel: 'Phòng · Phòng 101',
    category: 'TOILET',
    description: 'Hello',
    photoUrl: null,
    status: 'NEW',
    reportedBy: { id: 2, fullName: 'Lễ tân Một' },
    reportedByName: 'Lễ tân Một',
    acceptedBy: null,
    acceptedByName: null,
    acceptedAt: null,
    technicianName: null,
    technicianPhone: null,
    completedBy: null,
    completedByName: null,
    completedAt: null,
    shiftType: 'A',
    shiftReceptionistName: 'Nguyễn Văn A',
    durationSeconds: null,
    durationLabel: null,
    attempts: [],
    cannotRepairCount: 0,
    needsRework: false,
    createdAt: '2026-09-17T02:00:00.000Z',
    updatedAt: '2026-09-17T02:00:00.000Z',
    ...over,
  };
}

/**
 * A PREFIX-matching mock, unlike `installApiMock`.
 *
 * The page's request URL carries whatever period the operator picked, and the
 * period is derived from the real clock — so a test that pinned the full URL
 * would have to restate today's date. What each test actually cares about is
 * which URLs were requested, which `seen` records.
 */
function installMocks(onRequest?: (url: string) => void, issues: unknown[] = [issue()]) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    onRequest?.(u);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    if (u === '/api/auth/me') return json({ user: ADMIN_USER });
    if (u === '/api/notifications/unread-count') return json({ count: 0 });
    if (u === '/api/issues/summary')
      return json({
        summary: {
          totalUnresolved: 3,
          newCount: 2,
          inProgressCount: 1,
          byBranch: [{ branchId: 1, code: BRANCH.code, address: BRANCH.address, hotelName: BRANCH.hotelName, newCount: 2, inProgressCount: 1, totalUnresolved: 3 }],
        },
      });
    if (u === '/api/admin/branches')
      return json({ branches: [{ ...BRANCH, branchNumber: 1, active: true }] });
    if (u === '/api/nav-badges')
      return json({ counts: { new: 0, pendingReview: 0, rejected: 0, resendOrders: 0, chat: 0, reminders: 0 } });
    if (u.startsWith('/api/admin/reports/incidents/summary'))
      return json({ range: { from: '', to: '' }, summary: SUMMARY });
    if (u.startsWith('/api/issues'))
      return json({
        issues,
        pagination: { page: 1, pageSize: 100, total: 1, totalPages: 1 },
      });
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `no mock for ${u}` } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
}

/**
 * The page opens on today; "7 ngày" is today and the six days before it.
 * Computed from the same clock the page reads.
 */
const TODAY = hcmToday();
const WEEK_FROM = daysBefore(TODAY, 6);

/** The old "Sự cố khách sạn" address: the incident category, every branch. */
async function openIncidents() {
  renderApp('/app/issues');
  return screen.findByTestId('admin-incident-table');
}

describe('the incident period controls', () => {
  it('asks the server for the page’s period — today — by default', async () => {
    const seen: string[] = [];
    installMocks((u) => seen.push(u));
    await openIncidents();

    await waitFor(() =>
      expect(seen).toContain(`/api/issues?from=${TODAY}&to=${TODAY}&pageSize=100`),
    );
  });

  it('sends the chosen period to the SERVER', async () => {
    const seen: string[] = [];
    installMocks((u) => seen.push(u));
    const user = userEvent.setup();
    await openIncidents();

    await user.click(await screen.findByTestId('admin-range-6'));

    await waitFor(() =>
      expect(seen).toContain(`/api/issues?from=${WEEK_FROM}&to=${TODAY}&pageSize=100`),
    );
  });

  it('sends the outstanding flag, and drops the period when it is chosen', async () => {
    const seen: string[] = [];
    installMocks((u) => seen.push(u));
    const user = userEvent.setup();
    await openIncidents();

    seen.length = 0;
    await user.click(screen.getByTestId('admin-incident-outstanding'));

    await waitFor(() => expect(seen.some((u) => u.includes('outstanding=true'))).toBe(true));
    // The two are mutually exclusive on the server — "tồn đọng" IS a status set,
    // so combining them would silently answer a different question.
    const outstandingCalls = seen.filter((u) => u.includes('outstanding=true'));
    expect(outstandingCalls.every((u) => !u.includes('from='))).toBe(true);
    expect(screen.getByTestId('admin-incident-table')).toHaveTextContent('Sự cố còn tồn đọng');
  });
});

describe('the period summary', () => {
  /**
   * TWO NUMBERS THAT SOUND LIKE ONE, SHOWN AS TWO.
   *
   * Four separate visits failed; one incident is waiting to be picked up again.
   * Printing either alone, or adding them, produces a figure nobody can
   * interpret.
   */
  it('separates failed attempts from incidents needing rework', async () => {
    installMocks();
    await openIncidents();

    const summary = await screen.findByTestId('incident-range-summary');
    const cell = (label: string) =>
      within(summary).getByText(label).parentElement!.textContent ?? '';
    expect(cell('Tổng sự cố phát sinh')).toContain('7');
    expect(cell('Lượt không sửa được')).toContain('4');
    expect(cell('Cần xử lý lại')).toContain('1');
  });

  /** The period hides nothing silently: what is still open elsewhere is counted. */
  it('reports the outstanding total as explicitly OUTSIDE the period', async () => {
    installMocks();
    await openIncidents();

    const summary = await screen.findByTestId('incident-range-summary');
    expect(within(summary).getByText(/Ngoài khoảng thời gian này/)).toBeInTheDocument();
    expect(within(summary).getByText('9')).toBeInTheDocument();
  });

  it('steps aside for the outstanding view, which has no period', async () => {
    installMocks();
    const user = userEvent.setup();
    await openIncidents();

    await screen.findByTestId('incident-range-summary');
    await user.click(screen.getByTestId('admin-incident-outstanding'));
    await waitFor(() => expect(screen.queryByTestId('incident-range-summary')).not.toBeInTheDocument());
  });

  it('does not add a second table to the page', async () => {
    installMocks();
    await openIncidents();
    await screen.findByTestId('incident-range-summary');

    // `findByRole('table')` has to stay unambiguous — for a screen reader as
    // much as for a test.
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });
});

describe('the incident table', () => {
  it('keeps the branch and export controls, and every branch’s unresolved count', async () => {
    installMocks();
    await openIncidents();

    expect(await screen.findByTestId('branch-select')).toHaveValue('ALL');
    expect(screen.getByRole('button', { name: /Xuất báo cáo/ })).toBeInTheDocument();
    expect(await screen.findByText('Sự cố chưa xử lý theo chi nhánh')).toBeInTheDocument();
  });

  it('shows how the latest repair attempt ended, and how long it took', async () => {
    installMocks(undefined, [
      issue({
        status: 'NEW',
        needsRework: true,
        attempts: [
          {
            id: 'a1',
            attemptNumber: 1,
            technicianName: 'Minh',
            technicianPhone: '0909000222',
            acceptedByName: 'Minh',
            acceptedAt: '2026-09-17T02:10:00.000Z',
            outcome: 'CANNOT_REPAIR',
            outcomeAt: '2026-09-17T02:40:00.000Z',
            reason: 'Thiếu phụ tùng',
            durationSeconds: 1800,
            durationLabel: '30 phút',
          },
        ],
      }),
    ]);
    const table = await openIncidents();

    const row = await within(table).findByTestId('row-i1');
    expect(within(row).getByText(/Không sửa được/)).toHaveTextContent('Không sửa được · 30 phút');
    expect(within(table).getByRole('columnheader', { name: 'Kết quả gần nhất' })).toBeInTheDocument();
  });

  it('offers no way to transition anything', async () => {
    installMocks();
    const table = await openIncidents();
    await within(table).findByTestId('row-i1');

    expect(within(table).queryByRole('button', { name: 'Tiếp nhận' })).toBeNull();
    expect(within(table).queryByRole('button', { name: /Hoàn thành/ })).toBeNull();
    expect(within(table).queryByRole('button', { name: /Không sửa được/ })).toBeNull();
    // And nowhere else on the page either — the server refuses an Admin
    // transition outright, and the screen must agree with that rule.
    expect(screen.queryByRole('button', { name: /Không sửa được/ })).toBeNull();
  });
});

describe('the export', () => {
  it('starts from the period already on screen', async () => {
    installMocks();
    const user = userEvent.setup();
    await openIncidents();

    await user.click(await screen.findByTestId('admin-range-6'));
    await user.click(screen.getByRole('button', { name: /Xuất báo cáo/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Xuất báo cáo sự cố' });

    // The file and the table cannot silently describe two different weeks.
    expect((within(dialog).getByTestId('incident-report-range-from') as HTMLInputElement).value).toBe(WEEK_FROM);
  });

  it('opens the PDF with the chosen range', async () => {
    installMocks();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const user = userEvent.setup();
    await openIncidents();

    await user.click(screen.getByRole('button', { name: /Xuất báo cáo/ }));
    await user.click(await screen.findByTestId('incident-export-confirm'));

    expect(open).toHaveBeenCalledTimes(1);
    const url = String(open.mock.calls[0]![0]);
    expect(url).toContain('/api/admin/reports/incidents.pdf');
    expect(url).toContain(`from=${TODAY}`);
    expect(url).toContain(`to=${TODAY}`);
  });
});
