/**
 * CHI NHÁNH → NGÀY NGHIỆP VỤ → CA → NHÂN VIÊN, from the server's session data.
 *
 * This is PRESENTATION ONLY. It orders and groups rows the server has already
 * filtered and authorized; it decides nothing about which rows exist.
 *
 * THE KEYS ARE THE SERVER'S, NOT GUESSES. A shift is identified by
 * `shiftSessionId`, and its day by `shiftDate` — the shift's BUSINESS date,
 * which the server derives from the session, so Ca C of the 22nd keeps its
 * 02:15 entries under the 22nd. Reading either off a record's own timestamp
 * would split one night's shift across two dates.
 */
import type { OperationalReport, ReportCategory } from '../api/receptionReports';

export interface ShiftGroup {
  /** Unique within the whole result: `branch|date|session`. */
  key: string;
  shiftName: string | null;
  shiftWindow: string | null;
  /** Who was ON the shift, as they checked in. */
  employee: string | null;
  branchAddress: string | null;
  /** Has the shift pressed "Kết thúc ca"? Open shifts are not in the official report. */
  closed: boolean;
  /** How many of the shift's records fall in each category. */
  counts: Partial<Record<ReportCategory, number>>;
  /** Oldest first — a shift reads forwards. */
  rows: OperationalReport[];
}

export interface DayGroup {
  /** "YYYY-MM-DD", the shift's own business day. */
  date: string;
  /** In the order they began. */
  shifts: ShiftGroup[];
}

export interface BranchGroup {
  branchId: number;
  branchNumber: number | null;
  branchAddress: string | null;
  days: DayGroup[];
}

const byCreated = (a: OperationalReport, b: OperationalReport) => a.createdAt.localeCompare(b.createdAt);

/** One branch's (or any single set's) records, by day and then by shift. */
export function groupByShift(rows: OperationalReport[]): DayGroup[] {
  const days = new Map<string, Map<string, ShiftGroup>>();

  for (const row of rows) {
    const date = row.shiftDate;
    /*
      A record with no session has no shift to belong to. It is grouped by the
      person who entered it rather than lumped with other sessionless rows, so
      two people's entries never appear under one name.
    */
    const session = row.shiftSessionId ?? `none:${row.createdByName}`;
    const key = `${row.branchId}|${date}|${session}`;

    let shifts = days.get(date);
    if (!shifts) {
      shifts = new Map();
      days.set(date, shifts);
    }
    let group = shifts.get(key);
    if (!group) {
      group = {
        key,
        shiftName: row.shiftName,
        shiftWindow: row.shiftWindow,
        employee: row.shiftReceptionistName ?? row.createdByName,
        branchAddress: row.branch?.address ?? null,
        closed: row.shiftClosed,
        counts: {},
        rows: [],
      };
      shifts.set(key, group);
    }
    group.rows.push(row);
    group.counts[row.category] = (group.counts[row.category] ?? 0) + 1;
  }

  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, shifts]) => ({
      date,
      shifts: [...shifts.values()]
        .map((s) => ({ ...s, rows: [...s.rows].sort(byCreated) }))
        // A shift's place in its day is when its first record was made. Every
        // group has at least one row — it was created by pushing one.
        .sort((a, b) => (a.rows[0]?.createdAt ?? '').localeCompare(b.rows[0]?.createdAt ?? '')),
    }));
}

/** The top of the hierarchy: each branch, in branch-number order, then its days. */
export function groupByBranch(rows: OperationalReport[]): BranchGroup[] {
  const branches = new Map<number, OperationalReport[]>();
  for (const row of rows) {
    const list = branches.get(row.branchId);
    if (list) list.push(row);
    else branches.set(row.branchId, [row]);
  }
  return [...branches.entries()]
    .map(([branchId, list]) => ({
      branchId,
      branchNumber: list[0]?.branch?.branchNumber ?? null,
      branchAddress: list[0]?.branch?.address ?? null,
      days: groupByShift(list),
    }))
    .sort((a, b) => (a.branchNumber ?? Infinity) - (b.branchNumber ?? Infinity));
}

/**
 * The ISO day `n` days before `day`. Calendar arithmetic on the date itself —
 * it only chooses the range to ASK for; the server turns that range into the
 * shifts whose business date falls in it.
 */
export function daysBefore(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - n * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}
