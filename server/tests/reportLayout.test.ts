/**
 * THE PDF PAGE MACHINERY, tested where it broke.
 *
 * pdfkit starts a NEW PAGE whenever a line would cross `page.maxY()`. Nothing
 * throws and nothing warns — the text just appears somewhere else. Two places in
 * this codebase wrote past that line, and the result was invisible until a
 * report was opened:
 *
 *   addPageNumbers  wrote each footer INSIDE the bottom margin, so every footer
 *                   created the page it was meant to number. A 26-page report
 *                   came out at 52 pages, the second half blank but for
 *                   "Trang k/26".
 *
 *   drawTable       drew its header row without checking there was room, so a
 *                   table starting near the foot of a page put ONE HEADER CELL
 *                   on each of the next ten pages.
 *
 * Both are asserted here on page COUNTS, which needs no PDF parser and cannot be
 * satisfied by a document that merely renders.
 */
import { describe, expect, it } from 'vitest';
import {
  addPageNumbers,
  assertCellsFit,
  assertHeadersFit,
  createReportDocument,
  DATE_SAMPLE,
  drawTable,
  measureText,
  sectionTitle,
  tableLeadHeight,
  usableWidth,
  type Column,
} from '../src/report/pdf';
import {
  MONEY_COLUMN_WIDTH,
  MONEY_SAMPLE,
  PDF_MONEY_CEILING,
} from '../src/report/operationalPdf';
import { MAX_VND } from '../src/reception/reportService';
import { formatVnd, formatVndPlain } from '../src/reception/reportTypes';

const HEADER = {
  title: 'KAS — TEST',
  period: '19/09/2026 – 19/09/2026',
  generatedAt: '19/09/2026 22:15',
  scope: 'Tất cả chi nhánh',
};

interface Row {
  a: string;
}

const COLUMNS: Column<Row>[] = [
  { header: 'Một', width: 60, value: (r) => r.a },
  { header: 'Hai', width: 60, value: (r) => r.a },
  { header: 'Ba', width: 60, value: (r) => r.a },
  { header: 'Bốn', width: 60, value: (r) => r.a },
  { header: 'Năm', width: 60, value: (r) => r.a },
  { header: 'Sáu', width: 60, value: (r) => r.a },
  { header: 'Bảy', width: 60, value: (r) => r.a },
  { header: 'Tám', width: 60, value: (r) => r.a },
  { header: 'Chín', width: 60, value: (r) => r.a },
  { header: 'Mười', width: 60, value: (r) => r.a },
];

describe('addPageNumbers', () => {
  it('stamps the pages that exist instead of creating new ones', () => {
    const doc = createReportDocument(HEADER);
    doc.addPage();
    doc.addPage();
    expect(doc.bufferedPageRange().count).toBe(3);

    addPageNumbers(doc);

    // THE assertion. Before the fix this was 6: three content pages followed by
    // three pages holding nothing but a footer.
    expect(doc.bufferedPageRange().count).toBe(3);
    doc.end();
  });

  it('numbers a single-page report without adding a second page', () => {
    const doc = createReportDocument(HEADER);
    addPageNumbers(doc);
    expect(doc.bufferedPageRange().count).toBe(1);
    doc.end();
  });
});

