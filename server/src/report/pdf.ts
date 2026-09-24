/**
 * PDF reports, in Vietnamese.
 *
 * WHY A FONT IS SHIPPED WITH THE APPLICATION
 *
 * PDF's built-in fonts (Helvetica and friends) are WinAnsi-encoded: they have no
 * glyph for ạ, ệ, ữ, ố or đ. Rendering a Vietnamese report with them does not
 * fail — it silently produces missing or stripped diacritics, which is exactly
 * the failure mode that makes a report untrustworthy. So the document embeds a
 * real Unicode font, subsetted into the file, and every string in every report
 * goes through it.
 *
 * Be Vietnam Pro is used because it is a Vietnamese-designed typeface under the
 * SIL Open Font License (`fonts/OFL.txt`), which permits redistribution and
 * embedding. Its coverage of the full Vietnamese alphabet was verified glyph by
 * glyph, not assumed.
 *
 * WHY THE FILES ARE RESOLVED FROM `__dirname`
 *
 * In development this module runs from `src/report`; in production it runs from
 * `dist/report`, and `scripts/copyAssets.mjs` mirrors the fonts across during
 * the build. Resolving relative to the module keeps both correct without a
 * process-wide base path that a service runner could set differently.
 *
 * WHY IT BUILDS A BUFFER
 *
 * Same convention as the XLSX charge report (`charge/chargeReportExport.ts`): a
 * function returns bytes, the route decides the headers. Nothing here reads the
 * database, and nothing here computes a total — a report is rendered from data
 * a caller already has, so a number in the PDF cannot disagree with the number
 * on the screen it was printed from.
 */
import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FONT_DIR = join(__dirname, 'fonts');

export const FONT_REGULAR = 'VN';
export const FONT_BOLD = 'VN-Bold';

/**
 * Read once per process. A report endpoint is rare but not unique, and re-reading
 * 260 KB of font from disk on every request would be pure waste.
 */
let cachedFonts: { regular: Buffer; bold: Buffer } | null = null;

function fonts(): { regular: Buffer; bold: Buffer } {
  if (!cachedFonts) {
    cachedFonts = {
      regular: readFileSync(join(FONT_DIR, 'BeVietnamPro-Regular.ttf')),
      bold: readFileSync(join(FONT_DIR, 'BeVietnamPro-SemiBold.ttf')),
    };
  }
  return cachedFonts;
}

export type PdfDoc = PDFKit.PDFDocument;

export interface ReportHeader {
  /** e.g. "KAS – BÁO CÁO ĐƠN CẦN TẠO LẠI". */
  title: string;
  /** "01/09/2026 – 30/09/2026". */
  period: string;
  /** When the report was produced, already formatted in Asia/Ho_Chi_Minh. */
  generatedAt: string;
  /** "Tất cả chi nhánh" or one branch's name. */
  scope: string;
}

export interface Column<T> {
  header: string;
  width: number;
  value: (row: T) => string;
  /**
   * RIGHT for money, left for everything else.
   *
   * Left-aligned amounts are readable one at a time and unreadable as a column:
   * the digit that means a hundred million sits under the digit that means a
   * hundred thousand, and the eye cannot compare them. A cash sheet is read by
   * running down the column.
   */
  align?: 'left' | 'right';
}

/** A4 landscape is 841.89pt wide; `createReportDocument` uses a 32pt margin. */
export const LANDSCAPE_CONTENT_WIDTH = 841.89 - 32 * 2;

/**
 * Refuses a column set that does not fit the page, AT IMPORT TIME.
 *
 * `drawTable` places each cell at a running x offset and never checks it, so an
 * over-wide table does not fail — it draws the last columns off the edge of the
 * paper, where they are simply absent from the printed report and from the PDF
 * anybody opens. That is the worst possible failure for an audit document:
 * silent, invisible, and only discovered by somebody who already needed the
 * missing number.
 *
 * The incident report shipped in exactly that state — twelve columns summing to
 * 906pt against 777.89pt of usable width — for as long as it has existed. This
 * makes the same mistake a startup crash instead.
 */
