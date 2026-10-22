/**
 * "MỨC ĐỘ" — Cao / Trung bình / Thấp, on exactly three record types: "Vấn đề
 * khách yêu cầu", "Sự cố cơ sở vật chất" (the incident itself, which the journal
 * entry points at) and "Vấn đề về chất lượng và dịch vụ". The one definition:
 * the labels, the default, the order and the filter all live here.
 *
 * OLDER RECORDS ARE NOT GIVEN A LEVEL. Anything recorded before the question was
 * asked keeps severity NULL and reads "Chưa phân mức" — it sorts after Thấp and
 * appears only under "Tất cả mức độ". Guessing a level for it would be inventing
 * an urgency nobody judged.
 */
import type { IssueSeverity, Prisma } from '@prisma/client';
import { ApiError } from '../lib/errors';

/** Declaration order IS the priority order (the database enum sorts the same way). */
export const SEVERITIES: readonly IssueSeverity[] = ['HIGH', 'MEDIUM', 'LOW'];

export const SEVERITY_LABELS: Record<IssueSeverity, string> = {
  HIGH: 'Cao',
  MEDIUM: 'Trung bình',
  LOW: 'Thấp',
};

/** What a record from before the level existed says instead. */
export const UNRATED_SEVERITY_LABEL = 'Chưa phân mức';

/**
 * A new record that names no level is "Trung bình" — the level the forms start
 * on, so the screen and an API caller that omits it end up in the same place.
 */
export const DEFAULT_SEVERITY: IssueSeverity = 'MEDIUM';

export function severityLabel(severity: IssueSeverity | null): string {
  return severity ? SEVERITY_LABELS[severity] : UNRATED_SEVERITY_LABEL;
}

/** One of the three, or refused — never coerced into one. */
export function parseSeverity(raw: unknown): IssueSeverity {
  if (typeof raw === 'string' && (SEVERITIES as readonly string[]).includes(raw)) return raw as IssueSeverity;
  throw ApiError.validation('Mức độ phải là Cao, Trung bình hoặc Thấp.');
}

/** Cao 0 · Trung bình 1 · Thấp 2 · Chưa phân mức 3. */
export function severityRank(severity: IssueSeverity | null): number {
  return severity ? SEVERITIES.indexOf(severity) : SEVERITIES.length;
}

/**
 * The ORDER BY of a list that holds only unresolved work: Cao → Trung bình →
 * Thấp → Chưa phân mức, newest first within a level — the order `prioritise`
 * gives a mixed list, done by the database so pagination keeps it.
 */
export const SEVERITY_FIRST = [
  { severity: { sort: 'asc', nulls: 'last' } },
  { createdAt: 'desc' },
] as const satisfies Prisma.HotelIssueOrderByWithRelationInput[];

/**
 * THE DEFAULT ORDER OF A LIST THAT HOLDS UNRESOLVED WORK: unresolved records
 * first, by level (Cao → Trung bình → Thấp → Chưa phân mức), newest first within
 * a level; resolved records after them, in the order they came in (newest first),
 * so a completion's place still follows its date. Stable, and pure — archives
 * and completed lists never go through it.
 */
export function prioritise<T>(
  rows: readonly T[],
  isOpen: (row: T) => boolean,
  severityOf: (row: T) => IssueSeverity | null,
  createdAt: (row: T) => Date,
): T[] {
  const open = rows.filter(isOpen);
  const done = rows.filter((r) => !isOpen(r));
  open.sort(
    (a, b) =>
      severityRank(severityOf(a)) - severityRank(severityOf(b)) || createdAt(b).getTime() - createdAt(a).getTime(),
  );
  return [...open, ...done];
}