describe('drawTable', () => {
  it('moves a header that will not fit to the next page, whole', () => {
    const doc = createReportDocument(HEADER);
    // Park the cursor just above the bottom margin: no room for a header row.
    doc.y = doc.page.maxY() - 4;

    drawTable(doc, COLUMNS, [{ a: 'x' }]);

    // Exactly ONE new page. Before the fix each of the ten header cells made its
    // own, so this was 11.
    expect(doc.bufferedPageRange().count).toBe(2);
    doc.end();
  });

  it('keeps a table that fits on the page it started on', () => {
    const doc = createReportDocument(HEADER);
    drawTable(doc, COLUMNS, [{ a: 'x' }, { a: 'y' }]);
    expect(doc.bufferedPageRange().count).toBe(1);
    doc.end();
  });

  /**
   * A HEADER NEVER SITS ALONE AT THE FOOT OF A PAGE. There was room for the
   * header but not its first row; the header printed, the rows went overleaf,
   * and page one ended on what read as an empty table. Page count alone cannot
   * tell the two apart — the old code also made two pages — so this records
   * which page each header cell was written on.
   */
  it('keeps the header with its first row', () => {
    const doc = createReportDocument(HEADER);
    const rows = [{ a: 'x' }];
    const headerOnly = tableLeadHeight(doc, COLUMNS, []);
    // Room for the header, not for the header and a row.
    doc.y = doc.page.maxY() - headerOnly - 1;

    const pagesOfHeader: number[] = [];
    const text = doc.text.bind(doc);
    doc.text = ((value: string, ...rest: unknown[]) => {
      if (value === 'Một') pagesOfHeader.push(doc.bufferedPageRange().count);
      return (text as (...args: unknown[]) => typeof doc)(value, ...rest);
    }) as typeof doc.text;

    drawTable(doc, COLUMNS, rows);

    expect(doc.bufferedPageRange().count).toBe(2);
    // Written once, on page 2 — never on page 1 with its row overleaf.
    expect(pagesOfHeader).toEqual([2]);
    doc.end();
  });

  it('measures a header and its first row as the room a table needs to start', () => {
    const doc = createReportDocument(HEADER);
    const header = tableLeadHeight(doc, COLUMNS, []);
    const lead = tableLeadHeight(doc, COLUMNS, [{ a: 'x' }]);
    expect(header).toBeGreaterThan(0);
    expect(lead).toBeGreaterThan(header);
    doc.end();
  });

  it('hands the cursor back at the left margin', () => {
    const doc = createReportDocument(HEADER);
    drawTable(doc, COLUMNS, [{ a: 'x' }]);
    /*
      Each cell is written at its own x, and pdfkit leaves `doc.x` at the last
      one. A section heading written afterwards without an explicit x started
      near the RIGHT edge and stacked itself down the margin, two words per line.
    */
    expect(doc.x).toBe(doc.page.margins.left);
    doc.end();
  });
});

describe('sectionTitle', () => {
  it('returns to the left margin even if something left the cursor elsewhere', () => {
    const doc = createReportDocument(HEADER);
    doc.x = 700;
    sectionTitle(doc, 'III. SỰ CỐ CƠ SỞ VẬT CHẤT ĐANG XỬ LÝ (4)');
    expect(doc.x).toBe(doc.page.margins.left);
    doc.end();
  });

  it('does not strand a heading at the foot of a page', () => {
    const doc = createReportDocument(HEADER);
    doc.y = doc.page.maxY() - 6;
    sectionTitle(doc, 'V. DỊCH VỤ PHÒNG (5)');
    expect(doc.bufferedPageRange().count).toBe(2);
    doc.end();
  });
});

