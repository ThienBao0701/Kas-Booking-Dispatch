/**
 * "Số lượng" as a person typed it: a whole number of at least 1, or null.
 *
 * NEVER COERCED. `Number("")` is 0 and `Number("abc")` is NaN, and either would
 * become a quantity if this guessed — so anything that is not plain digits, and
 * anything below 1, is "not a quantity yet". The server applies the same rule
 * (`assertQuantity`) and refuses whatever this lets through.
 */
export function parseQuantity(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}
