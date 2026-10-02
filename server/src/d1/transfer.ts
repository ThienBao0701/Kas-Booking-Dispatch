/**
 * SQLite → PostgreSQL data transfer (Phase D.1 §8).
 *
 * WHAT THIS IS: a storage migration. Rows are moved from one engine to another
 * with their identities, relationships and timestamps intact.
 *
 * WHAT THIS IS EXPLICITLY NOT: a re-interpretation of business data. It never
 * re-applies a room mapping, never resolves a LEGACY/UNRESOLVED snapshot,
 * never rewrites a PMS note, never moves a booking between branches and never
 * regenerates audit history (D.1 §10). Every column is copied verbatim; the
 * only transformation is the storage-level coercion in `coerce.ts`, which
 * changes representation and never meaning.
 *
 * SAFETY MODEL
 *   - The source is opened READ-ONLY at the driver level and is hashed before
 *     and after the run to prove it was untouched.
 *   - The target is guarded twice: statically (URL) and live
 *     (`SELECT current_database()`), and `kas_production` is refused outright.
 *   - Foreign keys stay ENFORCED throughout; nothing is deferred or dropped.
 *   - Each table is one transaction — the atomic unit. A failure rolls that
 *     table back completely and stops; already-completed tables remain, which
 *     is what makes `--resume` safe and meaningful.
 *   - A non-empty target is refused unless `--resume` is passed explicitly.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  CoercionError,
  coerceBoolean,
  coerceEnum,
  coerceInteger,
  coerceText,
  coerceTimestamp,
} from './coerce';
import { assertLiveIdentity, assertSafeWriteTarget, type LiveIdentity } from './guard';
import { resyncSequences, type SequenceSyncResult } from './sequences';
import { SqliteSource, checkSourceCompatibility, type SqliteRow } from './sqliteSource';
import {
  castFor,
  introspectTarget,
  transferableTables,
  type TargetColumn,
  type TargetSchema,
} from './targetSchema';
import { legacySourceNames, renameEnumValue, sourceColumnFor } from './legacyRenames';
import { describeDatabaseUrl } from '../config/databaseUrl';

export type TransferMode = 'dry-run' | 'execute';

export interface TransferOptions {
  /** Absolute path of the legacy SQLite database. Never written to. */
  sourceFile: string;
  /** PostgreSQL target URL. Guarded before a connection is opened. */
  targetUrl: string;
  mode: TransferMode;
  /** Which database names may be written to. Defaults to kas_d1_test only. */
  allowedDatabases?: readonly string[];
  /** Expected `current_user`; when set, a mismatch aborts. */
  expectedUser?: string;
  /** Permit writing into a target that already holds rows. Default false. */
  resume?: boolean;
  /** Injected client, used by the tests. When absent one is created. */
  client?: PrismaClient;
  logger?: (line: string) => void;
}

export interface TableTransferResult {
  table: string;
  sourceRows: number;
  /** Rows the target accepted. In dry-run this is what WOULD be inserted. */
  inserted: number;
  /** Rows already present (resume mode only). */
  skippedExisting: number;
  targetRowsBefore: number;
  targetRowsAfter: number;
  ok: boolean;
  problem?: string;
}

export interface TransferReport {
  mode: TransferMode;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  source: {
    file: string;
    sha256Before: string;
    sha256After: string;
    unchanged: boolean;
    lastMigration: string | null;
  };
  target: {
    database: string;
    user: string;
    schema: string;
    serverVersion: string;
  };
  tables: TableTransferResult[];
  sequences: SequenceSyncResult[];
  problems: string[];
}

export class TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferError';
  }
}

function sha256OfFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Creates a client bound to an explicit URL (never the ambient DATABASE_URL). */
export function createTargetClient(url: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: url });
}

/**
 * Converts one source row into positional parameters for the target.
 *
 * Only columns the TARGET has are emitted, and every value is cast explicitly
 * in SQL. A source column with no target counterpart is caught earlier, during
 * planning, so reaching this function already means the shapes agree.
 */
