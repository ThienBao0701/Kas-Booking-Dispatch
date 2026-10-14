import type { IncomingHttpHeaders } from 'node:http';
import type { RequestHandler } from 'express';

/**
 * ONE ADDRESS FOR THE APPLICATION: the public origin (APP_ORIGIN).
 *
 * Production is configured for exactly that origin — the session cookie is
 * Secure, the same-origin check accepts only its host, and the security headers
 * tell the browser to upgrade every sub-request to https. A computer that opens
 * the server by another address (the LAN address `http://192.168.x.x:3001`
 * from the old setup guide, or an app installed from it) therefore gets a page
 * whose scripts are "upgraded" to an https port that does not exist: a blank
 * screen, then a refused login. Nothing that page could run would explain why.
 *
 * So a PAGE request that arrives by another address is sent to the same path at
 * the public origin, before any of that happens. Deliberately narrow:
 *
 *   - production only, and only when APP_ORIGIN is configured;
 *   - GET/HEAD page navigations only — never `/api`, whose callers (monitoring,
 *     scripts, health checks on the LAN) keep answering exactly as before;
 *   - never a request that came through Cloudflare (it carries `cf-ray` /
 *     `cf-connecting-ip`), and never a loopback host: whatever Host header the
 *     tunnel sends to the origin, its traffic cannot be redirected, so there is
 *     no way for this to loop for the people already using the public address;
 *   - a temporary redirect, so no browser keeps it if the configuration changes.
 *
 * Security is unchanged: no origin is added to any allow-list and no cookie
 * setting is relaxed.
 */

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

export interface CanonicalRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  /** Path and query, as received. */
  originalUrl: string;
  headers: IncomingHttpHeaders;
}

/** The URL to send this request to, or null to serve it where it is. */
export function canonicalRedirectTarget(
  req: CanonicalRequest,
  options: { production: boolean; appOrigin: string | undefined },
): string | null {
  if (!options.production || !options.appOrigin) return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  if (req.path === '/api' || req.path.startsWith('/api/')) return null;
  // Arrived through the Cloudflare tunnel: already the public address.
  if (req.headers['cf-ray'] !== undefined || req.headers['cf-connecting-ip'] !== undefined) return null;

  let canonical: URL;
  let requested: URL;
  try {
    canonical = new URL(options.appOrigin);
    const host = req.headers.host;
    if (!host) return null;
    requested = new URL(`http://${host}`);
  } catch {
    return null;
  }
  if (LOOPBACK.test(requested.hostname)) return null;
  if (requested.host.toLowerCase() === canonical.host.toLowerCase()) return null;

  const target = new URL(req.originalUrl.startsWith('/') ? req.originalUrl : `/${req.originalUrl}`, canonical.origin);
  // Only ever the configured origin, whatever the request path contained.
  return target.origin === canonical.origin ? target.href : null;
}

export function canonicalOriginRedirect(options: { production: boolean; appOrigin: string | undefined }): RequestHandler {
  return (req, res, next) => {
    const target = canonicalRedirectTarget(req, options);
    if (!target) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, target);
  };
}
