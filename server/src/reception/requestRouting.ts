/**
 * WHO RECEIVES A GUEST REQUEST — "Bộ phận nhận việc", decided on the server
 * from who is working at the branch right now.
 *
 *   ĐANG TRONG CA (on shift) is a fact of the records, nothing else:
 *     Lễ tân / Bell        an open shift session (the shift gate) at the branch
 *     Buồng phòng          an open housekeeping workday whose open segment is
 *                          at the branch; a Quản lý buồng phòng only at its own
 *   It is NOT "online": an open browser tab is not a shift, and a shift is not
 *   a live connection. KAS keeps no presence signal, so it claims none.
 *
 *   ROUTING
 *     Buồng phòng  the branch's pool: every housekeeper and supervisor on shift
 *                  sees it, and ONE of them takes it ("Nhận việc", atomic) — or
 *                  a supervisor gives it to someone
 *     Bell         a Bell on shift, least loaded first — or nobody, and the
 *                  desk is told; never someone of another department
 *     Lễ tân       the receptionist who took it, when on shift here; else the
 *                  least loaded receptionist on shift
 *
 * LEAST LOADED = fewest open requests held now, then the longest since their
 * last one, then the lowest id — so a steady stream spreads round the people on
 * shift instead of piling on the first. Routing runs under a per-branch lock, so
 * two requests saved at the same instant see each other's assignment.
 */
import type { Prisma, PrismaClient, UserRole, WorkDepartment } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export const WORK_DEPARTMENTS = ['BELL', 'RECEPTION', 'HOUSEKEEPING'] as const satisfies readonly WorkDepartment[];

export const WORK_DEPARTMENT_LABELS: Record<WorkDepartment, string> = {
  BELL: 'Bell',
  RECEPTION: 'Lễ tân',
  HOUSEKEEPING: 'Buồng phòng',
};

/** The department a role works in; null for roles that are no department's staff (the Admin…). */
export function departmentOfRole(role: UserRole): WorkDepartment | null {
  switch (role) {
    case 'RECEPTIONIST':
    case 'RECEPTION_MANAGER':
    case 'RECEPTION_GENERAL_MANAGER':
      return 'RECEPTION';
    case 'HOUSEKEEPING':
    case 'HOUSEKEEPING_MANAGER':
      return 'HOUSEKEEPING';
    case 'BELL':
      return 'BELL';
    default:
      return null;
  }
}

export interface StaffMember {
  id: number;
  fullName: string;
  role: UserRole;
  department: WorkDepartment;
}

export interface OnShiftStaff {
  RECEPTION: StaffMember[];
  BELL: StaffMember[];
  /** Housekeepers on shift here. */
  HOUSEKEEPING: StaffMember[];
  /** Quản lý buồng phòng on shift at its own branch. */
  supervisors: StaffMember[];
}

const USER = { select: { id: true, fullName: true, role: true, branchId: true } } as const;

/** Everyone "đang trong ca" at the branch, by department — active accounts only, each once. */
export async function onShiftStaff(client: Db, branchId: number): Promise<OnShiftStaff> {
  const [desk, housekeeping] = await Promise.all([
    client.receptionShiftSession.findMany({
      where: { branchId, closedAt: null, user: { active: true, branchId, role: { in: ['RECEPTIONIST', 'BELL'] } } },
      select: { user: USER },
    }),
    client.housekeepingWorkSegment.findMany({
      where: { branchId, endedAt: null, session: { endedAt: null, user: { active: true, role: { in: ['HOUSEKEEPING', 'HOUSEKEEPING_MANAGER'] } } } },
      select: { session: { select: { user: USER } } },
    }),
  ]);
  const out: OnShiftStaff = { RECEPTION: [], BELL: [], HOUSEKEEPING: [], supervisors: [] };
  const seen = new Set<number>();
  const add = (list: StaffMember[], u: { id: number; fullName: string; role: UserRole }, department: WorkDepartment) => {
    if (seen.has(u.id)) return;
    seen.add(u.id);
    list.push({ id: u.id, fullName: u.fullName, role: u.role, department });
  };
  for (const { user } of desk) add(user.role === 'BELL' ? out.BELL : out.RECEPTION, user, user.role === 'BELL' ? 'BELL' : 'RECEPTION');
  for (const { session } of housekeeping) {
    const u = session.user;
    if (u.role === 'HOUSEKEEPING_MANAGER') {
      // A manager works only where it manages.
      if (u.branchId === branchId) add(out.supervisors, u, 'HOUSEKEEPING');
    } else add(out.HOUSEKEEPING, u, 'HOUSEKEEPING');
  }
  for (const list of [out.RECEPTION, out.BELL, out.HOUSEKEEPING, out.supervisors]) list.sort((a, b) => a.fullName.localeCompare(b.fullName, 'vi') || a.id - b.id);
  return out;
}

/** Everyone who may be given a request at the branch now. */
export function everyoneOnShift(staff: OnShiftStaff): StaffMember[] {
  return [...staff.RECEPTION, ...staff.BELL, ...staff.supervisors, ...staff.HOUSEKEEPING];
}

/** The fewest open requests held, then the longest since the last one, then the lowest id. */
export async function leastLoaded(client: Db, candidates: StaffMember[]): Promise<StaffMember | null> {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const ids = candidates.map((c) => c.id);
  const [open, last] = await Promise.all([
    client.guestRequestReport.groupBy({
      by: ['assigneeUserId'],
      where: { assigneeUserId: { in: ids }, completedAt: null, report: { is: { voidedAt: null } } },
      _count: { _all: true },
    }),
    client.guestRequestReport.groupBy({ by: ['assigneeUserId'], where: { assigneeUserId: { in: ids } }, _max: { assignedAt: true } }),
  ]);
  const load = new Map(open.map((r) => [r.assigneeUserId, r._count._all]));
  const lastAt = new Map(last.map((r) => [r.assigneeUserId, r._max.assignedAt?.getTime() ?? 0]));
  return [...candidates].sort(
    (a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || (lastAt.get(a.id) ?? 0) - (lastAt.get(b.id) ?? 0) || a.id - b.id,
  )[0]!;
}

/** Routing waits for any other routing at the same branch: each sees the last one's assignment. */
export async function lockBranchRouting(tx: Prisma.TransactionClient, branchId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('guest-request-routing'), ${branchId}::int)`;
}

/** Who of a department may take a request from its pool at the branch now. */
export function departmentStaff(staff: OnShiftStaff, department: WorkDepartment): StaffMember[] {
  return department === 'HOUSEKEEPING' ? [...staff.supervisors, ...staff.HOUSEKEEPING] : staff[department];
}

/**
 * Who receives a new request of `department` at the branch now. `available`:
 * someone of the department is on shift — for Buồng phòng the request stays in
 * the pool for one of them to take (`assignee` null); for Bell and Lễ tân it is
 * given to one at once.
 */
export async function routeRequest(
  client: Db,
  branchId: number,
  department: WorkDepartment,
  creator: { id: number },
): Promise<{ assignee: StaffMember | null; available: boolean; staff: OnShiftStaff }> {
  const staff = await onShiftStaff(client, branchId);
  if (department === 'HOUSEKEEPING') return { assignee: null, available: departmentStaff(staff, department).length > 0, staff };
  const assignee = department === 'BELL' ? await leastLoaded(client, staff.BELL) : (staff.RECEPTION.find((s) => s.id === creator.id) ?? (await leastLoaded(client, staff.RECEPTION)));
  return { assignee, available: assignee !== null, staff };
}