export function assertFitsLandscape<T>(label: string, columns: Column<T>[]): Column<T>[] {
  const total = columns.reduce((sum, c) => sum + c.width, 0);
  if (total > LANDSCAPE_CONTENT_WIDTH) {
    throw new Error(
      `${label}: columns total ${total}pt but only ${LANDSCAPE_CONTENT_WIDTH.toFixed(2)}pt fit on A4 landscape.`,
    );
  }
  return columns;
}

/**
 * A throwaway document used only to MEASURE text in the real embedded font.
 *
 * Created once, lazily. Column widths were previously set by eye, and the
 * report shipped with "Booking.com" rendered as "Booking.c / om" and an amount
 * broken in the middle of its digits. A width is a measurable fact, so it is
 * measured.
 */
let cachedRuler: PdfDoc | null = null;

function ruler(): PdfDoc {
  if (!cachedRuler) {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 });
    const { regular, bold } = fonts();
    doc.registerFont(FONT_REGULAR, regular);
    doc.registerFont(FONT_BOLD, bold);
    cachedRuler = doc;
  }
  return cachedRuler;
}

/** Width of a string in the report's own font, at the table's own size. */
export function measureText(text: string, weight: 'regular' | 'bold' = 'regular'): number {
  return ruler()
    .font(weight === 'bold' ? FONT_BOLD : FONT_REGULAR)
    .fontSize(8)
    .widthOfString(text);
}

/** The usable width inside a cell — `drawTable` pads both sides by 4pt. */
export function usableWidth(column: Column<unknown>): number {
  return column.width - 8;
}

/**
 * Refuses a header whose LONGEST WORD cannot fit, AT IMPORT TIME.
 *
 * THE RULE IS ABOUT WORDS, NOT LINES. "Thu tiền mặt (₫)" wrapping onto two
 * lines is ordinary typesetting and perfectly readable — the break falls at a
 * space. "STT" coming out as "ST / T" is not: pdfkit broke inside the word
 * because the column was six points too narrow, and to a reader that is
 * indistinguishable from corruption. Exactly that shipped in the first draft of
 * this report.
 *
 * Cell CONTENTS are not checked here: they are unbounded free text, and a
 * wrapped guest name is correct behaviour. The measured contents that must fit —
 * amounts, codes, sources — are asserted by {@link assertCellsFit}.
 */
export function assertHeadersFit<T>(label: string, columns: Column<T>[]): Column<T>[] {
  for (const column of columns) {
    const usable = usableWidth(column as Column<unknown>);
    for (const word of column.header.split(/\s+/).filter(Boolean)) {
      const width = measureText(word, 'bold');
      if (width > usable) {
        throw new Error(
          `${label}: header word "${word}" (in "${column.header}") needs ${width.toFixed(1)}pt but its column leaves ${usable.toFixed(1)}pt.`,
        );
      }
    }
  }
  return columns;
}

/**
 * Refuses a column that cannot hold a sample value it is SUPPOSED to hold.
 *
 * Used for the cells whose widest realistic content is known in advance: a
 * nine-digit đồng amount, a PMS code, an OTA name. Anything free-form is left
 * out — the point is to pin the values a reader would call broken if they split,
 * not to forbid wrapping in general.
 */
/**
 * A date at its WIDEST: every digit the font's widest numeral, 4. "19/09/2026"
 * was the sample once, and a 1 is narrow — the guard passed a column that broke
 * "22/09/2026" into "22/09/202" over "6". This bounds every real date.
 */
export const DATE_SAMPLE = '44/44/4444';

export function assertCellsFit<T>(
  label: string,
  columns: Column<T>[],
  samples: Record<string, string>,
): Column<T>[] {
  for (const column of columns) {
    const sample = samples[column.header];
    if (sample === undefined) continue;
    const width = measureText(sample);
    const usable = usableWidth(column as Column<unknown>);
    if (width > usable) {
      throw new Error(
        `${label}: "${column.header}" must hold "${sample}" (${width.toFixed(1)}pt) but leaves ${usable.toFixed(1)}pt.`,
      );
    }
  }
  return columns;
}

