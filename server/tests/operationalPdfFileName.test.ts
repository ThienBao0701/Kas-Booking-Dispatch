/**
 * The operational report PDF is named for its branch and its business date —
 * "05_Truong Dinh_07-01-2027.pdf" — never for the moment it was built.
 */
import { describe, expect, it } from 'vitest';
import { operationalPdfFileName } from '../src/report/operationalPdf';

const branch = (address: string, branchNumber = 1) => ({
  branch: { id: branchNumber, code: `B${branchNumber}`, hotelName: 'KAS', address, branchNumber },
});

const data = (from: string, to: string, branches: ReturnType<typeof branch>[]) =>
  ({ from, to, branches }) as unknown as Parameters<typeof operationalPdfFileName>[0];

describe('operationalPdfFileName', () => {
  it('names one branch and one business day as <number>_<street>_<DD-MM-YYYY>.pdf', () => {
    expect(operationalPdfFileName(data('2027-01-07', '2027-01-07', [branch('05 Trương Định')]), true)).toBe(
      '05_Truong Dinh_07-01-2027.pdf',
    );
    expect(operationalPdfFileName(data('2027-01-07', '2027-01-07', [branch('260 Lý Tự Trọng', 2)]), true)).toBe(
      '260_Ly Tu Trong_07-01-2027.pdf',
    );
    expect(operationalPdfFileName(data('2027-01-07', '2027-01-07', [branch('47A Nguyễn Trãi', 3)]), true)).toBe(
      '47A_Nguyen Trai_07-01-2027.pdf',
    );
  });

  it('names a period by both of its days', () => {
    expect(operationalPdfFileName(data('2027-01-01', '2027-01-07', [branch('05 Trương Định')]), true)).toBe(
      '05_Truong Dinh_01-01-2027_07-01-2027.pdf',
    );
  });

  it('names an all-branch export as such, even when only one branch exists', () => {
    expect(
      operationalPdfFileName(data('2027-01-07', '2027-01-07', [branch('05 Trương Định'), branch('260 Lý Tự Trọng', 2)]), false),
    ).toBe('Tat ca chi nhanh_07-01-2027.pdf');
    expect(operationalPdfFileName(data('2027-01-07', '2027-01-07', [branch('05 Trương Định')]), false)).toBe(
      'Tat ca chi nhanh_07-01-2027.pdf',
    );
  });

  it('never puts a filesystem-illegal character in the name', () => {
    const name = operationalPdfFileName(data('2027-01-07', '2027-01-07', [branch('12/3 Hai: Bà "Trưng"')]), true);
    expect(name).toBe('12-3_Hai- Ba -Trung-_07-01-2027.pdf');
    expect(name).not.toMatch(/[<>:"/\\|?*]/);
  });

  it('falls back to the branch number when the address has no leading number', () => {
    expect(operationalPdfFileName(data('2027-01-07', '2027-01-07', [branch('Đường Láng', 4)]), true)).toBe(
      '4_Duong Lang_07-01-2027.pdf',
    );
  });
});

describe('the shift and the format in the name', () => {
  it('names a one-shift file by its shift, and the workbook like the PDF', () => {
    const oneShift = { ...data('2026-09-30', '2026-09-30', [branch('05 Trương Định')]), shiftType: 'A' as const };
    expect(operationalPdfFileName(oneShift, true)).toBe('05_Truong Dinh_30-09-2026_Ca A.pdf');
    expect(operationalPdfFileName(oneShift, true, 'xlsx')).toBe('05_Truong Dinh_30-09-2026_Ca A.xlsx');
    expect(operationalPdfFileName(data('2026-09-01', '2026-09-30', [branch('05 Trương Định')]), false, 'xlsx')).toBe(
      'Tat ca chi nhanh_01-09-2026_30-09-2026.xlsx',
    );
  });
});
