/**
 * The Admin's incident date-range monitoring — now the "Sự cố cơ sở vật chất
 * đang xử lý" category of "Báo cáo vấn đề", where the old "Sự cố khách sạn"
 * address lands.
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
import { withLifecycle } from '../test/issueFixtures';
import { hcmToday } from '../lib/format';
import { daysBefore } from '../lib/shiftGroups';
import { pickRange } from '../test/reportFilter';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = { id: 1, code: 'TRUONG_DINH_05', hotelName: 'KAS Passion', address: '05 Trương Định' };

/** The period summary as the server sends it while inspection is DORMANT (the default). */
const SUMMARY = {
  total: 7,
  newCount: 2,
  inProgressCount: 1,
  awaitingInspectionCount: 0,
  completedCount: 4,
  cannotRepairAttempts: 4,
  failedInspections: 2,
  needsReworkIssues: 1,
  outstandingTotal: 9,
  inspectionEnabled: false,
};

/** …and with inspection switched on. */
const INSPECTION_SUMMARY = { ...SUMMARY, awaitingInspectionCount: 3, completedCount: 1, inspectionEnabled: true };

function issue(over: Record<string, unknown> = {}) {
  return withLifecycle({
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
  });
}

/**
 * A PREFIX-matching mock, unlike `installApiMock`.
 *
 * The page's request URL carries whatever period the operator picked, and the
 * period is derived from the real clock — so a test that pinned the full URL
 * would have to restate today's date. What each test actually cares about is
 * which URLs were requested, which `seen` records.
 */