function coerceRow(
  table: string,
  row: SqliteRow,
  columns: TargetColumn[],
): (string | null)[] {
  const rowKey = String(row.id ?? '?');
  return columns.map((column) => {
    // A renamed column is read under the name the LEGACY source used; for
    // everything else this is the target name unchanged.
    const value = row[sourceColumnFor(table, column.name)] ?? null;
    switch (column.kind) {
      case 'boolean':
        return coerceBoolean(value, { table, column: column.name, rowKey });
      case 'integer':
      case 'bigint':
        return coerceInteger(value, { table, column: column.name, rowKey });
      case 'timestamp':
        return coerceTimestamp(value, { table, column: column.name, rowKey });
      case 'enum': {
        // A legacy enum LABEL may also have been renamed. Translated before the
        // check, so the error message below still lists the target's real values.
        const renamed =
          typeof value === 'string' ? renameEnumValue(column.udtName, value.trim()) : value;
        return coerceEnum(renamed, column.enumValues, { table, column: column.name, rowKey });
      }
      default:
        return coerceText(value, { table, column: column.name, rowKey });
    }
  });
}

/** PostgreSQL caps a statement at 65535 bind parameters; stay far below it. */
function batchSizeFor(columnCount: number): number {
  return Math.max(1, Math.min(500, Math.floor(20000 / Math.max(1, columnCount))));
}

function buildInsert(table: string, columns: TargetColumn[], rowCount: number): string {
  const names = columns.map((c) => `"${c.name}"`).join(', ');
  const tuples: string[] = [];
  let param = 1;
  for (let r = 0; r < rowCount; r += 1) {
    const placeholders = columns.map((c) => `$${param++}${castFor(c)}`);
    tuples.push(`(${placeholders.join(', ')})`);
  }
  // ON CONFLICT DO NOTHING makes a resumed run idempotent. It could in
  // principle mask a genuine constraint clash, so every table's row count is
  // reconciled against the source afterwards and any shortfall is reported as
  // a problem rather than accepted.
  return `INSERT INTO "${table}" (${names}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`;
}

interface TablePlan {
  table: string;
  columns: TargetColumn[];
  sourceRows: number;
  problems: string[];
}

/**
 * Checks that source and target agree on shape, BEFORE anything is written.
 *
 * Two asymmetric rules, both deliberate:
 *   - a source column missing from the target is fatal — that is data we were
 *     asked to move and have nowhere to put;
 *   - a target column missing from the source is fatal only when it is NOT
 *     NULL without a default, since otherwise the target's own default (or
 *     NULL) is the correct value for a column the pilot never had.
 */
/**
 * Exported for tests: the column-compatibility rule is the safety gate, and it
 * deserves direct assertions rather than only being exercised through a full
 * transfer against one fixed fixture.
 */
export function planTable(
  table: string,
  source: SqliteSource,
  schema: TargetSchema,
): TablePlan {
  const problems: string[] = [];
  const targetTable = schema.get(table)!;
  const sourceColumns = new Set(source.columns(table).map((c) => c.name));

  // A column the target renamed is still present in the source under its old
  // name, so it is matched through the rename map rather than dropped.
  const columns = targetTable.columns.filter((c) =>
    sourceColumns.has(sourceColumnFor(table, c.name)),
  );
  const targetNames = new Set(targetTable.columns.map((c) => c.name));
  // The legacy names those renames account for. Without this, the loop below
  // would report a renamed column as data loss — the very thing it exists to
  // catch, fired on the one case that is not a loss.
  const renamedAway = legacySourceNames(table);

  for (const name of sourceColumns) {
    if (!targetNames.has(name) && !renamedAway.has(name)) {
      problems.push(
        `${table}.${name}: có trong nguồn nhưng KHÔNG có trong đích — dữ liệu sẽ bị mất.`,
      );
    }
  }

  /*
    A target column the source does not have is only a problem when the INSERT
    would actually fail without it.

    THREE WAYS THE DATABASE CAN SUPPLY THE VALUE ITSELF, and all three are safe
    to omit from a legacy transfer:
      - the column is NULLABLE           → NULL is a legitimate value;
      - the column is SEQUENCE-backed    → serial/identity fills it (already
        exempt, because the transfer assigns explicit ids and resynchronises);
      - the column has a DEFAULT         → PostgreSQL fills it.

    The default case is the one added here, and it is deliberately GENERIC: any
    NOT NULL column carrying a default is fine, not a named list of them. Before
    this, every new `NOT NULL DEFAULT` column added to the schema silently broke
    the compatibility gate against the frozen pilot source, and the failure
    named the newest column rather than the real cause.

    NOTHING ELSE IS RELAXED. A NOT NULL column with no default and no sequence
    is still refused, which is the check that actually protects the transfer:
    without a value the INSERT would abort mid-run.
  */
  for (const column of targetTable.columns) {
    if (sourceColumns.has(column.name)) continue;
    if (column.nullable) continue;
    if (column.sequence !== null) continue;
    if (column.hasDefault) continue;
    problems.push(
      `${table}.${column.name}: cột NOT NULL của đích không có trong nguồn và không có giá trị mặc định.`,
    );
  }

  return { table, columns, sourceRows: source.count(table), problems };
}

