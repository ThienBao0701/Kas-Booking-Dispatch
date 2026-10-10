import session from 'express-session';
import type { RequestHandler } from 'express';
import type { UserRole } from '@prisma/client';
import { env, isTest } from '../config/env';
import { prisma } from '../db/prisma';
import { PrismaSessionStore } from './prismaSessionStore';

// Only the minimal identity is kept in the session; everything authoritative
// (active, mustChangePassword, current role/branch) is re-read from the
// database on each protected request.
declare module 'express-session' {
  interface SessionData {
    userId?: number;
    role?: UserRole;
    branchId?: number | null;
    /**
     * Dev-test only: the branch the `reception_test` account is currently testing.
     * Lives only in the session (never in the user's permanent DB branch) and is
     * honoured solely when the developer tools are enabled and the user is the
     * dedicated test receptionist. Cleared on logout.
     */
    activeTestBranchId?: number | null;
    /**
     * Set when this session was opened with the Admin Override Password rather
     * than the account's own password. Authorization is unchanged — the session
     * is the account's — and it ends when the override password is changed or
     * turned off. The override is never accepted as the account's current
     * password, so the account's own password cannot be changed with it.
     */
    adminOverride?: boolean;
  }
}

/** Name of the session cookie; the browser only ever holds this opaque id. */
export const SESSION_COOKIE_NAME = 'hbd.sid';

const maxAgeMs = env.SESSION_MAX_AGE_HOURS * 60 * 60 * 1000;

/**
 * Single shared store instance so account management (disable / reset-password)
 * can invalidate a user's sessions directly.
 */
export const sessionStore = new PrismaSessionStore(prisma, maxAgeMs);

// Background pruning of expired sessions in real runs; never during tests.
if (!isTest) {
  sessionStore.startPruneTimer(15 * 60 * 1000);
}

export function createSessionMiddleware(): RequestHandler {
  return session({
    name: SESSION_COOKIE_NAME,
    secret: env.SESSION_SECRET,
    store: sessionStore,
    // The store persists on change; no need to rewrite unchanged sessions.
    resave: false,
    // Do not persist anonymous sessions (nothing stored until login).
    saveUninitialized: false,
    // Rolling expiration: each request refreshes the idle timeout.
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // False in development; driven by SESSION_COOKIE_SECURE in production.
      secure: env.SESSION_COOKIE_SECURE,
      maxAge: maxAgeMs,
      path: '/',
    },
  });
}
