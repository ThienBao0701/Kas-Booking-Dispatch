import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { normalizeUsername } from '../auth/username';
import { hashPassword, passwordSchema } from '../auth/password';
import { serializeManagedUser } from '../auth/serialize';
import { sessionStore } from '../auth/session';
import { requireAuth, requireAdmin, requirePasswordChanged } from '../middleware/auth';
import { DELETED_ACCOUNT_USERNAME, deleteAccount } from '../auth/deleteAccount';
import { BRANCH_SET_ROLES as SHARED_BRANCH_SET_ROLES } from '../auth/branchScope';
import { adminOverrideStatus, clearAdminOverridePassword, setAdminOverridePassword } from '../auth/adminOverride';

/**
 * The roles this endpoint may create. ADMIN is deliberately absent: an
 * administrator is bootstrapped, never minted through the user-management API.
 */
const MANAGEABLE_ROLES = [
  'RECEPTIONIST',
  'BOOKING_DEPARTMENT',
  'TECHNICAL',
  'TECHNICAL_MANAGER',
  'HOUSEKEEPING',
  'RECEPTION_MANAGER',
  'RECEPTION_GENERAL_MANAGER',
  // Quản lý buồng phòng: exactly ONE branch, held in `branchId` like a receptionist's.
  'HOUSEKEEPING_MANAGER',
  // Tổng quản lý kỹ thuật: a SET of ticked branches, like a Quản lý kỹ thuật.
  'TECHNICAL_GENERAL_MANAGER',
] as const;

/**
 * The roles that are GLOBAL — branchless by definition. Listing them once, and
 * deriving the branch rules below from it, is what stops a fourth department
 * from being classified by a `!== 'BOOKING_DEPARTMENT'` test that happens to
 * mean "is a receptionist" today and something else tomorrow.
 */
const GLOBAL_ROLES: readonly string[] = [
  'BOOKING_DEPARTMENT',
  'TECHNICAL',
  'TECHNICAL_MANAGER',
  // All branches by definition — no `branchId`, no assignment rows.
  'RECEPTION_GENERAL_MANAGER',
  // Several branches, through UserBranchAssignment — never one `branchId`.
  'RECEPTION_MANAGER',
  'TECHNICAL_MANAGER',
  'TECHNICAL_GENERAL_MANAGER',
];

/** The roles whose branches are a SET of ticked boxes (at least one) — `auth/branchScope.ts`'s list. */
const BRANCH_SET_ROLES: readonly string[] = SHARED_BRANCH_SET_ROLES;

/** Vietnamese department names, for the messages this endpoint returns. */
const ROLE_LABELS: Record<(typeof MANAGEABLE_ROLES)[number], string> = {
  RECEPTIONIST: 'lễ tân',
  BOOKING_DEPARTMENT: 'bộ phận đặt phòng',
  TECHNICAL: 'bộ phận kỹ thuật',
  TECHNICAL_MANAGER: 'quản lý kỹ thuật',
  TECHNICAL_GENERAL_MANAGER: 'tổng quản lý kỹ thuật',
  HOUSEKEEPING: 'bộ phận buồng phòng',
  RECEPTION_MANAGER: 'quản lý lễ tân',
  RECEPTION_GENERAL_MANAGER: 'tổng quản lý lễ tân',
  HOUSEKEEPING_MANAGER: 'quản lý buồng phòng',
};

