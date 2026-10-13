/**
 * "Vào ca" names the hotel by its address. The suites that only need a
 * housekeeper on shift send their branch's own (full) address — the address a
 * housekeeper standing there would type.
 */
import { testPrisma } from './db';

/** The address of a branch, as the Admin entered it. */
export async function addressOf(branchId: number): Promise<string> {
  return (await testPrisma.branch.findUniqueOrThrow({ where: { id: branchId }, select: { address: true } })).address;
}

/** The address of the branch an account belongs to (an agent signed in as it). */
export async function workplaceOf(agent: { get: (url: string) => PromiseLike<{ body: { user: { branch: { id: number } | null } } }> }): Promise<string> {
  const me = await agent.get('/api/auth/me');
  const branch = me.body.user.branch;
  if (!branch) throw new Error('The account has no branch.');
  return addressOf(branch.id);
}
