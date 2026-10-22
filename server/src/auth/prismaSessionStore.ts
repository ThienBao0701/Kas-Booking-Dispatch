import { Store, type SessionData } from 'express-session';
import type { PrismaClient } from '@prisma/client';

type ErrorCallback = (err?: unknown) => void;
type GetCallback = (err: unknown, session?: SessionData | null) => void;

/**
 * express-session store backed by the application's Prisma/SQLite database.
 *
 * Why not a dedicated SQLite session package (connect-sqlite3 / better-sqlite3):
 * both pull in a native module whose install script is blocked by this
 * project's allow-list, so they cannot build reliably here. Reusing the Prisma
 * connection is the simplest store that actually works, survives restarts, and
 * prunes expired rows.
 *
 * The session payload lives in `data`; `userId` is mirrored into its own column
 * so all of a user's sessions can be dropped when the account is disabled or
 * its password is reset.
 */
export class PrismaSessionStore extends Store {
  private readonly prisma: PrismaClient;
  private readonly defaultTtlMs: number;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(prisma: PrismaClient, defaultTtlMs: number) {
    super();
    this.prisma = prisma;
    this.defaultTtlMs = defaultTtlMs;
  }

  private expiryFor(session: SessionData): Date {
    const cookieExpires = session.cookie?.expires;
    if (cookieExpires) return new Date(cookieExpires);
    return new Date(Date.now() + this.defaultTtlMs);
  }

  get(sid: string, callback: GetCallback): void {
    this.prisma.session
      .findUnique({ where: { id: sid } })
      .then(async (row) => {
        if (!row) {
          callback(null, null);
          return;
        }
        // Expired rows are treated as absent and cleaned up lazily on access.
        if (row.expiresAt.getTime() <= Date.now()) {
          await this.prisma.session.deleteMany({ where: { id: sid } });
          callback(null, null);
          return;
        }
        callback(null, JSON.parse(row.data) as SessionData);
      })
      .catch((err: unknown) => callback(err));
  }

  set(sid: string, session: SessionData, callback?: ErrorCallback): void {
    const data = JSON.stringify(session);
    const expiresAt = this.expiryFor(session);
    const userId = typeof session.userId === 'number' ? session.userId : null;
    this.prisma.session
      .upsert({
        where: { id: sid },
        update: { data, userId, expiresAt },
        create: { id: sid, data, userId, expiresAt },
      })
      .then(() => callback?.())
      .catch((err: unknown) => callback?.(err));
  }

  destroy(sid: string, callback?: ErrorCallback): void {
    // deleteMany, not delete: destroying an already-absent session (e.g. the
    // never-persisted anonymous session dropped during regenerate) is a
    // success and must not raise — or log — a "record not found" error.
    this.prisma.session
      .deleteMany({ where: { id: sid } })
      .then(() => callback?.())
      .catch((err: unknown) => callback?.(err));
  }

  override touch(sid: string, session: SessionData, callback?: () => void): void {
    const expiresAt = this.expiryFor(session);
    // updateMany tolerates a session that was destroyed concurrently.
    this.prisma.session
      .updateMany({ where: { id: sid }, data: { expiresAt } })
      .then(() => callback?.())
      .catch(() => callback?.());
  }

  /** Invalidates every session owned by a user (disable / password reset). */
  async destroyByUserId(userId: number): Promise<number> {
    const result = await this.prisma.session.deleteMany({ where: { userId } });
    return result.count;
  }

  /**
   * Ends every session opened with the Admin Override Password (the payload's
   * `adminOverride: true`) — when that password is changed or turned off.
   */
  async destroyAdminOverrideSessions(): Promise<number> {
    const result = await this.prisma.session.deleteMany({ where: { data: { contains: '"adminOverride":true' } } });
    return result.count;
  }

  /** Deletes all expired sessions. Returns the number removed. */
  async prune(): Promise<number> {
    const result = await this.prisma.session.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    return result.count;
  }

  /**
   * Starts a periodic background sweep of expired sessions. Disabled during
   * tests so it never keeps the process alive or interferes with timing.
   */
  startPruneTimer(intervalMs: number): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      void this.prune().catch(() => undefined);
    }, intervalMs);
    // Do not let the sweep hold the event loop open on shutdown.
    this.sweepTimer.unref();
  }

  stopPruneTimer(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }
}
