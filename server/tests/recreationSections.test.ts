/**
 * "Cần tạo lại" PDF — ONE SECTION PER BRANCH.
 *
 * The claims: no branch section ever holds another branch's order; each branch
 * subtotal is the count of its own orders; the branches come in branch-number
 * order; and the whole-report totals equal the sum of the sections. Pure data,
 * plus one render to prove the document builds and gives each branch its page.
 */
import { describe, expect, it } from 'vitest';
import type { RecreationReport, RecreationRow } from '../src/booking/recreationReport';
import { buildRecreationReportPdf, recreationSections } from '../src/report/recreationPdf';

const BRANCH = (id: number, n: number) => ({
  id,
  code: `B${n}`,
  hotelName: `KAS Hotel ${n}`,
  address: `${n} Đường Số ${n}`,
  branchNumber: n,
});

let seq = 0;
function row(branch: ReturnType<typeof BRANCH> | null, shift: 'A' | 'B' | 'C', who: string, source = 'BOOKING_COM'): RecreationRow {
  seq += 1;
  return {
    id: `p${seq}`,
    bookingId: `b${seq}`,
    attemptNumber: 1,
    submittedAt: new Date('2026-09-23T02:00:00Z'),
    submissionNote: null,
    receptionistNameSnapshot: who,
    shiftType: shift,
    shiftSessionId: null,
    reviewedAt: new Date('2026-09-23T03:00:00Z'),
    reviewReasonCode: null,
    reviewNote: 'Sai giá',
    submittedBy: null,
    reviewedBy: null,
    shiftSession: null,
    booking: {
      id: `b${seq}`,
      bookingCode: `CODE${seq}`,
      customerName: null,
      sourcePlatform: source,
      checkInDate: null,
      createdAt: new Date('2026-09-23T01:00:00Z'),
      sentAt: null,
      branchId: branch?.id ?? 0,
      status: 'REJECTED',
      verificationStatus: 'REJECTED',
      deletedAt: null,
      branch,
    },
  } as unknown as RecreationRow;
}

function report(rows: RecreationRow[]): RecreationReport {
  const count = (key: (r: RecreationRow) => string) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return m;
  };
  return {
    range: { from: '2026-09-23', to: '2026-09-23' },
    rows,
    totals: {
      total: rows.length,
      byBranch: count((r) => r.booking.branch?.code ?? '—'),
      byShift: count((r) => String(r.shiftType)),
      byReceptionist: count((r) => r.receptionistNameSnapshot ?? '—'),
    },
  };
}

const CN1 = BRANCH(11, 1);
const CN2 = BRANCH(12, 2);
const CN3 = BRANCH(13, 3);

describe('recreationSections', () => {
  // Deliberately interleaved and out of branch order, as the query returns them.
  const rows = [
    row(CN3, 'A', 'Lan'),
    row(CN1, 'A', 'Bảo'),
    row(CN2, 'C', 'Minh', 'AGODA'),
    row(CN1, 'B', 'Bảo'),
    row(CN3, 'A', 'Lan'),
    row(CN1, 'C', 'Hà', 'AGODA'),
  ];
  const sections = recreationSections(report(rows));

  it('never mixes two branches in one section', () => {
    for (const s of sections) {
      expect(new Set(s.rows.map((r) => r.booking.branch?.id))).toEqual(new Set([s.branch!.id]));
    }
  });

  it('puts every order in exactly one section', () => {
    const placed = sections.flatMap((s) => s.rows.map((r) => r.id)).sort();
    expect(placed).toEqual(rows.map((r) => r.id).sort());
  });

  it('orders the branches by their number', () => {
    expect(sections.map((s) => s.branch?.branchNumber)).toEqual([1, 2, 3]);
  });

  it('subtotals each branch from its own orders, by shift, receptionist and source', () => {
    const cn1 = sections[0]!;
    expect(cn1.total).toBe(3);
    expect(Object.fromEntries(cn1.byShift)).toEqual({ 'Ca A': 1, 'Ca B': 1, 'Ca C': 1 });
    expect(Object.fromEntries(cn1.byReceptionist)).toEqual({ Bảo: 2, Hà: 1 });
    expect(Object.fromEntries(cn1.bySource)).toEqual({ BOOKING_COM: 2, AGODA: 1 });
    // The branch subtotals add up to the report's total.
    expect(sections.reduce((n, s) => n + s.total, 0)).toBe(rows.length);
  });

  it('keeps an order with no branch in a section of its own, last', () => {
    const withOrphan = recreationSections(report([row(null, 'A', 'X'), row(CN1, 'A', 'Y')]));
    expect(withOrphan.map((s) => s.branch?.branchNumber ?? null)).toEqual([1, null]);
  });

  it('renders one page per branch plus the whole-report summary', async () => {
    const pdf = await buildRecreationReportPdf(report(rows), 'Tất cả chi nhánh', new Date());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // Three branch sections, each on its own page, and the summary page.
    const pages = pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pages.length).toBeGreaterThanOrEqual(4);
  });
});
