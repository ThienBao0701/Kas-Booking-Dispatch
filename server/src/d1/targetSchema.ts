/**
 * Live introspection of the PostgreSQL target.
 *
 * The transfer tool deliberately does NOT carry a hand-maintained catalogue of
 * 21 tables and their ~200 columns. It asks the target database what it
 * actually looks like, then intersects that with what the SQLite source
 * actually holds. Two things follow from that choice:
 *
 *   - the tool cannot drift out of date with the schema, and
 *   - a column that exists in the source but NOT in the target is a hard
 *     error rather than a silent omission (D.1 §8: never silently skip data).
 *
 * The only knowledge encoded by hand is TRANSFER_ORDER — the foreign-key-safe
 * insertion order — because that is genuine domain knowledge that cannot be
 * inferred safely from information_schema alone.
 */
import type { PrismaClient } from '@prisma/client';

/**
 * Foreign-key-safe insertion order.
 *
 * A table appears only after every table it references. Self-referencing rows
 * do not occur in this schema, so a single linear pass is sufficient and no
 * constraint ever has to be dropped or deferred — the transfer runs with all
 * foreign keys ENFORCED, which is what makes a successful run meaningful.
 */
export const TRANSFER_ORDER = [
  'Branch',
  'User',
  'Session',
  'DemoDataBatch',
  'BranchSourceAlias',
  'BranchChangeLog',
  'BranchRoomMappingVersion',
  'BranchRoomClass',
  'BranchRoomClassAlias',
  'Booking',
  'BookingGuest',
  'BookingAuditEvent',
  'BookingRoom',
  'BookingNightPrice',
  'BookingExtractWarning',
  'BookingStatusHistory',
  'BookingCreationProof',
  'BookingProofAnalysis',
  'BookingProofComparison',
  'Notification',
  'HotelIssue',
] as const;

export type TransferTable = (typeof TRANSFER_ORDER)[number];

export type ColumnKind = 'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'enum';

export interface TargetColumn {
  name: string;
  kind: ColumnKind;
  /** PostgreSQL type name, used to build the explicit cast. */
  udtName: string;
  nullable: boolean;
  /**
   * Whether the target column has a database DEFAULT.
   *
   * Read so the compatibility gate can distinguish "the source must supply this
   * or the INSERT fails" from "PostgreSQL will fill this in". A NOT NULL column
   * with a default is safe to omit from a legacy transfer — the same reason
   * sequence-backed columns are already exempt — and without this flag every
   * new NOT NULL DEFAULT column added to the schema would block the gate.
   */
  hasDefault: boolean;
  /** Enum members, when kind === 'enum'. */
  enumValues: string[];
  /** The sequence backing this column, when it is serial/identity. */
  sequence: string | null;
}

export interface TargetTable {
  name: string;
  columns: TargetColumn[];
  /** Columns whose values come from a sequence (D.1 §12). */
  sequenceColumns: { column: string; sequence: string }[];
}

export type TargetSchema = Map<string, TargetTable>;

function kindOf(dataType: string, udtName: string): ColumnKind {
  if (dataType === 'USER-DEFINED') return 'enum';
  switch (udtName) {
    case 'bool':
      return 'boolean';
    case 'int2':
    case 'int4':
      return 'integer';
    case 'int8':
      return 'bigint';
    case 'timestamp':
    case 'timestamptz':
      return 'timestamp';
    default:
      return 'text';
  }
}

/** The explicit SQL cast applied to every bound parameter. */
export function castFor(column: TargetColumn): string {
  switch (column.kind) {
    case 'boolean':
      return '::boolean';
    case 'integer':
      return '::integer';
    case 'bigint':
      return '::bigint';
    case 'timestamp':
      return '::timestamp';
    case 'enum':
      return `::"${column.udtName}"`;
    default:
      return '::text';
  }
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
  sequence: string | null;
}

interface EnumRow {
  typname: string;
  enumlabel: string;
}

/** Reads the target's tables, columns, enum members and sequences. */
export async function introspectTarget(
  client: Pick<PrismaClient, '$queryRawUnsafe'>,
): Promise<TargetSchema> {
  const enumRows = await client.$queryRawUnsafe<EnumRow[]>(
    `SELECT t.typname, e.enumlabel
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = current_schema()
      ORDER BY t.typname, e.enumsortorder`,
  );
  const enums = new Map<string, string[]>();
  for (const row of enumRows) {
    const list = enums.get(row.typname) ?? [];
    list.push(row.enumlabel);
    enums.set(row.typname, list);
  }

  const columnRows = await client.$queryRawUnsafe<ColumnRow[]>(
    `SELECT c.table_name,
            c.column_name,
            c.data_type,
            c.udt_name,
            c.is_nullable,
            c.column_default,
            pg_get_serial_sequence(
              quote_ident(c.table_schema) || '.' || quote_ident(c.table_name),
              c.column_name
            ) AS sequence
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema()
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`,
  );

  const schema: TargetSchema = new Map();
  for (const row of columnRows) {
    const table = schema.get(row.table_name) ?? {
      name: row.table_name,
      columns: [],
      sequenceColumns: [],
    };
    const kind = kindOf(row.data_type, row.udt_name);
    const column: TargetColumn = {
      name: row.column_name,
      kind,
      udtName: row.udt_name,
      nullable: row.is_nullable === 'YES',
      hasDefault: row.column_default !== null,
      enumValues: kind === 'enum' ? (enums.get(row.udt_name) ?? []) : [],
      sequence: row.sequence,
    };
    table.columns.push(column);
    if (row.sequence) {
      table.sequenceColumns.push({ column: row.column_name, sequence: row.sequence });
    }
    schema.set(row.table_name, table);
  }

  return schema;
}

/** Tables in the target that the transfer knows how to populate. */
export function transferableTables(schema: TargetSchema): TransferTable[] {
  return TRANSFER_ORDER.filter((name) => schema.has(name));
}

/**
 * Every sequence in the target, paired with the column that feeds it.
 * This is the exact list that must be resynchronised after explicit-ID
 * inserts, and the list the sequence tests assert against.
 */
export function sequenceColumns(
  schema: TargetSchema,
): { table: string; column: string; sequence: string }[] {
  const out: { table: string; column: string; sequence: string }[] = [];
  for (const table of schema.values()) {
    for (const sc of table.sequenceColumns) {
      out.push({ table: table.name, column: sc.column, sequence: sc.sequence });
    }
  }
  return out.sort((a, b) => a.table.localeCompare(b.table));
}
