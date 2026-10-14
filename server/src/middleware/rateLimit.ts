import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { env } from '../config/env';
import { ApiError } from '../lib/errors';

/**
 * Rate limiter for the login endpoint only — deliberately not applied to the
 * booking APIs, which are trusted internal traffic. A fresh instance is created
 * per app so each test file (and the rate-limit test in particular) gets its
 * own counter state and cannot make sibling tests flaky.
 */
export function createLoginRateLimiter(): RequestHandler {
  return rateLimit({
    windowMs: env.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    limit: env.LOGIN_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Route the limit breach through the shared API error format (429).
    handler: (_req, _res, next) => {
      next(
        new ApiError(
          'RATE_LIMITED',
          'Bạn đã thử đăng nhập quá nhiều lần. Vui lòng thử lại sau ít phút.',
        ),
      );
    },
  });
}

/**
 * "Vào ca" by address — bounded per ACCOUNT (the session's user, not the IP), so
 * an authenticated housekeeper cannot try address after address to learn which
 * hotels exist. Only the REFUSED attempts count: opening the shift is not a
 * guess. Generous enough for real typing mistakes; a fresh instance per app,
 * like the login limiter.
 */
export function createWorkplaceRateLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `workplace:${req.currentUser?.id ?? 'anonymous'}`,
    handler: (_req, _res, next) => {
      next(new ApiError('RATE_LIMITED', 'Bạn đã nhập địa chỉ quá nhiều lần. Vui lòng thử lại sau ít phút.'));
    },
  });
}

/**
 * "Vào ca", step one — the address lookup. EVERY lookup counts (a lookup that
 * names a hotel is exactly what an enumeration would want), per account, in its
 * own budget beside the start's. Generous for a person typing a few digits with
 * a pause between them; nowhere near enough to walk every prefix.
 */
export function createWorkplaceLookupRateLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 40,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `workplace-lookup:${req.currentUser?.id ?? 'anonymous'}`,
    handler: (_req, _res, next) => {
      next(new ApiError('RATE_LIMITED', 'Bạn đã tra địa chỉ quá nhiều lần. Vui lòng thử lại sau ít phút.'));
    },
  });
}