const createUserSchema = z
  .object({
    username: z.string().trim().min(1, 'Tên đăng nhập là bắt buộc.').max(50),
    fullName: z.string().trim().min(1, 'Họ tên là bắt buộc.').max(100),
    temporaryPassword: passwordSchema,
    // Defaulted so every existing caller that omits it still creates a
    // receptionist exactly as before.
    role: z.enum(MANAGEABLE_ROLES).default('RECEPTIONIST'),
    branchId: z.number().int().positive().optional(),
    /** Quản lý lễ tân only: the branches it supervises (at least one). */
    branchIds: z.array(z.number().int().positive()).max(100).optional(),
    active: z.boolean().optional(),
  })
  // A receptionist IS a branch; a global department must not carry one, or it
  // would silently inherit branch-scoped access somewhere later.
  .refine((v) => v.role !== 'RECEPTIONIST' || v.branchId !== undefined, {
    message: 'Tài khoản lễ tân phải thuộc một chi nhánh.',
    path: ['branchId'],
  })
  .refine((v) => v.role !== 'HOUSEKEEPING_MANAGER' || v.branchId !== undefined, {
    message: 'Quản lý buồng phòng phải được gán đúng một chi nhánh.',
    path: ['branchId'],
  })
  // Bộ phận buồng phòng: the one branch it works at — "Vào ca" opens the shift there.
  .refine((v) => v.role !== 'HOUSEKEEPING' || v.branchId !== undefined, {
    message: 'Bộ phận buồng phòng phải được gán đúng một chi nhánh.',
    path: ['branchId'],
  })
  .refine((v) => !GLOBAL_ROLES.includes(v.role) || v.branchId === undefined, {
    message: 'Tài khoản bộ phận không thuộc chi nhánh nào.',
    path: ['branchId'],
  })
  .refine((v) => !BRANCH_SET_ROLES.includes(v.role) || (v.branchIds?.length ?? 0) > 0, {
    message: 'Tài khoản quản lý phải được gán ít nhất một chi nhánh.',
    path: ['branchIds'],
  })
  .refine((v) => BRANCH_SET_ROLES.includes(v.role) || v.branchIds === undefined, {
    message: 'Chỉ quản lý lễ tân, quản lý kỹ thuật và tổng quản lý kỹ thuật mới được gán nhiều chi nhánh.',
    path: ['branchIds'],
  });

const updateUserSchema = z
  .object({
    fullName: z.string().trim().min(1).max(100).optional(),
    branchId: z.number().int().positive().optional(),
    /** Quản lý lễ tân: REPLACES the whole set of supervised branches. */
    branchIds: z.array(z.number().int().positive()).min(1, 'Chọn ít nhất một chi nhánh.').max(100).optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Cần ít nhất một trường để cập nhật.',
  });

const resetPasswordSchema = z.object({ temporaryPassword: passwordSchema });

/** The same rule as every account's password, typed twice. */
const overridePasswordSchema = z
  .object({ password: passwordSchema, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Mật khẩu xác nhận không khớp.',
    path: ['confirmPassword'],
  });

const listQuerySchema = z.object({
  branchId: z.coerce.number().int().positive().optional(),
  active: z.enum(['true', 'false']).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  /**
   * Also list ADMIN accounts — READ-ONLY, for the account screen's "Admin /
   * Quản trị" section. Opt-in, so every other caller (the reminder recipient
   * picker among them) keeps receiving exactly the manageable roles. Listing
   * grants nothing: `loadReceptionist` still refuses every write to an admin.
   */
  includeAdmins: z.enum(['true']).optional(),
});

function parseUserId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.notFound('Không tìm thấy tài khoản.');
  }
  return id;
}

/** Loads a managed account and guarantees it is a receptionist. */
async function loadReceptionist(id: number) {
  const user = await prisma.user.findUnique({ where: { id }, include: USER_INCLUDE });
  if (!user) {
    throw ApiError.notFound('Không tìm thấy tài khoản.');
  }
  // Admin accounts are off-limits here, so the administrator can never lock
  // itself out or demote itself through this API.
  if (!(MANAGEABLE_ROLES as readonly string[]).includes(user.role)) {
    throw ApiError.forbidden('Chỉ có thể quản lý tài khoản lễ tân và các bộ phận.');
  }
  return user;
}

/** An account with its branch and — for a Quản lý lễ tân — its supervised branches. */
const USER_INCLUDE = {
  branch: true,
  branchAssignments: { include: { branch: true }, orderBy: { branchId: 'asc' } },
} satisfies Prisma.UserInclude;

/** Every id must be an active branch; duplicates collapse to one. */
async function usableBranchIds(ids: readonly number[]): Promise<number[]> {
  const unique = [...new Set(ids)];
  const found = await prisma.branch.count({ where: { id: { in: unique }, active: true } });
  if (found !== unique.length) {
    throw ApiError.validation('Có chi nhánh không hợp lệ hoặc đã ngừng hoạt động.');
  }
  return unique;
}

async function assertBranchUsable(branchId: number): Promise<void> {
  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch || !branch.active) {
    throw ApiError.validation('Chi nhánh không hợp lệ hoặc đã ngừng hoạt động.');
  }
}

