import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UserRole } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { devToolsActive, isTestReceptionist } from '../devtest/guard';
import type { UserWithBranch } from '../auth/serialize';

/**
 * The authenticated user as every route sees it: the account, its branch, and —
 * for a Quản lý lễ tân — the branches it supervises (`managedBranchIds`).
 */
export type SessionUser = UserWithBranch & { managedBranchIds?: number[] };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The freshly loaded authenticated user, set by requireAuth. */
      currentUser?: SessionUser;
    }
  }
}

/**
 * Loads the session's user straight from the database on every protected
 * request. Nothing authoritative is trusted from the session itself, so a
 * disabled account, a changed branch, a forced password reset — or an Admin
 * changing which branches a Quản lý lễ tân supervises — all take effect
 * immediately even while an old session cookie is still presented.
 */
async function loadSessionUser(req: Request): Promise<SessionUser | null> {
  const userId = req.session?.userId;
  if (typeof userId !== 'number') return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { branch: true, branchAssignments: { select: { branchId: true } } },
  });
  if (!user) return null;
  const { branchAssignments, ...rest } = user;
  if (user.role === 'RECEPTION_MANAGER' || user.role === 'TECHNICAL_MANAGER') {
    return { ...rest, managedBranchIds: branchAssignments.map((a) => a.branchId) };
  }
  /*
    BỘ PHẬN BUỒNG PHÒNG HAS NO PERMANENT BRANCH. Where it works is the OPEN
    segment of its open workday ("Vào ca" / "Đổi chi nhánh"), read here on every
    request — so every branch check downstream (inspections, the room catalog,
    notifications) follows the shift, and an account not on shift has no branch.
  */
  if (user.role === 'HOUSEKEEPING') {
    const segment = await prisma.housekeepingWorkSegment.findFirst({
      where: { endedAt: null, session: { userId: user.id, endedAt: null } },
      include: { branch: true },
    });
    return { ...rest, branchId: segment?.branchId ?? null, branch: segment?.branch ?? null };
  }
  return rest;
}

/**
 * WHAT A QUẢN LÝ LỄ TÂN / TỔNG QUẢN LÝ LỄ TÂN MAY REACH — default deny, for the
 * same reason as Housekeeping below: many routes decide "who is not an admin" by
 * comparing `user.branchId`, and a branchless supervisor falling through them
 * would get either nothing or, worse, something. The supervision screens need
 * exactly these; each service then scopes by `branchScope.ts`.
 */
const RECEPTION_SUPERVISOR_ROUTES = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/branches(\/|$)/,
  /^\/api\/admin\/reports\/operational(\.pdf|\.xlsx)?$/,
  /^\/api\/reception\/reports(\/|$)/,
  // The five shifts and their clock times — the export's shift choices.
  /^\/api\/reception\/shifts\/options$/,
  /^\/api\/issues(\/|$)/,
  /^\/api\/chat\/channels(\/|$)/,
  /^\/api\/chat\/attachments(\/|$)/,
  /^\/api\/housekeeping(\/|$)/,
  /^\/api\/hotel-deliveries(\/|$)/,
  /^\/api\/nav-badges$/,
  /^\/api\/notifications(\/|$)/,
];

/**
 * "Đơn mới" — READ ONLY. A supervisor sees the orders sent to its branches and
 * opens one, exactly as Reception does; it never claims, cuts or confirms one
 * (those stay Reception's, on its shift), so only these two GETs are let through.
 */
const RECEPTION_SUPERVISOR_READ_ROUTES = [/^\/api\/bookings\/new$/, /^\/api\/bookings\/[^/]+$/];

/**
 * WHAT A QUẢN LÝ KỸ THUẬT MAY REACH — default deny: its incidents (scoped to its
 * branches by the service), the branch list and room catalog, its notifications,
 * and the technical export of the shared report.
 */
const TECHNICAL_MANAGER_ROUTES = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/branches(\/|$)/,
  /^\/api\/issues(\/|$)/,
  /^\/api\/admin\/reports\/operational(\.pdf|\.xlsx)?$/,
  /^\/api\/nav-badges$/,
  /^\/api\/notifications(\/|$)/,
];

function supervisorMayReach(req: Request): boolean {
  const path = req.originalUrl.split('?')[0] ?? '';
  if (RECEPTION_SUPERVISOR_ROUTES.some((route) => route.test(path))) return true;
  return req.method === 'GET' && RECEPTION_SUPERVISOR_READ_ROUTES.some((route) => route.test(path));
}

/**
 * WHAT BỘ PHẬN BUỒNG PHÒNG MAY REACH — the only routes `requireAuth` lets a
 * HOUSEKEEPING account through.
 *
 * DEFAULT DENY, AT THE ONE GATE EVERY PROTECTED ROUTE ALREADY PASSES. A
 * housekeeping account is bound to a branch like a receptionist, and a good
 * many routes decide "who is not an admin" by comparing `user.branchId` — the
 * booking lists, the incident list, the reports. Left to those routes the role
 * would silently read its own hotel's bookings and incidents. Listing what it
 * MAY reach is one short list that cannot be forgotten by the next route added;
 * listing what it may not would be every route in the application.
 *
 * `/auth` is here so it can sign in, read its own profile and change its
 * password; `/nav-badges` and `/notifications` are per-user and empty for it.
 */
const HOUSEKEEPING_ROUTES = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/housekeeping(\/|$)/,
  /^\/api\/hotel-deliveries(\/|$)/,
  /^\/api\/nav-badges$/,
  /^\/api\/notifications(\/|$)/,
  // The room catalog of its own branch, for the inspection form's selector,
  // and the branch list "Vào ca" / "Đổi chi nhánh" chooses from.
  /^\/api\/branches\/\d+\/rooms$/,
  /^\/api\/branches$/,
];

function housekeepingMayReach(req: Request): boolean {
  const path = req.originalUrl.split('?')[0] ?? '';
  return HOUSEKEEPING_ROUTES.some((route) => route.test(path));
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
      if (user.role === 'HOUSEKEEPING' && !housekeepingMayReach(req)) {
        next(ApiError.forbidden());
        return;
      }
      if (
        (user.role === 'RECEPTION_MANAGER' || user.role === 'RECEPTION_GENERAL_MANAGER') &&
        !supervisorMayReach(req)
      ) {
        next(ApiError.forbidden());
        return;
      }
      if (user.role === 'TECHNICAL_MANAGER') {
        const path = req.originalUrl.split('?')[0] ?? '';
        if (!TECHNICAL_MANAGER_ROUTES.some((route) => route.test(path))) {
          next(ApiError.forbidden());
          return;
        }
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
  // Quản lý kỹ thuật is scoped to its assigned branches (branchScope.ts) — not here.
  return role === 'ADMIN' || role === 'TECHNICAL';
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
