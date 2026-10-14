/**
 * "Vào ca" names the hotel by its address. The suites that only need a
 * housekeeper on shift send the branch's own (full) address — the address a
 * housekeeper standing there would type. A housekeeping account has no
 * permanent branch: the shift's is the branch of all its work.
 */
import { expect } from 'vitest';
import type request from 'supertest';
import { testPrisma } from './db';

/** The address of a branch, as the Admin entered it. */
export async function addressOf(branchId: number): Promise<string> {
  return (await testPrisma.branch.findUniqueOrThrow({ where: { id: branchId }, select: { address: true } })).address;
}

type Agent = ReturnType<typeof request.agent>;

/** "Vào ca" at a branch, by its address — 201, or the test fails here. */
export async function startShiftAt(agent: Agent, branchId: number): Promise<void> {
  const res = await agent.post('/api/housekeeping/shift/start').send({ address: await addressOf(branchId) });
  expect(res.status).toBe(201);
}

/**
 * A finished shift at a branch, a day before `at` — what makes a housekeeper one
 * of that branch's staff (a shift there in the last 30 days), without leaving
 * them on shift. The manager can then give them rooms there.
 */
export async function workedRecentlyAt(userId: number, branchId: number, at: Date): Promise<void> {
  const startedAt = new Date(at.getTime() - 24 * 60 * 60 * 1000);
  const endedAt = new Date(startedAt.getTime() + 8 * 60 * 60 * 1000);
  await testPrisma.housekeepingWorkSession.create({
    data: { userId, startedAt, endedAt, segments: { create: { branchId, staffName: 'x', startedAt, endedAt } } },
  });
}
