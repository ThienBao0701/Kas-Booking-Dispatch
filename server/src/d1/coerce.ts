/**
 * SQLite → PostgreSQL value coercion.
 *
 * This is where the two engines' storage models actually differ, and getting
 * it wrong is how a "successful" migration silently corrupts data. Every value
 * is converted to a STRING and cast in SQL (`$1::timestamp`, `$1::boolean`,
 * `$1::"UserRole"`), which keeps the conversion explicit and visible instead of
 * relying on whatever the driver's parameter binding happens to infer.
 *
 * PRIVACY: a coercion failure reports the table, the column, the row's primary
 * key and the JavaScript *type* it received — never the value itself, because
 * these columns hold guest names, phone numbers and identity numbers. The one
 * exception is an enum label, which is a machine code and never personal data,
 * and which an operator cannot fix without seeing it.
 */

export class CoercionError extends Error {
  constructor(
    readonly table: string,
    readonly column: string,
    readonly rowKey: string,
    message: string,
  ) {
    super(`${table}.${column} (hàng ${rowKey}): ${message}`);
    this.name = 'CoercionError';
  }
}

/** SQLite's `CURRENT_TIMESTAMP` literal: "YYYY-MM-DD HH:MM:SS", always UTC. */
const SQL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?Z?$/;

/**
 * Normalises a SQLite datetime to an ISO-8601 UTC string.
 *
 * A single DATETIME column legitimately holds BOTH representations in this
 * project's databases:
 *   - INTEGER milliseconds since the epoch — what Prisma writes;
 *   - TEXT "YYYY-MM-DD HH:MM:SS" — what the C.3.8 backfill's SQL
 *     `CURRENT_TIMESTAMP` wrote (SQLite's CURRENT_TIMESTAMP is UTC).
 * Handling only the first would have shifted every backfilled guest and room
 * snapshot by the local UTC offset, or failed outright.
 *
 * The result is fed to PostgreSQL as `$n::timestamp` against a
 * `timestamp(3) WITHOUT TIME ZONE` column: PostgreSQL parses the wall-clock
 * part and ignores the trailing Z, which stores exactly the UTC instant the
 * source held. That is what the application has always assumed.
 */
export function coerceTimestamp(
  value: unknown,
  ctx: { table: string; column: string; rowKey: string },
): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number' || typeof value === 'bigint') {
    const ms = Number(value);
    if (!Number.isFinite(ms)) {
      throw new CoercionError(ctx.table, ctx.column, ctx.rowKey, 'giá trị thời gian không hữu hạn');
    }
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) {
      throw new CoercionError(ctx.table, ctx.column, ctx.rowKey, 'giá trị thời gian số không hợp lệ');
    }
    return date.toISOString();
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;

    const match = SQL_TIMESTAMP.exec(trimmed);
    if (match) {
      const [, y, mo, d, h, mi, s, frac] = match;
      const ms = frac ? `${frac.slice(1).padEnd(3, '0').slice(0, 3)}` : '000';
      return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`;
    }

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();

    throw new CoercionError(ctx.table, ctx.column, ctx.rowKey, 'chuỗi thời gian không phân tích được');
  }

  throw new CoercionError(
    ctx.table,
    ctx.column,
    ctx.rowKey,
    `kiểu thời gian không hỗ trợ: ${typeof value}`,
  );
}

/** SQLite stores booleans as INTEGER 0/1; some backfills wrote 'true'/'false'. */
export function coerceBoolean(
  value: unknown,
  ctx: { table: string; column: string; rowKey: string },
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') {
    const n = Number(value);
    if (n === 0) return 'false';
    if (n === 1) return 'true';
    throw new CoercionError(ctx.table, ctx.column, ctx.rowKey, `giá trị boolean ngoài {0,1}: ${n}`);
  }
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (['1', 'true', 't', 'yes'].includes(lower)) return 'true';
    if (['0', 'false', 'f', 'no'].includes(lower)) return 'false';
    throw new CoercionError(ctx.table, ctx.column, ctx.rowKey, 'chuỗi boolean không hợp lệ');
  }
  throw new CoercionError(ctx.table, ctx.column, ctx.rowKey, `kiểu boolean không hỗ trợ: ${typeof value}`);
}

export function coerceInteger(
  value: unknown,
  ctx: { table: string; column: string; rowKey: string },
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new CoercionError(ctx.table, ctx.column, ctx.rowKey, 'số nguyên nhưng nhận được số thực');
    }
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (!/^-?\d+$/.test(trimmed)) {
      throw new CoercionError(ctx.table, ctx.column, ctx.rowKey, 'chuỗi không phải số nguyên');
    }
    return trimmed;
  }
  throw new CoercionError(ctx.table, ctx.column, ctx.rowKey, `kiểu số không hỗ trợ: ${typeof value}`);
}

export function coerceText(
  value: unknown,
  ctx: { table: string; column: string; rowKey: string },
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Uint8Array) {
    // No column in this schema is a BLOB; images live on disk and only their
    // metadata is stored. Refuse rather than invent an encoding.
    throw new CoercionError(ctx.table, ctx.column, ctx.rowKey, 'cột TEXT chứa dữ liệu nhị phân');
  }
  throw new CoercionError(ctx.table, ctx.column, ctx.rowKey, `kiểu text không hỗ trợ: ${typeof value}`);
}

/**
 * Enum labels were plain TEXT in SQLite and become a native PostgreSQL type.
 *
 * The label is validated against the target's real enum members here so the
 * failure names the offending value and column, instead of surfacing as an
 * opaque `invalid input value for enum` from the server halfway through a
 * batch. Enum labels are machine codes, never personal data, so showing the
 * value is safe and is the only way an operator can act on the error.
 */
export function coerceEnum(
  value: unknown,
  allowed: readonly string[],
  ctx: { table: string; column: string; rowKey: string },
): string | null {
  if (value === null || value === undefined) return null;
  const label = typeof value === 'string' ? value.trim() : String(value);
  if (label.length === 0) return null;
  if (!allowed.includes(label)) {
    throw new CoercionError(
      ctx.table,
      ctx.column,
      ctx.rowKey,
      `giá trị enum "${label}" không tồn tại trong kiểu đích (cho phép: ${allowed.join(', ')})`,
    );
  }
  return label;
}
