/**
 * A HOUSEKEEPER'S SHIFT ENDS AT 20:00 — Asia/Ho_Chi_Minh, on the server.
 *
 * Every housekeeper's workday begun before that 20:00 ends — at 20:00. A minute
 * sweep (restart-safe: it catches up on the last 20:00 it missed) does it.
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

/** Every housekeeper's open workday begun before the last 20:00 ends at that 20:00. */
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
  // In the bell (and pushed by the sweep) — once per workday, whatever retries.
  if (ended.length > 0) {
    await client.notification.createMany({
      data: ended.map((r) => ({
        userId: r.userId,
        title: 'Ca làm việc đã kết thúc',
        body: 'Đã 20:00 — ca buồng phòng được tự động kết thúc. Công việc chưa xong vẫn được giữ nguyên.',
        link: '/app/inspections',
        dedupeKey: `hk-shift-ended:${r.sessionId}`,
      })),
      skipDuplicates: true,
    });
  }
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