/**
 * Starts a new page when `height` would not fit below the current cursor.
 *
 * WHY WRITING PAST THE BOTTOM MARGIN IS NOT A SMALL MISTAKE
 *
 * pdfkit's line wrapper compares every line against `page.maxY()` and starts a
 * NEW PAGE when one would cross it. So text placed below the margin does not
 * overflow the page — it silently lands on a fresh one. A table header drawn
 * cell by cell at such a position therefore produces ONE PAGE PER COLUMN: the
 * operational report shipped with ten consecutive pages each holding a single
 * word, because a section happened to start near the bottom of a page.
 *
 * Every block that draws at an explicit y must reserve its height first.
 */
export function ensureSpace(doc: PdfDoc, height: number): void {
  if (doc.y + height > doc.page.maxY()) doc.addPage();
}

/**
 * Landscape A4 by default: the incident and accountability tables are wide, and
 * portrait would force either a microscopic type size or wrapped columns.
 */
export function createReportDocument(header: ReportHeader, landscape = true): PdfDoc {
  const doc = new PDFDocument({
    size: 'A4',
    layout: landscape ? 'landscape' : 'portrait',
    margin: 32,
    // Required by `addPageNumbers`: without it the pages are flushed as they are
    // written and cannot be revisited to stamp "Trang 2/7", because the total is
    // only known at the end.
    bufferPages: true,
    // Written into the PDF's own metadata so a file found later still says what
    // it is.
    info: { Title: header.title, Author: 'KAS' },
  });

  const { regular, bold } = fonts();
  doc.registerFont(FONT_REGULAR, regular);
  doc.registerFont(FONT_BOLD, bold);

  doc.font(FONT_BOLD).fontSize(15).text(header.title);
  doc.moveDown(0.3);
  doc.font(FONT_REGULAR).fontSize(9);
  doc.text(`Kỳ báo cáo: ${header.period}`);
  doc.text(`Phạm vi: ${header.scope}`);
  doc.text(`Xuất lúc: ${header.generatedAt}`);
  doc.moveDown(0.6);

  return doc;
}

