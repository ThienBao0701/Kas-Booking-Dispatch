/**
 * MONEY INPUT, in Vietnamese đồng.
 *
 * WHY THIS IS A SEPARATE MODULE FROM `format.ts`
 *
 * `formatMoney` renders a number that has already been decided. This handles the
 * half-typed states: what the operator sees while typing "3150000", and the
 * integer that gets sent. Those are different jobs with different failure modes,
 * and mixing them is how a display string ends up in a request body.
 *
 * THE RULE: THE DISPLAY IS DERIVED, THE VALUE IS AN INTEGER.
 *
 * The component holds a string because an input holds a string, and every
 * submission converts it with {@link parseVnd}, which returns `null` rather than
 * a guess. `Number("")` is 0 and `Number("3.150.000")` is NaN — one of those
 * would silently store a zero-đồng payment, which is exactly the kind of error a
 * cash reconciliation cannot explain afterwards.
 */

/** "3150000" → "3.150.000". Empty input stays empty — not "0". */
export function groupDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  if (!digits) return '';
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += '.';
    out += digits[i];
  }
  return out;
}

/**
 * The integer to send, or null when the field is empty.
 *
 * Non-digits are STRIPPED rather than rejected, because they are what a grouped
 * display is made of: the field shows "3.150.000" and must round-trip to
 * 3150000. An empty field is null and never 0 — "nothing entered" and "zero
 * đồng" are different answers, and only the caller knows which one is allowed.
 */
export function parseVnd(raw: string): number | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/** The same as {@link parseVnd} but with an explicit zero for optional fields. */
export function parseVndOrZero(raw: string): number {
  return parseVnd(raw) ?? 0;
}

/** "7570000" → "7.570.000 ₫". Null stays a dash; money is never invented. */
export function formatVnd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  const negative = amount < 0;
  return `${negative ? '-' : ''}${groupDigits(String(Math.abs(Math.round(amount))))} ₫`;
}

/**
 * What a money `<input>` needs to bring up a numeric keypad on a phone.
 *
 * `type="text"` with `inputMode="numeric"`, NOT `type="number"`. A number input
 * cannot display the grouped form at all, adds spinner arrows nobody at a
 * reception desk wants, and on several mobile browsers silently discards the
 * value when a stray character is typed — which, on a cash field, means the
 * amount vanishes between typing it and pressing save.
 */
export const MONEY_INPUT_PROPS = {
  type: 'text' as const,
  inputMode: 'numeric' as const,
  autoComplete: 'off',
};