describe('a money column holds the largest amount the system can store', () => {
  /*
    THE PDF IS SIZED FROM THE SCHEMA, NOT FROM A NUMBER SOMEBODY LIKED.

    An amount the API accepts and the report cannot print is data corrupted on
    its way to paper: "9.999.999.99" over "9" reads as a tenth of the real
    figure. The tempting fix is to lower the API's ceiling until the table looks
    right, which would reject real money to flatter a layout — so the dependency
    runs the other way and these assertions pin it.
  */
  it('is sized for ten digits — 9.999.999.999', () => {
    expect(PDF_MONEY_CEILING).toBe(9_999_999_999);
    expect(MONEY_SAMPLE).toBe('9.999.999.999');
    expect(MONEY_SAMPLE).toBe(formatVndPlain(PDF_MONEY_CEILING));
    // The same number as a reader sees it, with the unit the header carries.
    expect(formatVnd(PDF_MONEY_CEILING)).toBe('9.999.999.999 ₫');
  });

  it('can print anything the system is able to store, with headroom', () => {
    /*
      The columns are sized ABOVE the storage ceiling on purpose. MAX_VND is
      what a PostgreSQL INTEGER can hold; widening those columns to BigInt later
      must not silently start corrupting printed amounts, so the report already
      covers four and a half times the current maximum.
    */
    expect(PDF_MONEY_CEILING).toBeGreaterThanOrEqual(MAX_VND);
    expect(MAX_VND).toBe(2_147_483_647);
    expect(measureText(formatVndPlain(MAX_VND))).toBeLessThan(
      usableWidth({ header: '', width: MONEY_COLUMN_WIDTH, value: () => '' }),
    );
  });

  it('is wide enough for it, with room to spare', () => {
    const needed = measureText(MONEY_SAMPLE);
    const available = usableWidth({ header: '', width: MONEY_COLUMN_WIDTH, value: () => '' });

    expect(needed).toBeCloseTo(61.26, 1);
    expect(available).toBeGreaterThan(needed);
    // Not a hairline pass: at least 2pt of slack, so kerning or a font revision
    // cannot quietly push it over.
    expect(available - needed).toBeGreaterThan(2);
  });

  it('would fail loudly if the schema ceiling outgrew the column', () => {
    // A hundred billion — one digit more than the schema allows today.
    expect(() =>
      assertCellsFit(
        'probe',
        [{ header: 'Chi (₫)', width: MONEY_COLUMN_WIDTH, value: () => '' }],
        { 'Chi (₫)': '99.999.999.999' },
      ),
    ).toThrow(/must hold "99\.999\.999\.999"/);
  });

  it('draws the maximum on ONE line', () => {
    const doc = createReportDocument(HEADER);
    const money: Column<{ v: string }>[] = [
      { header: 'Chi (₫)', width: MONEY_COLUMN_WIDTH, align: 'right', value: (r) => r.v },
    ];
    const before = doc.y;
    drawTable(doc, money, [{ v: MONEY_SAMPLE }]);
    const withMax = doc.y - before;

    // The same table with a short amount. If the maximum wrapped, its row would
    // be a whole line taller than this one.
    const doc2 = createReportDocument(HEADER);
    const before2 = doc2.y;
    drawTable(doc2, money, [{ v: '1.000' }]);
    const withShort = doc2.y - before2;

    expect(withMax).toBe(withShort);
    doc.end();
    doc2.end();
  });
});

describe('the measured guards', () => {
  it('measures in the report’s own font, not an approximation', () => {
    // Widths the operational report's columns were actually sized from.
    expect(measureText('1.234.567.890')).toBeCloseTo(57.3, 0);
    expect(measureText('Booking.com')).toBeCloseTo(51.4, 0);
    expect(measureText('STT', 'bold')).toBeCloseTo(15.9, 0);
  });

  it('refuses a header word that cannot fit', () => {
    expect(() =>
      assertHeadersFit('probe', [{ header: 'STT', width: 20, value: () => '' }]),
    ).toThrow(/header word "STT"/);
  });

  it('allows a multi-word header to wrap at a space', () => {
    expect(() =>
      assertHeadersFit('probe', [{ header: 'Thu tiền mặt (₫)', width: 40, value: () => '' }]),
    ).not.toThrow();
  });

  it('refuses a column that cannot hold the value it is for', () => {
    expect(() =>
      assertCellsFit('probe', [{ header: 'Giá', width: 30, value: () => '' }], {
        Giá: '1.234.567.890',
      }),
    ).toThrow(/must hold "1\.234\.567\.890"/);
  });

  /**
   * THE DATE SAMPLE IS THE WIDEST DATE, NOT A TYPICAL ONE. "19/09/2026" has a
   * narrow 1 in it, and passed a 58pt column that broke "22/09/2026" into
   * "22/09/202" over "6". Every date of five years is measured against it.
   */
  it('measures dates against a sample no real date is wider than', () => {
    const bound = measureText(DATE_SAMPLE);
    let widest = 0;
    for (let day = Date.UTC(2026, 0, 1); day < Date.UTC(2031, 0, 1); day += 86_400_000) {
      const d = new Date(day);
      const text = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
      widest = Math.max(widest, measureText(text));
    }
    expect(widest).toBeLessThanOrEqual(bound);
    // And the sample would have caught the column that shipped.
    expect(() =>
      assertCellsFit('probe', [{ header: 'Thời gian', width: 58, value: () => '' }], {
        'Thời gian': DATE_SAMPLE,
      }),
    ).toThrow(/must hold "44\/44\/4444"/);
  });
});