/** Collects the stream into one Buffer, the way the XLSX export returns one. */
export function finishDocument(doc: PdfDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export function sectionTitle(doc: PdfDoc, text: string): void {
  /*
    BACK TO THE LEFT MARGIN FIRST.

    `drawTable` writes each cell with an explicit x, and pdfkit leaves `doc.x`
    wherever the last one was — near the RIGHT edge of the page. Any later
    `doc.text()` that does not name an x therefore starts there, inside a column
    a few points wide: the section headings after a table came out stacked
    vertically down the right margin, one or two words per line.
  */
  doc.x = doc.page.margins.left;
  doc.moveDown(0.5);
  // The heading plus one line of whatever follows it: a title alone at the foot
  // of a page, with its table overleaf, is a heading nobody reads as one.
  ensureSpace(doc, 32);
  doc.font(FONT_BOLD).fontSize(11).text(text);
  doc.moveDown(0.2);
  doc.font(FONT_REGULAR).fontSize(8);
}

const ROW_PADDING = 4;
const HEADER_FILL = '#E8EEF4';
const ROW_STRIPE = '#F6F8FA';

function rowHeight(doc: PdfDoc, columns: Column<unknown>[], cells: string[]): number {
  let tallest = 0;
  cells.forEach((text, i) => {
    const width = columns[i]!.width - ROW_PADDING * 2;
    tallest = Math.max(tallest, doc.heightOfString(text || '—', { width }));
  });
  return tallest + ROW_PADDING * 2;
}

/**
 * Draws a table, repeating the header row on every page.
 *
 * Rows are measured before they are drawn so a long description wraps inside its
 * cell instead of overrunning the next column — a report that silently truncates
 * the one free-text field it carries is worse than no report.
 */
/**
 * The height a table needs before its first row is on the page: the header
 * plus that row. A caller printing a heading above a table reserves this much
 * too, so the heading is never left at the foot of a page on its own.
 */
export function tableLeadHeight<T>(doc: PdfDoc, columns: Column<T>[], rows: T[]): number {
  const cols = columns as Column<unknown>[];
  doc.font(FONT_BOLD).fontSize(8);
  const header = rowHeight(doc, cols, columns.map((c) => c.header));
  doc.font(FONT_REGULAR).fontSize(8);
  const first = rows.length > 0 ? rowHeight(doc, cols, columns.map((c) => c.value(rows[0]!) || '—')) : 0;
  return header + first;
}

export function drawTable<T>(doc: PdfDoc, columns: Column<T>[], rows: T[]): void {
  const cols = columns as Column<unknown>[];
  const startX = doc.page.margins.left;

  // The header goes with its first row: a header alone at the foot of a page,
  // its rows on the next, reads as an empty table.
  ensureSpace(doc, tableLeadHeight(doc, columns, rows));

  const drawHeader = (): void => {
    const cells = columns.map((c) => c.header);
    doc.font(FONT_BOLD).fontSize(8);
    const h = rowHeight(doc, cols, cells);
    // BEFORE anything is drawn. Without this the header lands one cell per page.
    ensureSpace(doc, h);
    doc.rect(startX, doc.y, cols.reduce((s, c) => s + c.width, 0), h).fill(HEADER_FILL);
    let x = startX;
    const top = doc.y;
    doc.fillColor('#000').font(FONT_BOLD).fontSize(8);
    cells.forEach((text, i) => {
      doc.text(text, x + ROW_PADDING, top + ROW_PADDING, {
        width: cols[i]!.width - ROW_PADDING * 2,
        align: cols[i]!.align ?? 'left',
      });
      x += cols[i]!.width;
    });
    doc.y = top + h;
    doc.font(FONT_REGULAR).fontSize(8);
  };

  drawHeader();

  rows.forEach((row, index) => {
    const cells = columns.map((c) => c.value(row) || '—');
    const h = rowHeight(doc, cols, cells);

    // A row that would cross the bottom margin starts a new page, with the
    // header repeated — otherwise page 2 onwards is a grid of unlabelled cells.
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader();
    }

    const top = doc.y;
    if (index % 2 === 1) {
      doc.rect(startX, top, cols.reduce((s, c) => s + c.width, 0), h).fill(ROW_STRIPE);
      doc.fillColor('#000');
    }
    let x = startX;
    cells.forEach((text, i) => {
      doc.text(text, x + ROW_PADDING, top + ROW_PADDING, {
        width: cols[i]!.width - ROW_PADDING * 2,
        align: cols[i]!.align ?? 'left',
      });
      x += cols[i]!.width;
    });
    doc.y = top + h;
  });

  // Hand the cursor back at the left margin: every cell above moved it, and the
  // next caller has no reason to know that.
  doc.x = startX;
}

/** "Tổng cộng: 12" style lines under a table. */
export function drawTotals(doc: PdfDoc, title: string, entries: [string, number][]): void {
  sectionTitle(doc, title);
  if (entries.length === 0) {
    doc.font(FONT_REGULAR).fontSize(8).text('Không có dữ liệu.');
    return;
  }
  doc.font(FONT_REGULAR).fontSize(8);
  for (const [label, count] of entries) {
    doc.text(`${label}: ${count}`);
  }
}

/**
 * Page numbers, added after the content so the total is known.
 *
 * THE BOTTOM MARGIN IS TEMPORARILY REMOVED, AND THAT IS THE WHOLE TRICK.
 *
 * The footer is deliberately written INSIDE the bottom margin, below
 * `page.maxY()`, so it cannot collide with a table row. But pdfkit's line
 * wrapper treats a line that crosses `maxY()` as an overflow and starts a new
 * page — so every footer used to land on a freshly created page instead of the
 * one it was numbering. The reports came out at exactly double length: N pages
 * of content, then N pages holding nothing but "Trang k/N".
 *
 * Zeroing `margins.bottom` for the duration moves `maxY()` to the foot of the
 * paper, so the footer is an ordinary line on the page it belongs to. The margin
 * is restored per page, because `switchToPage` hands back a different object
 * each time.
 */
export function addPageNumbers(doc: PdfDoc): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font(FONT_REGULAR)
      .fontSize(7)
      .fillColor('#555')
      .text(
        `Trang ${i - range.start + 1}/${range.count}`,
        doc.page.margins.left,
        doc.page.height - bottom + 8,
        {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          align: 'right',
          lineBreak: false,
        },
      );
    doc.page.margins.bottom = bottom;
  }
  doc.fillColor('#000');
}
