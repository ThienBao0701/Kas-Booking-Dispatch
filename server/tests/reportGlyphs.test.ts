/**
 * EVERY CHARACTER A PDF BUILDER CAN EMIT MUST EXIST IN THE EMBEDDED FONT.
 *
 * WHY THIS IS A TEST AND NOT A CODE REVIEW HABIT
 *
 * A missing glyph does not throw, does not warn and does not draw a box. pdfkit
 * substitutes `.notdef`, which in Be Vietnam Pro is BLANK — so the text simply
 * loses a character and the report looks fine to whoever generated it. That is
 * the exact failure the font was embedded to prevent for ạ/ệ/ữ/đ, and it came
 * back through the side door: "Superior Twin → Executive Suite" printed as two
 * room classes separated by nothing, with no way to tell which was the upgrade.
 *
 * The check scans the SOURCE of the PDF builders rather than a rendered file,
 * because a rendered file only exercises the fixtures somebody thought to write.
 * Comments are scanned too — deliberately. Keeping the sources to characters the
 * font can draw costs nothing and removes the chance of a symbol migrating from
 * a comment into a template string.
 *
 * The XLSX builder is NOT scanned: Excel renders with the reader's own fonts, so
 * an arrow there is fine.
 *
 * COVERAGE IS ASKED OF THE FONT THE REPORTS ACTUALLY EMBED, through the same
 * pdfkit registration they use — not of a font file opened separately, which
 * could drift from the one that ships.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { FONT_BOLD, FONT_REGULAR } from '../src/report/pdf';

const REPORT_DIR = path.join(__dirname, '..', 'src', 'report');
const FONT_DIR = path.join(REPORT_DIR, 'fonts');

/** Both weights: a heading in SemiBold needs the glyph as much as body text. */
const FONTS = [
  { name: FONT_REGULAR, file: 'BeVietnamPro-Regular.ttf' },
  { name: FONT_BOLD, file: 'BeVietnamPro-SemiBold.ttf' },
];

/** `pdf.ts` plus every `*Pdf.ts`, and the formatter they all share. */
function pdfSources(): string[] {
  return fs
    .readdirSync(REPORT_DIR)
    .filter((f) => f === 'pdf.ts' || f === 'format.ts' || f.endsWith('Pdf.ts'))
    .map((f) => path.join(REPORT_DIR, f));
}

/**
 * Asks the REGISTERED font whether it can draw a code point.
 *
 * Reaches through `doc._font` because pdfkit exposes no public coverage query.
 * The alternative — measuring widths — cannot tell a missing glyph from a narrow
 * one: `.notdef` here is 4pt wide at 8pt, and so is a real comma.
 */
function coverage(file: string, name: string): (cp: number) => boolean {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 });
  doc.registerFont(name, fs.readFileSync(path.join(FONT_DIR, file)));
  doc.font(name);
  const embedded = (doc as unknown as { _font?: { font?: { hasGlyphForCodePoint(cp: number): boolean } } })._font;
  const font = embedded?.font;
  if (!font) throw new Error(`pdfkit did not expose the embedded font for ${file}`);
  return (cp) => font.hasGlyphForCodePoint(cp);
}

describe('the embedded font can draw everything the PDF reports say', () => {
  it('scans every PDF builder, and there is more than one', () => {
    const files = pdfSources();
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files.some((f) => f.endsWith('operationalPdf.ts'))).toBe(true);
  });

  for (const { name, file } of FONTS) {
    it(`covers every character used, in ${file}`, () => {
      const has = coverage(file, name);

      const missing: Record<string, string[]> = {};
      for (const source of pdfSources()) {
        const text = fs.readFileSync(source, 'utf8');
        for (const char of new Set(Array.from(text))) {
          const cp = char.codePointAt(0)!;
          // ASCII is universal; only the interesting characters matter.
          if (cp < 0x80 || has(cp)) continue;
          const key = `U+${cp.toString(16).toUpperCase().padStart(4, '0')} ${char}`;
          missing[key] = [...(missing[key] ?? []), path.basename(source)];
        }
      }

      expect(
        missing,
        'a character with no glyph renders as nothing at all, silently',
      ).toEqual({});
    });
  }

  it('knows what a missing glyph looks like, so the check cannot silently pass', () => {
    const has = coverage(FONTS[0]!.file, FONTS[0]!.name);
    // The one that actually broke: U+2192 RIGHTWARDS ARROW.
    expect(has(0x2192)).toBe(false);
    // …and three the reports rely on, so the probe is not just always-false.
    expect(has(0x20ab)).toBe(true); // ₫
    expect(has(0x00b7)).toBe(true); // ·
    expect(has(0x2013)).toBe(true); // –
  });
});
