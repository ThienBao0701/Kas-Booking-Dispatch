import { Router, type Request } from 'express';
import type { UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { env } from '../config/env';
import { normalizeUsername } from '../auth/username';
import {
  hashPassword,
  passwordSchema,
  verifyAgainstDummy,
  verifyPassword,
} from '../auth/password';
import { serializeUser } from '../auth/serialize';
import { SESSION_COOKIE_NAME } from '../auth/session';
import { requireAuth } from '../middleware/auth';
import { createLoginRateLimiter } from '../middleware/rateLimit';

const loginSchema = z.object({
  username: z.string().min(1, 'Tên đăng nhập là bắt buộc.'),
  password: z.string().min(1, 'Mật khẩu là bắt buộc.'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Mật khẩu hiện tại là bắt buộc.'),
  newPassword: passwordSchema,
});

// Promisified express-session callbacks.
function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

/** Writes the minimal identity into a freshly regenerated session. */
function setSessionIdentity(req: Request, user: { id: number; role: UserRole; branchId: number | null }): void {
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.branchId = user.branchId;
}

export function createAuthRouter(): Router {
  const router = Router();

  // POST /api/auth/login
  router.post('/auth/login', createLoginRateLimiter(), (req, res, next) => {
    (async () => {
      const { username, password } = loginSchema.parse(req.body);
      const normalized = normalizeUsername(username);

      const user = await prisma.user.findUnique({
        where: { username: normalized },
        include: { branch: true },
      });

      if (!user) {
        // Spend the same work as a real verify so timing does not reveal
        // whether the username exists, then fail with the generic message.
        await verifyAgainstDummy(password);
        throw ApiError.invalidCredentials();
      }

      const passwordOk = await verifyPassword(password, user.passwordHash);
      if (!passwordOk) {
        throw ApiError.invalidCredentials();
      }

      // Only after the password is verified do we reveal a disabled account,
      // so this cannot be used to enumerate which usernames are disabled.
      if (!user.active) {
        throw ApiError.accountDisabled();
      }

      // Session fixation protection: a brand-new session id for the logged-in
      // identity, never the pre-login anonymous one.
      await regenerateSession(req);
      setSessionIdentity(req, user);
      await saveSession(req);

      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
        include: { branch: true },
      });

      res.json({
        user: serializeUser(updated),
        mustChangePassword: updated.mustChangePassword,
      });
    })().catch(next);
  });

  // POST /api/auth/logout — succeeds even when no session is present.
  router.post('/auth/logout', (req, res, next) => {
    (async () => {
      if (req.session) {
        await destroySession(req).catch(() => undefined);
      }
      res.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.SESSION_COOKIE_SECURE,
        path: '/',
      });
      res.json({ success: true });
    })().catch(next);
  });

  // GET /api/auth/me
  router.get('/auth/me', requireAuth, (req, res, next) => {
    if (!req.currentUser) {
      next(ApiError.authRequired());
      return;
    }
    res.json({ user: serializeUser(req.currentUser) });
  });

  // POST /api/auth/change-password — allowed even while mustChangePassword.
  router.post('/auth/change-password', requireAuth, (req, res, next) => {
    (async () => {
      const user = req.currentUser;
      if (!user) {
        throw ApiError.authRequired();
      }

      const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

      const currentOk = await verifyPassword(currentPassword, user.passwordHash);
      if (!currentOk) {
        throw ApiError.invalidCredentials('Mật khẩu hiện tại không đúng.');
      }

      const sameAsOld = await verifyPassword(newPassword, user.passwordHash);
      if (sameAsOld) {
        throw ApiError.validation('Mật khẩu mới phải khác mật khẩu hiện tại.');
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
      });

      // Regenerate the session after a credential change.
      await regenerateSession(req);
      setSessionIdentity(req, user);
      await saveSession(req);

      res.json({ success: true });
    })().catch(next);
  });

  return router;
}