function installMocks(onRequest?: (url: string) => void, issues: unknown[] = [issue()], summary: unknown = SUMMARY) {
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
      return json({ range: { from: '', to: '' }, summary });
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
    await openIncidents();

    await pickRange(WEEK_FROM, TODAY);

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
    await user.click(screen.getByTestId('admin-incident-view-outstanding'));

    await waitFor(() => expect(seen.some((u) => u.includes('outstanding=true'))).toBe(true));
    // The two are mutually exclusive on the server — "tồn đọng" IS a status set,
    // so combining them would silently answer a different question.
    const outstandingCalls = seen.filter((u) => u.includes('outstanding=true'));
    expect(outstandingCalls.every((u) => !u.includes('from='))).toBe(true);
    expect(screen.getByTestId('admin-incident-table')).toHaveTextContent('Còn tồn đọng (mọi ngày báo)');
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
    expect(cell('Cần sửa lại')).toContain('1');
    // Inspection is dormant: neither of its figures is part of the summary.
    expect(within(summary).queryByText('Nghiệm thu không đạt')).not.toBeInTheDocument();
    expect(within(summary).queryByText('Chờ nghiệm thu')).not.toBeInTheDocument();
  });

  it('with inspection switched on, counts failed inspections and those awaiting one', async () => {
    installMocks(undefined, [issue({ inspectionEnabled: true })], INSPECTION_SUMMARY);
    await openIncidents();

    const summary = await screen.findByTestId('incident-range-summary');
    const cell = (label: string) =>
      within(summary).getByText(label).parentElement!.textContent ?? '';
    // A failed inspection is counted as the event it is, beside the others.
    expect(cell('Nghiệm thu không đạt')).toContain('2');
    expect(cell('Chờ nghiệm thu')).toContain('3');
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
    await user.click(screen.getByTestId('admin-incident-view-outstanding'));
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

/** Lần 1 repaired and failed inspection; Lần 2 under way. */
const FAILED_ATTEMPT = {
  id: 'a1',
  attemptNumber: 1,
  technicianName: 'Bảo',
  technicianPhone: '0369852177',
  acceptedByName: 'Bảo',
  acceptedAt: '2026-09-17T03:30:00.000Z',
  outcome: 'COMPLETED',
  outcomeAt: '2026-09-17T04:10:00.000Z',
  reason: null,
  cause: 'Thiếu gas',
  result: 'Đã nạp gas',
  inspection: {
    result: 'FAILED',
    resultLabel: 'Không đạt',
    inspectedByName: 'Quản lý Hùng',
    inspectedAt: '2026-09-17T04:40:00.000Z',
    note: 'Vẫn chưa lạnh',
  },
  durationSeconds: 2400,
  durationLabel: '40 phút',
};

function reworked(over: Record<string, unknown> = {}) {
  return issue({
    status: 'IN_PROGRESS',
    reportedCause: 'Máy kêu to',
    technicianName: 'Minh',
    technicianPhone: '0911222333',
    acceptedAt: '2026-09-17T05:20:00.000Z',
    attempts: [
      FAILED_ATTEMPT,
      {
        ...FAILED_ATTEMPT,
        id: 'a2',
        attemptNumber: 2,
        technicianName: 'Minh',
        technicianPhone: '0911222333',
        acceptedAt: '2026-09-17T05:20:00.000Z',
        outcome: null,
        outcomeAt: null,
        cause: null,
        result: null,
        inspection: null,
        durationLabel: '10 phút',
      },
    ],
    ...over,
  });
}

describe('the incident table', () => {
  it('keeps the branch and export controls — the counts are in the selector', async () => {
    installMocks();
    await openIncidents();

    expect(await screen.findByTestId('branch-select')).toHaveTextContent('Tất cả chi nhánh');
    expect(screen.getByRole('button', { name: /Xuất báo cáo/ })).toBeInTheDocument();
    // The separate "by branch" table is gone: the selector carries the numbers.
    expect(screen.queryByText('Sự cố chưa xử lý theo chi nhánh')).not.toBeInTheDocument();
    expect(screen.queryByTestId('branch-incident-counts')).not.toBeInTheDocument();
  });

  /**
   * THE WHOLE LIFECYCLE, VISIBLY. Lần 1 was repaired and failed inspection, Lần 2
   * is under way. The row says where it stands and who judged it; the opened
   * record lays out report, repair and inspection — the rejection reason in
   * plain text, not in a tooltip — and every attempt.
   */
  it('shows the stage, who judged the last repair, and the full lifecycle when opened', async () => {
    installMocks(undefined, [reworked({ inspectionEnabled: true })], INSPECTION_SUMMARY);
    const user = userEvent.setup();
    const table = await openIncidents();

    const row = await within(table).findByTestId('row-i1');
    expect(within(table).getByRole('columnheader', { name: 'Nghiệm thu' })).toBeInTheDocument();
    expect(within(row).getByTestId('issue-stage')).toHaveTextContent('Đang sửa');
    expect(within(row).getByTestId('issue-inspection')).toHaveTextContent('Nghiệm thu: Không đạt');
    expect(within(row).getByText('Quản lý Hùng')).toBeInTheDocument();
    expect(within(row).getByText('Minh')).toBeInTheDocument();

    await user.click(within(table).getByTestId('row-toggle-i1'));
    const lifecycle = await within(table).findByTestId('issue-lifecycle');
    // Report: the reporter as a person, and the cause Reception gave.
    expect(within(lifecycle).getAllByText('Nguyễn Văn A').length).toBeGreaterThan(0);
    expect(within(lifecycle).getByText('Máy kêu to')).toBeInTheDocument();
    // Inspection: the verdict, who, and why — visible, not hovered for.
    expect(within(lifecycle).getAllByText('Lý do không đạt: Vẫn chưa lạnh').length).toBeGreaterThan(0);
    expect(within(lifecycle).getAllByText(/Quản lý Hùng/).length).toBeGreaterThan(0);
    // Both attempts, the first with its cause and result intact.
    const timeline = within(lifecycle).getByTestId('issue-timeline');
    expect(within(timeline).getByText(/Lần 1/)).toBeInTheDocument();
    expect(within(timeline).getByText(/Lần 2/)).toBeInTheDocument();
    expect(within(timeline).getByText('Đã nạp gas')).toBeInTheDocument();
  });

  /**
   * DORMANT, THE SAME RECORD WITHOUT THE INSPECTION: the stage, the repairer
   * and every attempt with its cause and result — and no "Nghiệm thu" column,
   * badge, panel or verdict. The recorded verdict is still stored; it is simply
   * not part of the workflow being shown.
   */
  it('shows the full history without any inspection while inspection is dormant', async () => {
    installMocks(undefined, [reworked()]);
    const user = userEvent.setup();
    const table = await openIncidents();

    const row = await within(table).findByTestId('row-i1');
    expect(within(table).queryByRole('columnheader', { name: 'Nghiệm thu' })).not.toBeInTheDocument();
    expect(within(row).getByTestId('issue-stage')).toHaveTextContent('Đang sửa');
    expect(within(row).queryByTestId('issue-inspection')).not.toBeInTheDocument();
    expect(within(row).getByText('Minh')).toBeInTheDocument();

    await user.click(within(table).getByTestId('row-toggle-i1'));
    const lifecycle = await within(table).findByTestId('issue-lifecycle');
    expect(within(lifecycle).getByText('Máy kêu to')).toBeInTheDocument();
    expect(within(lifecycle).queryByText(/Lý do không đạt/)).not.toBeInTheDocument();
    expect(within(lifecycle).queryByText(/Quản lý Hùng/)).not.toBeInTheDocument();
    const timeline = within(lifecycle).getByTestId('issue-timeline');
    expect(within(timeline).getByText(/Lần 1/)).toBeInTheDocument();
    expect(within(timeline).getByText(/Lần 2/)).toBeInTheDocument();
    expect(within(timeline).getByText('Đã nạp gas')).toBeInTheDocument();
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

    await pickRange(WEEK_FROM, TODAY);
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

  /** The dialog describes the file the server will build — no inspection while it is dormant. */
  it('promises no inspection results while inspection is dormant', async () => {
    installMocks();
    const user = userEvent.setup();
    await openIncidents();
    await screen.findByTestId('incident-range-summary');

    await user.click(screen.getByRole('button', { name: /Xuất báo cáo/ }));
    const contents = await screen.findByTestId('incident-export-contents');
    expect(contents).toHaveTextContent('kể cả những lần không sửa được.');
    expect(contents).not.toHaveTextContent(/nghiệm thu/i);
  });

  it('with inspection switched on, says the file carries the inspection results', async () => {
    installMocks(undefined, [issue({ inspectionEnabled: true })], INSPECTION_SUMMARY);
    const user = userEvent.setup();
    await openIncidents();
    await screen.findByTestId('incident-range-summary');

    await user.click(screen.getByRole('button', { name: /Xuất báo cáo/ }));
    expect(await screen.findByTestId('incident-export-contents')).toHaveTextContent('và kết quả nghiệm thu.');
  });
});