export async function runTransfer(options: TransferOptions): Promise<TransferReport> {
  const log = options.logger ?? ((): void => {});
  const startedAt = new Date().toISOString();
  const problems: string[] = [];

  // --- Source ---------------------------------------------------------------
  if (!fs.existsSync(options.sourceFile)) {
    throw new TransferError(`Không tìm thấy tệp nguồn SQLite: ${options.sourceFile}`);
  }
  const sha256Before = sha256OfFile(options.sourceFile);
  const source = SqliteSource.open(options.sourceFile);

  const ownsClient = !options.client;
  let client: PrismaClient | null = null;

  try {
    const compatibility = checkSourceCompatibility(source);
    if (!compatibility.ok) {
      throw new TransferError(
        `Schema nguồn không tương thích:\n  - ${compatibility.problems.join('\n  - ')}`,
      );
    }
    log(`Nguồn hợp lệ (migration cuối: ${compatibility.lastMigration}).`);

    // --- Target guards ------------------------------------------------------
    const staticTarget = assertSafeWriteTarget(options.targetUrl, {
      allowedDatabases: options.allowedDatabases,
      operation: 'chuyển dữ liệu SQLite → PostgreSQL',
    });

    client = options.client ?? createTargetClient(options.targetUrl);
    const identity: LiveIdentity = await assertLiveIdentity(
      client,
      staticTarget.database!,
      options.expectedUser,
    );
    log(`Đích đã xác minh: ${identity.database} / ${identity.user} (schema ${identity.schema}).`);

    const schema = await introspectTarget(client);
    const tables = transferableTables(schema).filter((t) => source.hasTable(t));

    // --- Plan ---------------------------------------------------------------
    const plans: TablePlan[] = [];
    for (const table of tables) {
      const plan = planTable(table, source, schema);
      problems.push(...plan.problems);
      plans.push(plan);
    }
    if (problems.length > 0) {
      throw new TransferError(`Không thể tiếp tục:\n  - ${problems.join('\n  - ')}`);
    }

    // --- Emptiness gate -----------------------------------------------------
    const before = new Map<string, number>();
    for (const plan of plans) {
      const rows = await client.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "${plan.table}"`,
      );
      before.set(plan.table, Number(rows[0]?.n ?? 0n));
    }
    const nonEmpty = [...before.entries()].filter(([, n]) => n > 0).map(([t]) => t);
    if (nonEmpty.length > 0 && !options.resume) {
      throw new TransferError(
        `Đích KHÔNG rỗng (${nonEmpty.join(', ')}). ` +
          'Dùng --resume nếu đây là lần chạy tiếp tục có chủ đích.',
      );
    }

    // --- Move ---------------------------------------------------------------
    const results: TableTransferResult[] = [];
    for (const plan of plans) {
      const targetRowsBefore = before.get(plan.table) ?? 0;
      let inserted = 0;

      if (plan.sourceRows > 0) {
        const size = batchSizeFor(plan.columns.length);
        try {
          if (options.mode === 'execute') {
            // One transaction per table: the atomic unit. A mid-table failure
            // rolls this table back entirely and leaves earlier tables intact.
            await client.$transaction(async (tx) => {
              for (let offset = 0; offset < plan.sourceRows; offset += size) {
                const rows = source.page(plan.table, size, offset);
                if (rows.length === 0) break;
                const params = rows.flatMap((row) => coerceRow(plan.table, row, plan.columns));
                const sql = buildInsert(plan.table, plan.columns, rows.length);
                inserted += await tx.$executeRawUnsafe(sql, ...params);
              }
            });
          } else {
            // Dry-run walks and COERCES every row through the identical code
            // path, so an enum label or timestamp the target would reject is
            // found now rather than halfway through the real run.
            for (let offset = 0; offset < plan.sourceRows; offset += size) {
              const rows = source.page(plan.table, size, offset);
              if (rows.length === 0) break;
              rows.forEach((row) => coerceRow(plan.table, row, plan.columns));
              buildInsert(plan.table, plan.columns, rows.length);
              inserted += rows.length;
            }
          }
        } catch (error) {
          const message =
            error instanceof CoercionError ? error.message : (error as Error).message;
          const problem = `${plan.table}: ${message}`;
          problems.push(problem);
          results.push({
            table: plan.table,
            sourceRows: plan.sourceRows,
            inserted: 0,
            skippedExisting: 0,
            targetRowsBefore,
            targetRowsAfter: targetRowsBefore,
            ok: false,
            problem,
          });
          // Stop at the first failing table: continuing would insert children
          // whose parents were never moved.
          break;
        }
      }

      const afterRows =
        options.mode === 'execute'
          ? Number(
              (
                await client.$queryRawUnsafe<{ n: bigint }[]>(
                  `SELECT count(*)::bigint AS n FROM "${plan.table}"`,
                )
              )[0]?.n ?? 0n,
            )
          : targetRowsBefore + inserted;

      const skippedExisting = Math.max(0, plan.sourceRows - inserted);
      const expected = Math.max(targetRowsBefore, plan.sourceRows);
      const ok = options.mode === 'dry-run' ? true : afterRows === expected;
      if (!ok) {
        problems.push(
          `${plan.table}: đích có ${afterRows} hàng, mong đợi ${expected} — ` +
            'có hàng bị bỏ qua do trùng khóa.',
        );
      }

      results.push({
        table: plan.table,
        sourceRows: plan.sourceRows,
        inserted,
        skippedExisting,
        targetRowsBefore,
        targetRowsAfter: afterRows,
        ok,
        ...(ok ? {} : { problem: 'số hàng không khớp' }),
      });
      log(`${plan.table}: ${inserted}/${plan.sourceRows}`);
    }

    // --- Sequences (D.1 §12) ------------------------------------------------
    let sequences: SequenceSyncResult[] = [];
    if (options.mode === 'execute' && problems.length === 0) {
      sequences = await resyncSequences(client, schema);
      for (const s of sequences.filter((x) => !x.ok)) {
        problems.push(`sequence ${s.sequence}: ${s.problem ?? 'không đồng bộ'}`);
      }
      log(`Đã đồng bộ ${sequences.length} sequence.`);
    }

    const sha256After = sha256OfFile(options.sourceFile);
    if (sha256After !== sha256Before) {
      problems.push('NGHIÊM TRỌNG: tệp nguồn SQLite đã thay đổi trong quá trình chuyển.');
    }

    return {
      mode: options.mode,
      ok: problems.length === 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      source: {
        file: options.sourceFile,
        sha256Before,
        sha256After,
        unchanged: sha256Before === sha256After,
        lastMigration: compatibility.lastMigration,
      },
      target: {
        database: identity.database,
        user: identity.user,
        schema: identity.schema,
        serverVersion: identity.serverVersion,
      },
      tables: results,
      sequences,
      problems,
    };
  } finally {
    source.close();
    if (ownsClient && client) await client.$disconnect();
  }
}

/** Describes a target without connecting — used by the CLI's banner. */
export function describeTarget(url: string): string {
  const t = describeDatabaseUrl(url);
  return `${t.database ?? '?'} @ ${t.host ?? '?'}:${t.port ?? '?'} (schema ${t.schema ?? 'public'})`;
}
