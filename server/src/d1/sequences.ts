/**
 * PostgreSQL sequence resynchronisation (D.1 §12).
 *
 * THE FAILURE THIS PREVENTS: SQLite's `autoincrement` primary keys are plain
 * ROWIDs. PostgreSQL's are backed by a sequence, and a sequence is advanced
 * ONLY by `nextval` — inserting `id = 7` explicitly leaves the sequence at 1.
 * A transfer that imports eight branches with explicit ids and then hands the
 * database to the application produces a duplicate-key error on the very first
 * branch an Admin creates, in production, with no obvious cause.
 *
 * So after every explicit-ID import each sequence is set to MAX(id) + 1, and
 * the result is verified rather than assumed.
 */
import type { PrismaClient } from '@prisma/client';
import { sequenceColumns, type TargetSchema } from './targetSchema';

export interface SequenceSyncResult {
  table: string;
  column: string;
  sequence: string;
  /** Highest id actually present after the import. */
  maxId: number | null;
  /** What `nextval` will return next. */
  nextValue: number;
  ok: boolean;
  problem?: string;
}

type RawClient = Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

/**
 * Advances every sequence to MAX(column) + 1.
 *
 * `setval(seq, n, false)` is used rather than `setval(seq, n)`: the `false`
 * means "n has not been used yet", so the next `nextval` returns exactly n.
 * With `COALESCE(MAX(id), 0) + 1` that is MAX+1 for a populated table and 1
 * for an empty one — both correct, and neither burns an id.
 */
export async function resyncSequences(
  client: RawClient,
  schema: TargetSchema,
): Promise<SequenceSyncResult[]> {
  const results: SequenceSyncResult[] = [];

  for (const { table, column, sequence } of sequenceColumns(schema)) {
    const rows = await client.$queryRawUnsafe<{ max_id: number | null; next_value: number }[]>(
      `SELECT MAX("${column}")::int AS max_id,
              setval('${sequence}', COALESCE(MAX("${column}"), 0) + 1, false)::int AS next_value
         FROM "${table}"`,
    );
    const row = rows[0];
    const maxId = row?.max_id ?? null;
    const nextValue = Number(row?.next_value ?? 1);
    const expected = (maxId ?? 0) + 1;

    results.push({
      table,
      column,
      sequence,
      maxId,
      nextValue,
      ok: nextValue === expected,
      ...(nextValue === expected
        ? {}
        : { problem: `nextval sẽ trả về ${nextValue}, mong đợi ${expected}` }),
    });
  }

  return results;
}

export interface SequenceCheck {
  table: string;
  column: string;
  sequence: string;
  maxId: number | null;
  /** The value the sequence would hand out next, WITHOUT consuming it. */
  nextValue: number;
  /** False when the next id would collide with an existing row. */
  ok: boolean;
}

/**
 * Read-only audit of every sequence: would the next insert collide?
 *
 * Used by the verification report and by the automated tests. It reads
 * `last_value`/`is_called` from the sequence rather than calling `nextval`, so
 * running the check never changes the database it is checking.
 */
export async function checkSequences(
  client: RawClient,
  schema: TargetSchema,
): Promise<SequenceCheck[]> {
  const checks: SequenceCheck[] = [];

  for (const { table, column, sequence } of sequenceColumns(schema)) {
    // `last_value`/`is_called` live on the sequence RELATION, not on the
    // pg_sequences view (which exposes last_value only). Reading the relation
    // is also the only way to learn `is_called`, and — unlike calling
    // `nextval` — it does not consume an id, so an audit never mutates what
    // it is auditing. `sequence` comes from pg_get_serial_sequence and is
    // already schema-qualified and correctly quoted.
    const rows = await client.$queryRawUnsafe<
      { max_id: number | null; last_value: bigint | number; is_called: boolean }[]
    >(
      `SELECT (SELECT MAX("${column}")::int FROM "${table}") AS max_id,
              s.last_value,
              s.is_called
         FROM ${sequence} s`,
    );

    const row = rows[0];
    const maxId = row?.max_id ?? null;
    const lastValue = Number(row?.last_value ?? 0);
    // `is_called = false` means last_value itself is handed out next.
    const nextValue = row?.is_called ? lastValue + 1 : lastValue;

    checks.push({
      table,
      column,
      sequence,
      maxId,
      nextValue,
      ok: maxId === null ? nextValue >= 1 : nextValue > maxId,
    });
  }

  return checks;
}
