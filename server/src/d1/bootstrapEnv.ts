/**
 * Side-effect module: makes `config/env` loadable for the D.1 CLI tools.
 *
 * WHY THIS EXISTS: `config/env` validates the WHOLE application environment as
 * a module side-effect — SESSION_SECRET, upload directories, the lot. That is
 * exactly right for the server process, but the D.1 tools (transfer, verify,
 * restore drill) start no server, sign no cookie and serve no request; they
 * only need a database connection. Without this they would refuse to run
 * unless an operator invented a SESSION_SECRET first.
 *
 * SAFETY: the defaults are applied ONLY when NODE_ENV is not "production", and
 * ONLY to variables that are still unset. A real production deployment always
 * has these set, so nothing here can weaken it, and the placeholder secret can
 * never end up signing a real session — no D.1 tool creates one.
 *
 * `DATABASE_URL` is filled from `.env.d1.local` when present, which is what
 * lets `npm.cmd run d1:drill` work with no environment set up at all.
 *
 * MUST be imported BEFORE anything that pulls in `config/env`.
 */
import { loadD1DatabaseUrl } from './localEnv';

if (process.env.NODE_ENV !== 'production') {
  process.env.NODE_ENV ??= 'development';

  if (!process.env.DATABASE_URL) {
    try {
      process.env.DATABASE_URL = loadD1DatabaseUrl();
    } catch {
      // No local file: leave DATABASE_URL unset so config/env produces its own
      // clear "DATABASE_URL is required" error rather than a confusing one.
    }
  }

  // Not a secret and never used as one: no D.1 tool creates or verifies a
  // session. It exists purely to satisfy the shared environment schema.
  process.env.SESSION_SECRET ??= 'd1-tooling-placeholder-no-session-is-ever-signed';
}
