/**
 * Date and label formatting for reports, in Asia/Ho_Chi_Minh.
 *
 * A report is read by a person in Vietnam, so every instant in one is printed in
 * their wall-clock time, never UTC. The conversion is the same constant-offset
 * arithmetic the rest of the server uses (`lib/clock.ts`) rather than a second
 * timezone mechanism.
 */
import { HCM_OFFSET_MS } from '../lib/clock';

function shifted(instant: Date): Date {
  return new Date(instant.getTime() + HCM_OFFSET_MS);
}

/** "17/09/2026 14:05" */
export function hcmDateTime(instant: Date | null | undefined): string {
  if (!instant) return '—';
  const iso = shifted(instant).toISOString();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
}

/** "01/09/2026" from an ISO "YYYY-MM-DD" day string (no timezone maths). */
export function hcmDayLabel(day: string): string {
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}

/** "01/09/2026 – 30/09/2026" */
export function periodLabel(from: string, to: string): string {
  return `${hcmDayLabel(from)} – ${hcmDayLabel(to)}`;
}

/**
 * Sorts a count map into stable, readable report rows: biggest first, and ties
 * broken by label so two runs over the same data never disagree.
 */
export function rankedTotals(counts: Map<string, number>): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'vi'));
}

/**
 * Builds a Content-Disposition value that survives a Vietnamese file name.
 *
 * `filename*=UTF-8''…` is the RFC 5987 form every current browser understands;
 * the plain `filename=` beside it is a stripped-to-ASCII fallback so an older
 * client still gets something openable instead of a mangled name.
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName
    // đ/Đ is a distinct letter, not a base plus a combining mark, so NFD leaves
    // it alone and it would otherwise become "_" in the fallback name.
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    // A quote would terminate the quoted-string early and split the header.
    .replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
