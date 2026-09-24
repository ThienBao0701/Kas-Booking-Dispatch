# TASK_STATE — Reception Operational Reporting V3

Branch `feature/cn1-pilot-workflow-v1`, baseline `444a1c7`. Development only. Nothing committed.

## Current
Money-column boundary closed. Full server suite running; everything else verified.

## The money boundary, and what it uncovered
The PDF now sizes its money columns for **9.999.999.999 ₫** (`PDF_MONEY_CEILING`), verified by eye:
the ten-digit value sits on one line in all five columns, right-aligned, `₫` in the header.

Writing the end-to-end test for it surfaced a worse defect underneath. The money columns are Prisma
`Int` = PostgreSQL **INTEGER**, which stops at **2.147.483.647** — but `assertMoney` accepted up to
9.999.999.999. Anything between the two passed validation and then died in the driver:

    Unable to fit integer value '9999999999' into an INT4 (32-bit signed integer)

…so the receptionist got a **500 naming no field at all**. A ceiling the storage cannot honour is not
a ceiling, it is a crash with extra steps.

Resolution, given "do not change the database architecture":
- `MAX_VND` now equals the column's real capacity, 2.147.483.647, so an over-large amount is refused
  cleanly with a 422. The zod schema derives its `.max()` from it rather than repeating a literal.
- The PDF ceiling stays at 9.999.999.999 — four and a half times the storage limit — and asserts at
  import that it is ≥ `MAX_VND`. Raising `MAX_VND` (e.g. after a `BigInt` migration) therefore cannot
  silently start corrupting printed amounts.

**This lowers the accepted maximum**, which the instruction warned against. The reason is not the PDF
— the report handles far more than the column does. It is that the old number was never storable.
The alternative is widening the columns to `BigInt`, which is a schema change and a decision about
money rather than layout; say the word and I will do that instead.

## Earlier passes
- Adversarial review: six defects (period cash summed each shift's opening ≈20× the real drawer;
  overnight shifts lost their opening; the ledger listed every shift under one shift's totals; the
  Admin list capped at 500 silently; a correction's audit "old value" came from a pre-transaction
  read with no void guard; an empty "Tiền đầu ca" saved a permanent counted 0). All fixed and pinned.
- PDF visual validation: six more (footers created the pages they numbered — 52 pages for 26 of
  content; one header cell per page; section titles stacked down the right margin; mid-word and
  mid-number wrapping; `→` has no glyph so upgrades printed with nothing between the room classes;
  money left-aligned). Three were in the shared `report/pdf.ts` and affected all five PDF reports.

## Results
- Client **907/907** (72 files). Typecheck, lint, build clean. Migration diff empty. Whitespace clean.
- Server suite running.

## Known failures
- `chargeDocuments.test.ts` monthly-report fixture — pre-existing, date-sensitive, unrelated.
