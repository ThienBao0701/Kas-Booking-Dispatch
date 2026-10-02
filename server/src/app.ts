import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { CLIENT_DIST_DIR, env, serveClient } from './config/env';
import { createApiRouter } from './routes';
import { createSessionMiddleware } from './auth/session';
import { requestContext } from './middleware/requestContext';
import { requestLogger } from './middleware/requestLogger';
import { sameOriginCheck } from './middleware/sameOrigin';
import { notFoundHandler } from './middleware/notFound';
import { errorHandler } from './middleware/errorHandler';

export function createApp(): Express {
  const app = express();

  // The real client IP matters for the login rate limiter. TRUST_PROXY is the
  // number of proxies actually in front of this process (1 behind the bundled
  // Caddy). Trusting more hops than exist would let a client forge
  // X-Forwarded-For entries and slip past the limiter.
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use(helmet());
  // Before the body parsers: a malformed JSON body must still produce an
  // error response carrying a requestId.
  app.use(requestContext);
  // JSON body size limit — reject oversized payloads.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // Session must be established before any route reads req.session.
  app.use(createSessionMiddleware());
  // Reject cross-origin state-changing requests (production only).
  app.use(sameOriginCheck);

  if (env.NODE_ENV === 'development') {
    app.use(requestLogger);
  }

  app.use('/api', createApiRouter());

  // Single-container production: this same process serves the built client, so
  // the browser is always same-origin with the API and the session cookie needs
  // no cross-site relaxation. Mounted AFTER /api so an API path can never be
  // answered by a static file or by the SPA shell.
  if (serveClient) {
    mountClient(app);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Serves the Vite build with an SPA fallback.
 *
 * - Hashed build assets are immutable and cached for a year.
 * - `index.html` and the service worker are never cached, so a release is picked
 *   up on the next navigation instead of being pinned by a stale shell.
 * - The fallback answers GET/HEAD only, and never for `/api` — an unknown API
 *   route must stay a JSON 404, not silently return HTML.
 */
function mountClient(app: Express): void {
  if (!fs.existsSync(path.join(CLIENT_DIST_DIR, 'index.html'))) {
    // Not fatal: the API is still fully functional (this is also the normal
    // state in development, where the Vite dev server owns the frontend).
    // eslint-disable-next-line no-console
    console.warn('Không tìm thấy bản build của client — chỉ phục vụ API.');
    return;
  }

  app.use(
    express.static(CLIENT_DIST_DIR, {
      index: false,
      etag: true,
      setHeaders: (res, filePath) => {
        const name = path.basename(filePath);
        if (name === 'index.html' || name === 'sw.js' || name === 'registerSW.js') {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(CLIENT_DIST_DIR, 'index.html'), (err) => {
      if (err) next();
    });
  });
}