export function createAdminUsersRouter(): Router {
  const router = Router();

  // Every account-management endpoint requires an authenticated admin who has
  // already satisfied any forced password change.
  // Gated on ITS OWN prefix: every other /admin router gates its own, and the
  // operational report is shared with the reception supervisors.
  router.use('/admin/users', requireAuth, requirePasswordChanged, requireAdmin);

  // GET /api/admin/users — receptionist accounts, with optional filters.
  router.get('/admin/users', (req, res, next) => {
    (async () => {
      const query = listQuerySchema.parse(req.query);

      // Both manageable roles, so a Bộ phận đặt phòng account is visible and
      // editable in the same screen rather than existing only in the database.
      const roles: Prisma.UserWhereInput['role'] = {
        in: query.includeAdmins ? [...MANAGEABLE_ROLES, 'ADMIN'] : [...MANAGEABLE_ROLES],
      };
      const where: Prisma.UserWhereInput = { role: roles, username: { not: DELETED_ACCOUNT_USERNAME } };
      if (query.branchId !== undefined) where.branchId = query.branchId;
      if (query.active !== undefined) where.active = query.active === 'true';
      if (query.search) {
        where.OR = [
          { username: { contains: query.search } },
          { fullName: { contains: query.search } },
        ];
      }

      const users = await prisma.user.findMany({
        where,
        include: USER_INCLUDE,
        orderBy: { id: 'asc' },
      });
      res.json({ users: users.map(serializeManagedUser) });
    })().catch(next);
  });

  // POST /api/admin/users — create a receptionist.
  router.post('/admin/users', (req, res, next) => {
    (async () => {
      const body = createUserSchema.parse(req.body);
      const username = normalizeUsername(body.username);

      // Only a receptionist has a branch to validate; the schema has already
      // refused a branch on a Bộ phận đặt phòng account.
      if (body.branchId !== undefined) await assertBranchUsable(body.branchId);

      const existing = await prisma.user.findUnique({ where: { username } });
      if (existing) {
        throw ApiError.conflict('Tên đăng nhập đã tồn tại.');
      }

      const managed = BRANCH_SET_ROLES.includes(body.role) ? await usableBranchIds(body.branchIds ?? []) : [];

      const created = await prisma.user.create({
        data: {
          username,
          passwordHash: await hashPassword(body.temporaryPassword),
          fullName: body.fullName,
          role: body.role,
          branchId: body.branchId ?? null,
          active: body.active ?? true,
          mustChangePassword: true,
          ...(managed.length > 0
            ? { branchAssignments: { create: managed.map((branchId) => ({ branchId })) } }
            : {}),
        },
        include: USER_INCLUDE,
      });

      res.status(201).json({ user: serializeManagedUser(created) });
    })().catch(next);
  });

  // PUT /api/admin/users/:id — update fullName / branchId / active only.
  router.put('/admin/users/:id', (req, res, next) => {
    (async () => {
      const id = parseUserId(req.params.id);
      const existing = await loadReceptionist(id);
      const body = updateUserSchema.parse(req.body);

      if (body.branchId !== undefined) {
        // The create path refuses a branch on a global department; the update
        // path did not, so an account could be given one afterwards and end up
        // in a state `createUserSchema` would never have allowed.
        if (GLOBAL_ROLES.includes(existing.role)) {
          const label = ROLE_LABELS[existing.role as (typeof MANAGEABLE_ROLES)[number]] ?? 'bộ phận';
          throw ApiError.validation(`Tài khoản ${label} không thuộc chi nhánh nào.`);
        }
        await assertBranchUsable(body.branchId);
      }

      /*
        A QUẢN LÝ LỄ TÂN'S BRANCHES ARE REPLACED AS A SET. Its chat, reports and
        incident lists follow these rows on its very next request; the records it
        created stay exactly where they are — only visibility moves.
      */
      let managed: number[] | null = null;
      if (body.branchIds !== undefined) {
        if (!BRANCH_SET_ROLES.includes(existing.role)) {
          throw ApiError.validation('Chỉ quản lý lễ tân, quản lý kỹ thuật và tổng quản lý kỹ thuật mới được gán nhiều chi nhánh.');
        }
        managed = await usableBranchIds(body.branchIds);
      }

      const data: Prisma.UserUpdateInput = {};
      if (managed) {
        data.branchAssignments = { deleteMany: {}, create: managed.map((branchId) => ({ branchId })) };
      }
      if (body.fullName !== undefined) data.fullName = body.fullName;
      if (body.active !== undefined) data.active = body.active;
      if (body.branchId !== undefined) data.branch = { connect: { id: body.branchId } };

      const updated = await prisma.user.update({
        where: { id },
        data,
        include: USER_INCLUDE,
      });

      // If this update just disabled the account, drop its live sessions too.
      if (body.active === false) {
        await sessionStore.destroyByUserId(id);
      }

      res.json({ user: serializeManagedUser(updated) });
    })().catch(next);
  });

  // POST /api/admin/users/:id/reset-password — issue a new temporary password.
  /*
    DELETE /api/admin/users/:id — "Xóa": PERMANENT. The account is removed; its
    history stays, under its recorded names and the "Tài khoản đã xóa"
    placeholder (auth/deleteAccount.ts). Admin only (the router gate), never the
    Admin's own account, never an Admin (loadReceptionist refuses), and refused
    while the account has live work.
  */
  router.delete('/admin/users/:id', (req, res, next) => {
    (async () => {
      const id = parseUserId(req.params.id);
      if (id === req.currentUser!.id) throw ApiError.forbidden('Không thể xóa tài khoản đang đăng nhập.');
      const existing = await loadReceptionist(id);
      if (existing.username === DELETED_ACCOUNT_USERNAME) throw ApiError.notFound('Không tìm thấy tài khoản.');
      // Refused BEFORE anything is touched: a refused delete must not sign the person out.
      await deleteAccount(id);
      await sessionStore.destroyByUserId(id);
      res.json({ deleted: true, id });
    })().catch(next);
  });

  router.post('/admin/users/:id/reset-password', (req, res, next) => {
    (async () => {
      const id = parseUserId(req.params.id);
      await loadReceptionist(id);
      const { temporaryPassword } = resetPasswordSchema.parse(req.body);
      const admin = req.currentUser!;

      /*
        ONLY THE HASH IS STORED, and the answer carries no password. The Admin
        typed or generated the temporary one in the browser and is shown it there,
        once; no endpoint can return an account's password, new or old. Who reset
        which account, and when, is kept in AccountAudit — never the value.
      */
      const passwordHash = await hashPassword(temporaryPassword);
      await prisma.$transaction([
        prisma.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true } }),
        prisma.accountAudit.create({
          data: { userId: id, action: 'PASSWORD_RESET', actorUserId: admin.id, actorNameSnapshot: admin.fullName },
        }),
      ]);

      // Force re-authentication with the new temporary password.
      await sessionStore.destroyByUserId(id);

      res.json({ success: true });
    })().catch(next);
  });

  // POST /api/admin/users/:id/enable
  router.post('/admin/users/:id/enable', (req, res, next) => {
    (async () => {
      const id = parseUserId(req.params.id);
      await loadReceptionist(id);
      const updated = await prisma.user.update({
        where: { id },
        data: { active: true },
        include: USER_INCLUDE,
      });
      res.json({ user: serializeManagedUser(updated) });
    })().catch(next);
  });

  // POST /api/admin/users/:id/disable
  router.post('/admin/users/:id/disable', (req, res, next) => {
    (async () => {
      const id = parseUserId(req.params.id);
      await loadReceptionist(id);
      const updated = await prisma.user.update({
        where: { id },
        data: { active: false },
        include: USER_INCLUDE,
      });
      // Existing sessions must stop granting access immediately.
      await sessionStore.destroyByUserId(id);
      res.json({ user: serializeManagedUser(updated) });
    })().catch(next);
  });

  /*
    "MẬT KHẨU GHI ĐÈ ADMIN" — Admin only, on its own prefix. The password is
    written as a hash and never returned: the status says only whether one is set,
    when and by whom.
  */
  router.use('/admin/override-password', requireAuth, requirePasswordChanged, requireAdmin);

  router.get('/admin/override-password', (_req, res, next) => {
    (async () => {
      res.json(await adminOverrideStatus());
    })().catch(next);
  });

  router.put('/admin/override-password', (req, res, next) => {
    (async () => {
      const { password } = overridePasswordSchema.parse(req.body);
      await setAdminOverridePassword(req.currentUser!, password);
      res.json(await adminOverrideStatus());
    })().catch(next);
  });

  router.delete('/admin/override-password', (req, res, next) => {
    (async () => {
      await clearAdminOverridePassword(req.currentUser!);
      res.json(await adminOverrideStatus());
    })().catch(next);
  });

  return router;
}
