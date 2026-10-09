/**
 * "Giao kỹ thuật" for the tests — through the supervisors' own endpoint, so a
 * test that has a technician accept a job goes the same way production does:
 * the job is ASSIGNED to that technician first, and only then can it be taken.
 */
import type request from 'supertest';
import { expect } from 'vitest';
import { testPrisma } from './db';

type Agent = ReturnType<typeof request.agent>;

/** The signed-in user's id, read from the session the agent carries. */
export async function userIdOf(agent: Agent): Promise<number> {
  const res = await agent.get('/api/auth/me');
  expect(res.status).toBe(200);
  return res.body.user.id as number;
}

/**
 * "Chi nhánh được giao việc": ticks these branches on a technician's account, as
 * the Admin does — a technician can only be given incidents of its branches.
 */
export async function serveBranches(technicianUserId: number, branchIds: readonly number[]): Promise<void> {
  await testPrisma.userBranchAssignment.createMany({
    data: branchIds.map((branchId) => ({ userId: technicianUserId, branchId })),
    skipDuplicates: true,
  });
}

/** Ticks EVERY branch on a technician's account — for tests about something else. */
export async function serveAllBranches(technicianUserId: number): Promise<void> {
  const branches = await testPrisma.branch.findMany({ select: { id: true } });
  await serveBranches(technicianUserId, branches.map((b) => b.id));
}

/**
 * Assigns the incident to `technician` (an agent signed in as a TECHNICAL user).
 * The technician is first given the incident's branch, explicitly — the
 * assignment rule itself is tested in technicianBranchScope.test.ts.
 */
export async function assignTo(supervisor: Agent, issueId: string, technician: Agent): Promise<void> {
  const technicianUserId = await userIdOf(technician);
  const issue = await testPrisma.hotelIssue.findUniqueOrThrow({ where: { id: issueId }, select: { branchId: true } });
  await serveBranches(technicianUserId, [issue.branchId]);
  const res = await supervisor.post(`/api/issues/${issueId}/assign`).send({ technicianUserId });
  expect(res.status).toBe(200);
}

/** Assign, then accept — the two steps a job now always takes. */
export async function assignAndAccept(
  supervisor: Agent,
  issueId: string,
  technician: Agent,
  who: { technicianName: string; technicianPhone: string } = { technicianName: 'Bao', technicianPhone: '0369852177' },
): Promise<request.Response> {
  await assignTo(supervisor, issueId, technician);
  return technician.post(`/api/issues/${issueId}/accept`).send(who);
}
