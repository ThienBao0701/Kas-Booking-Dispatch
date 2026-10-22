/**
 * What the legacy SQLite pilot called things, versus what the PostgreSQL target
 * calls them now.
 *
 * WHY THIS FILE EXISTS
 *
 * The transfer tool matches source columns to target columns BY NAME, and it
 * treats a source column with no target counterpart as data loss — a hard error,
 * never a silent skip (`transfer.ts`, D.1 §8). That is the right default: it is
 * what stops a column quietly disappearing during a migration.
 *
 * It also means a RENAME in the live schema breaks the transfer, because the
 * archived SQLite migrations still create the old name — as they must. Those
 * migrations are a historical record of a database that really existed, and
 * editing them to match today's schema would be inventing a past in which the
 * pilot already used names that had not been thought of yet.
 *
 * So the rename is recorded HERE instead, once, as the one thing the tool cannot
 * infer: that `HotelIssue.resolvedAt` and `HotelIssue.completedAt` are the same
 * column under two names.
 *
 * ADDING TO THIS FILE IS THE LAST RESORT, NOT THE FIRST. A missing column should
 * normally be fixed by adding it to the target. Only a genuine rename belongs
 * here, and only with the migration that performed it named in the comment.
 */

/** Target column name → the name the legacy SQLite source used for it. */
type ColumnRenames = Record<string, string>;

/**
 * Renamed by `20260917120000_reception_shifts_and_technical_department`, when
 * the incident lifecycle gained a real COMPLETED state and the columns were
 * renamed to match the enum value.
 */
const HOTEL_ISSUE_RENAMES: ColumnRenames = {
  completedAt: 'resolvedAt',
  completedByUserId: 'resolvedByUserId',
};

const COLUMN_RENAMES: Record<string, ColumnRenames> = {
  HotelIssue: HOTEL_ISSUE_RENAMES,
};

/**
 * Enum values the legacy source holds, and what they are called in the target.
 *
 * Keyed by the PostgreSQL enum TYPE name, because that is what the target
 * introspection reports — the same legacy label under two different enums would
 * otherwise be mapped by accident.
 */
const ENUM_VALUE_RENAMES: Record<string, Record<string, string>> = {
  // ALTER TYPE "IssueStatus" RENAME VALUE 'RESOLVED' TO 'COMPLETED'.
  IssueStatus: { RESOLVED: 'COMPLETED' },
};

/** The name a target column is stored under in the legacy source. */
export function sourceColumnFor(table: string, targetColumn: string): string {
  return COLUMN_RENAMES[table]?.[targetColumn] ?? targetColumn;
}

/** Every legacy name this table maps away from, so planning can exempt them. */
export function legacySourceNames(table: string): Set<string> {
  return new Set(Object.values(COLUMN_RENAMES[table] ?? {}));
}

/** Translates a legacy enum label into the value the target's enum holds. */
export function renameEnumValue(enumType: string | null, value: string): string {
  if (!enumType) return value;
  return ENUM_VALUE_RENAMES[enumType]?.[value] ?? value;
}
