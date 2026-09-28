import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UserRole } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { devToolsActive, isTestReceptionist } from '../devtest/guard';
import type { UserWithBranch } from '../auth/serialize';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The freshly loaded authenticated user, set by requireAuth. */
      currentUser?: UserWithBranch;
    }
  }
}

/**
 * Loads the session's user straight from the database on every protected
 * request. Nothing authoritative is trusted from the session itself, so a
 * disabled account, a changed branch, or a forced password reset all take
 * effect immediately even while an old session cookie is still presented.
 */
async function loadSessionUser(req: Request): Promise<UserWithBranch | null> {
  const userId = req.session?.userId;
  if (typeof userId !== 'number') return null;
  return prisma.user.findUnique({ where: { id: userId }, include: { branch: true } });
}

export const requireAuth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  loadSessionUser(req)
    .then(async (user) => {
      if (!user) {
        next(ApiError.authRequired());
        return;
      }
      if (!user.active) {
        // A session that outlived the account being disabled must stop working.
        next(ApiError.accountDisabled());
        return;
      }
      await applyTestBranchOverride(req, user);
      req.currentUser = user;
      next();
    })
    .catch((err: unknown) => next(err));
};

/**
 * Dev-test only: for the dedicated `reception_test` account, replace the branch
 * scope with the session's active test branch. This is the single, central place
 * branch identity is overridden — so EVERY downstream authorization query
 * (booking lists, proof access, issues, summaries) automatically uses the chosen
 * branch. Ordinary receptionists are never affected, and it is inert unless the
 * developer tools are enabled (never in production).
 */
async function applyTestBranchOverride(req: Request, user: UserWithBranch): Promise<void> {
  if (!devToolsActive() || !isTestReceptionist(user)) return;
  const branchId = req.session?.activeTestBranchId;
  if (typeof branchId !== 'number') return;
  const branch = await prisma.branch.findFirst({ where: { id: branchId, active: true } });
  if (!branch) return; // an invalid/disabled branch is simply ignored
  user.branchId = branch.id;
  user.branch = branch;
}

/** Requires that requireAuth has already run and set req.currentUser. */
function currentUserOrThrow(req: Request): UserWithBranch {
  if (!req.currentUser) {
    // Defensive: a route wired without requireAuth in front of this.
    throw ApiError.authRequired();
  }
  return req.currentUser;
}

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    try {
      const user = currentUserOrThrow(req);
      if (!roles.includes(user.role)) {
        next(ApiError.forbidden());
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireAdmin: RequestHandler = requireRole('ADMIN');

/**
 * Blocks protected application endpoints while a user still owes a password
 * change. The whitelisted endpoints (me, change-password, logout) simply do
 * not mount this, so they remain reachable.
 */
export const requirePasswordChanged: RequestHandler = (req, _res, next) => {
  try {
    const user = currentUserOrThrow(req);
    if (user.mustChangePassword) {
      next(ApiError.passwordChangeRequired());
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Authorizes access to a specific branch. The branch id is never trusted from
 * the client on its own — for a receptionist it must equal their own assigned
 * branch. Admins may reach any branch.
 */
/**
 * WHO IS NOT BOUND TO ONE BRANCH.
 *
 * ADMIN is the dispatch centre and monitors all eight; TECHNICAL is one
 * maintenance team that works all eight, and TECHNICAL_MANAGER inspects that
 * team's work at all eight. All three carry `branchId = null`.
 *
 * This exists as a named predicate, rather than as `role === 'ADMIN'` repeated
 * at each site, because a branchless role that falls through a branch check does
 * NOT get an error — it gets `user.branchId !== branchId` against null, i.e. a
 * silent denial of every branch, or an empty list with nothing to explain it.
 *
 * BOOKING_DEPARTMENT is branchless too but is deliberately NOT here: it picks a
 * branch per charge document and never reads branch-scoped operational data, so
 * widening its access would grant something nothing asked for.
 */
export function seesAllBranches(role: UserRole): boolean {
  return role === 'ADMIN' || role === 'TECHNICAL' || role === 'TECHNICAL_MANAGER';
}

export function assertBranchAccess(
  user: UserWithBranch,
  branchId: number | null | undefined,
): void {
  if (seesAllBranches(user.role)) return;
  if (branchId == null || Number.isNaN(branchId)) {
    throw ApiError.branchAccessDenied();
  }
  if (user.branchId !== branchId) {
    throw ApiError.branchAccessDenied();
  }
}

type BranchIdExtractor = (req: Request) => number | null | undefined;

const defaultBranchIdExtractor: BranchIdExtractor = (req) => {
  const raw = req.params.id;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
};

export function requireBranchAccess(
  extract: BranchIdExtractor = defaultBranchIdExtractor,
): RequestHandler {
  return (req, _res, next) => {
    try {
      const user = currentUserOrThrow(req);
      assertBranchAccess(user, extract(req));
      next();
    } catch (err) {
      next(err);
    }
  };
}
