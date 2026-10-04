import { Router } from 'express';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { serializeBranch } from '../auth/serialize';
import { branchScopeOf, scopeIncludes, scopedBranchRows } from '../auth/branchScope';
import { floorsForBranchCode, roomsForBranchCode } from '../room/branchRooms';
import {
  requireAuth,
  requirePasswordChanged,
  requireBranchAccess,
  seesAllBranches,
} from '../middleware/auth';

export function createBranchesRouter(): Router {
  const router = Router();

  // GET /api/branches
  // ADMIN: all active branches. RECEPTIONIST: only the assigned branch.
  router.get('/branches', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser;
      if (!user) throw ApiError.authRequired();

      // ADMIN monitors every branch and Bộ phận kỹ thuật works every branch, so
      // both get the full list. Written as a predicate rather than a second
      // `=== 'ADMIN'` because a branchless role falling through to the code
      // below receives an EMPTY list — an application that looks broken rather
      // than one that says why.
      if (seesAllBranches(user.role)) {
        const branches = await prisma.branch.findMany({
          where: { active: true },
          orderBy: { id: 'asc' },
        });
        res.json({ branches: branches.map((b) => serializeBranch(b)) });
        return;
      }

      // Quản lý lễ tân: the branches it supervises; Tổng quản lý lễ tân: all.
      // The shared scope, so this list and every scoped query agree.
      if (
        user.role === 'RECEPTION_MANAGER' ||
        user.role === 'RECEPTION_GENERAL_MANAGER' ||
        user.role === 'TECHNICAL_MANAGER' ||
        user.role === 'HOUSEKEEPING_MANAGER'
      ) {
        const branches = await prisma.branch.findMany({
          where: scopedBranchRows(user),
          orderBy: [{ branchNumber: 'asc' }, { id: 'asc' }],
        });
        res.json({ branches: branches.map((b) => serializeBranch(b)) });
        return;
      }

      // Receptionist and Bộ phận buồng phòng: the server decides the branch from
      // the session identity, never from anything the client sends.
      const branches =
        user.branchId != null
          ? await prisma.branch.findMany({ where: { id: user.branchId, active: true } })
          : [];
      res.json({ branches: branches.map((b) => serializeBranch(b)) });
    })().catch(next);
  });

  // GET /api/branches/:id
  // ADMIN: any active branch. RECEPTIONIST: only their own (enforced by
  // requireBranchAccess before the handler ever runs).
  router.get(
    '/branches/:id',
    requireAuth,
    requirePasswordChanged,
    requireBranchAccess(),
    (req, res, next) => {
      (async () => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) {
          throw ApiError.notFound('Không tìm thấy chi nhánh.');
        }
        const branch = await prisma.branch.findFirst({ where: { id, active: true } });
        if (!branch) {
          throw ApiError.notFound('Không tìm thấy chi nhánh.');
        }
        res.json({ branch: serializeBranch(branch) });
      })().catch(next);
    },
  );

  /*
    GET /api/branches/:id/rooms — the branch's room catalog, for the room
    selector. `rooms: null` means the branch has no catalog and the form falls
    back to a typed room. Readable by anyone who may work that branch: the
    global departments, a supervisor with it in scope, and its own staff.
  */
  router.get('/branches/:id/rooms', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw ApiError.notFound('Không tìm thấy chi nhánh.');
      if (!seesAllBranches(user.role) && !scopeIncludes(branchScopeOf(user), id)) {
        throw ApiError.branchAccessDenied();
      }
      const branch = await prisma.branch.findFirst({ where: { id, active: true } });
      if (!branch) throw ApiError.notFound('Không tìm thấy chi nhánh.');
      // The branch's rooms and floors — the one location catalog every selector reads.
      res.json({ branchId: branch.id, rooms: roomsForBranchCode(branch.code), floors: floorsForBranchCode(branch.code) });
    })().catch(next);
  });

  return router;
}
