/**
 * READ-ONLY reader for the legacy SQLite pilot database.
 *
 * The source database is evidence. It is opened with `readOnly: true`, which
 * node:sqlite enforces in the driver (a write attempt raises
 * ERR_SQLITE_ERROR), so "the transfer never modifies the source" is a
 * guarantee of the connection rather than a promise of the code. No PRAGMA is
 * issued, no journal is checkpointed, no schema is upgraded.
 *
 * `node:sqlite` is used deliberately: it ships with Node 24, so this adds no
 * dependency — better-sqlite3 and friends are blocked by the project's
 * install-script allow-list anyway.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** The migration that must be the last one applied to a compatible source. */
export const REQUIRED_SOURCE_MIGRATION = '20260728093914_c38_branch_room_class_versioning';

export type SqliteValue = string | number | bigint | null | Uint8Array;
export type SqliteRow = Record<string, SqliteValue>;

export class SqliteSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteSourceError';
  }
}

export interface SourceColumn {
  name: string;
  declaredType: string;
}

export class SqliteSource {
  private readonly db: DatabaseSync;

  private constructor(
    db: DatabaseSync,
    readonly file: string,
  ) {
    this.db = db;
  }

  /** Opens the source read-only, refusing a path that does not exist. */
  static open(file: string): SqliteSource {
    if (!fs.existsSync(file)) {
      throw new SqliteSourceError(`Không tìm thấy cơ sở dữ liệu nguồn SQLite: ${file}`);
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch (error) {
      throw new SqliteSourceError(
        `Không mở được nguồn SQLite ở chế độ chỉ đọc: ${(error as Error).message}`,
      );
    }
    return new SqliteSource(db, file);
  }

  close(): void {
    this.db.close();
  }

  /** Table names present in the source, excluding SQLite's own internals. */
  tables(): string[] {
    return this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' " +
          "AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => String((r as { name: string }).name));
  }

  hasTable(table: string): boolean {
    return (
      this.db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table) as { n: number }
    ).n > 0;
  }

  columns(table: string): SourceColumn[] {
    return this.db
      .prepare('SELECT name, type FROM pragma_table_info(?)')
      .all(table)
      .map((r) => {
        const row = r as { name: string; type: string };
        return { name: String(row.name), declaredType: String(row.type ?? '') };
      });
  }

  count(table: string): number {
    const row = this.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number };
    return Number(row.n);
  }

  /**
   * Reads one page of a table ordered by rowid.
   *
   * Ordering by a stable key is what makes `--resume` meaningful: a restarted
   * transfer walks the table in the same order it did before.
   */
  page(table: string, limit: number, offset: number): SqliteRow[] {
    return this.db
      .prepare(`SELECT * FROM "${table}" ORDER BY rowid LIMIT ? OFFSET ?`)
      .all(limit, offset) as SqliteRow[];
  }

  /** Min/max of an integer primary key, for the verification report. */
  idRange(table: string, column: string): { min: number | null; max: number | null } {
    const row = this.db
      .prepare(`SELECT min("${column}") AS lo, max("${column}") AS hi FROM "${table}"`)
      .get() as { lo: number | null; hi: number | null };
    return { min: row.lo === null ? null : Number(row.lo), max: row.hi === null ? null : Number(row.hi) };
  }

  /** Distinct values of a column — used to pre-flight enum compatibility. */
  distinct(table: string, column: string): (string | null)[] {
    return this.db
      .prepare(`SELECT DISTINCT "${column}" AS v FROM "${table}"`)
      .all()
      .map((r) => {
        const v = (r as { v: SqliteValue }).v;
        return v === null ? null : String(v);
      });
  }

  /**
   * The migration ledger of the source, newest last.
   *
   * A source whose last applied migration is not the expected one is REFUSED:
   * transferring from a schema this build has never seen would either drop
   * columns silently or fail deep inside a batch.
   */
  appliedMigrations(): string[] {
    if (!this.hasTable('_prisma_migrations')) return [];
    return this.db
      .prepare(
        'SELECT migration_name FROM "_prisma_migrations" ' +
          'WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ' +
          'ORDER BY finished_at ASC, migration_name ASC',
      )
      .all()
      .map((r) => String((r as { migration_name: string }).migration_name));
  }
}

export interface SourceCompatibility {
  ok: boolean;
  problems: string[];
  appliedMigrations: string[];
  lastMigration: string | null;
}

/**
 * Schema-version gate (D.1 §8: "refusal if schema version is incompatible").
 */
export function checkSourceCompatibility(
  source: SqliteSource,
  requiredMigration: string = REQUIRED_SOURCE_MIGRATION,
): SourceCompatibility {
  const problems: string[] = [];
  const applied = source.appliedMigrations();
  const last = applied.length > 0 ? applied[applied.length - 1]! : null;

  if (applied.length === 0) {
    problems.push(
      'Nguồn không có bảng _prisma_migrations hoặc chưa áp dụng migration nào — ' +
        'không xác định được phiên bản schema.',
    );
  } else if (!applied.includes(requiredMigration)) {
    problems.push(
      `Nguồn chưa áp dụng migration bắt buộc "${requiredMigration}" ` +
        `(migration cuối cùng: "${last ?? 'không có'}").`,
    );
  } else if (last !== requiredMigration) {
    problems.push(
      `Nguồn có migration mới hơn bản này hiểu được: "${last}". ` +
        'Hãy cập nhật công cụ chuyển dữ liệu trước khi tiếp tục.',
    );
  }

  return { ok: problems.length === 0, problems, appliedMigrations: applied, lastMigration: last };
}
