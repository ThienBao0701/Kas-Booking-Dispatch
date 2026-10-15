import type { RequestHandler } from 'express';
import { ApiError } from '../lib/errors';
import { env, isProduction } from '../config/env';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The single allowed origin host in production, taken from APP_ORIGIN. This is
 * the app's entire "CORS allowlist": Kas serves its own frontend, so there is no
 * cross-origin browser client at all and no `Access-Control-Allow-Origin` header
 * is ever emitted. Comparing against configuration (rather than only against the
 * inbound Host header) means a request forwarded with an unexpected Host cannot
 * define its own notion of "same origin".
 */
export function allowedOriginHost(): string | null {
  if (!env.APP_ORIGIN) return null;
  try {
    return new URL(env.APP_ORIGIN).host;
  } catch {
    return null;
  }
}

/**
 * Defense-in-depth CSRF mitigation.
 *
 * The session cookie is SameSite=Lax, which already stops other sites from
 * making cookie-bearing state-changing requests in a browser — but that is not
 * a full CSRF defense on its own. In production the client is served from the
 * same origin as the API, so any state-changing request whose Origin/Referer
 * names a different host is illegitimate and rejected here.
 *
 * Enforced only in production: local development proxies the client dev server
 * and tests use a non-browser client, neither of which sends a matching Origin.
 */
export const sameOriginCheck: RequestHandler = (req, _res, next) => {
  if (!isProduction || SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // The configured public origin wins; the inbound Host header is only the
  // fallback for a deployment that has not declared APP_ORIGIN.
  const expected = allowedOriginHost() ?? req.headers.host;
  const source = req.headers.origin ?? req.headers.referer;
  // Non-browser / same-origin internal callers send no Origin or Referer.
  if (!expected || !source) {
    next();
    return;
  }

  try {
    if (new URL(source).host !== expected) {
      next(ApiError.forbidden('Yêu cầu bị từ chối: khác nguồn gốc.'));
      return;
    }
  } catch {
    next(ApiError.forbidden('Yêu cầu bị từ chối: nguồn gốc không hợp lệ.'));
    return;
  }
  next();
};
