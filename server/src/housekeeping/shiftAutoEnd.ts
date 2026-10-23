/**
 * A HOUSEKEEPER'S SHIFT ENDS BY ITSELF — two rules, both on the server.
 *
 *   NO_WORK     right after a housekeeper completes a room: nothing given to it
 *               is left unfinished for that day at that branch, AND nothing is
 *               left free to take there. A temporarily empty personal list with
 *               work still waiting in the pool does not end anything, and one
 *               housekeeper finishing ends no one else's shift.
 *   CUTOFF_20H  at 20:00 Asia/Ho_Chi_Minh, every housekeeper's workday begun
 *               before that 20:00 ends — at 20:00. A minute sweep (restart-safe:
 *               it catches up on the last 20:00 it missed) does it.
 *
 * Only `HOUSEKEEPING` accounts: a Quản lý buồng phòng supervises and its
 * workday is its own to end; Lễ tân and Bell shifts are not touched.
 *
 * ENDING A SHIFT FINISHES NO WORK. Rooms stay exactly as they were — assigned,
 * half-done, with their history — for the manager to see and give out again.
 * Each end is one conditional write (`endedAt: null`) and one notification
 * keyed by the workday, so a retry, a second server or a restart ends it once
 * and tells the person once.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { getClock, hcmDateOnly, hcmWallClockToUtc, type Clock } from '../lib/clock';

export const SHIFT_CUTOFF_LOCAL_TIME = '20:00';
const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

/** The most recent 20:00 in Asia/Ho_Chi_Minh at or before `now` (Vietnam keeps no daylight saving). */
export function lastShiftCutoff(now: Date): Date {
  const today = hcmWallClockToUtc(hcmDateOnly(now), SHIFT_CUTOFF_LOCAL_TIME);
  return today.getTime() <= now.getTime() ? today : new Date(today.getTime() - DAY_MS);
}

type EndReason = 'NO_WORK' | 'CUTOFF_20H';

const NOTICE: Record<EndReason, { title: string; body: string }> = {
  NO_WORK: { title: 'Ca làm việc đã kết thúc', body: 'Bạn đã hoàn thành hết công việc và chi nhánh không còn việc chờ nhận — ca được tự động kết thúc.' },
  CUTOFF_20H: { title: 'Ca làm việc đã kết thúc', body: 'Đã 20:00 — ca buồng phòng được tự động kết thúc. Công việc chưa xong vẫn được giữ nguyên.' },
};

/** In the bell (and pushed by the sweep) — once per workday, whatever retries. */
async function notifyEnded(client: PrismaClient, rows: { sessionId: string; userId: number }[], reason: EndReason): Promise<void> {
  if (rows.length === 0) return;
  await client.notification.createMany({
    data: rows.map((r) => ({ userId: r.userId, ...NOTICE[reason], link: '/app/inspections', dedupeKey: `hk-shift-ended:${r.sessionId}` })),
    skipDuplicates: true,
  });
}

/**
 * NO_WORK, checked under the branch's work lock (the one "Tạo công việc" takes),
 * so a group created at the same instant is either seen here or created after
 * the shift ended — never lost between the two. Returns whether it ended.
 */
export async function endShiftIfNoWork(
  userId: number,
  branchId: number,
  workDate: string,
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const ended = await client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('housekeeping-open-places'), ${branchId}::int)`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (user?.role !== 'HOUSEKEEPING') return null;
    const remaining = await tx.housekeepingRoomTask.count({
      where: { branchId, workDate, voidedAt: null, state: { not: 'COMPLETED' }, OR: [{ assigneeUserId: userId }, { assigneeUserId: null }] },
    });
    if (remaining > 0) return null;
    const session = await tx.housekeepingWorkSession.findFirst({
      where: { userId, endedAt: null, segments: { some: { branchId, endedAt: null } } },
      select: { id: true },
    });
    if (!session) return null;
    const now = clock.now();
    const { count } = await tx.housekeepingWorkSession.updateMany({ where: { id: session.id, endedAt: null }, data: { endedAt: now, endReason: 'NO_WORK' } });
    if (count === 0) return null;
    await tx.housekeepingWorkSegment.updateMany({ where: { sessionId: session.id, endedAt: null }, data: { endedAt: now } });
    return session.id;
  });
  if (!ended) return false;
  await notifyEnded(client, [{ sessionId: ended, userId }], 'NO_WORK');
  return true;
}

/** CUTOFF_20H: every housekeeper's open workday begun before the last 20:00 ends at that 20:00. */
export async function endShiftsAtCutoff(clock: Clock = getClock(), client: PrismaClient = defaultPrisma): Promise<number> {
  const cutoff = lastShiftCutoff(clock.now());
  const open = await client.housekeepingWorkSession.findMany({
    where: { endedAt: null, startedAt: { lt: cutoff }, user: { role: 'HOUSEKEEPING' } },
    select: { id: true, userId: true },
  });
  const ended: { sessionId: string; userId: number }[] = [];
  for (const s of open) {
    const done = await client.$transaction(async (tx) => {
      const { count } = await tx.housekeepingWorkSession.updateMany({ where: { id: s.id, endedAt: null }, data: { endedAt: cutoff, endReason: 'CUTOFF_20H' } });
      if (count === 0) return false;
      await tx.housekeepingWorkSegment.updateMany({ where: { sessionId: s.id, endedAt: null }, data: { endedAt: cutoff } });
      return true;
    });
    if (done) ended.push({ sessionId: s.id, userId: s.userId });
  }
  await notifyEnded(client, ended, 'CUTOFF_20H');
  return ended.length;
}

/** Starts the minute sweep (the server's entry point only); returns its stop. */
export function startHousekeepingShiftCutoff(client: PrismaClient = defaultPrisma): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    endShiftsAtCutoff(getClock(), client)
      // eslint-disable-next-line no-console
      .catch((err: unknown) => console.warn('[housekeeping] 20:00 shift end failed:', err instanceof Error ? err.message : err))
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}
