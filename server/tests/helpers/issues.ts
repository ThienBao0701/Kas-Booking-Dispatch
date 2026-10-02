/**
 * "Giao kỹ thuật" for the tests — through the supervisors' own endpoint, so a
 * test that has a technician accept a job goes the same way production does:
 * the job is ASSIGNED to that technician first, and only then can it be taken.
 */
import type request from 'supertest';
import { expect } from 'vitest';

type Agent = ReturnType<typeof request.agent>;

/** The signed-in user's id, read from the session the agent carries. */
export async function userIdOf(agent: Agent): Promise<number> {
  const res = await agent.get('/api/auth/me');
  expect(res.status).toBe(200);
  return res.body.user.id as number;
}

/** Assigns the incident to `technician` (an agent signed in as a TECHNICAL user). */
export async function assignTo(supervisor: Agent, issueId: string, technician: Agent): Promise<void> {
  const res = await supervisor
    .post(`/api/issues/${issueId}/assign`)
    .send({ technicianUserId: await userIdOf(technician) });
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
