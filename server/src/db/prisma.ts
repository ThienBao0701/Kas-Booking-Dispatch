import { PrismaClient } from '@prisma/client';
import { isProduction } from '../config/env';

export const prisma = new PrismaClient({
  log: isProduction ? ['warn', 'error'] : ['warn', 'error'],
});

/** Real connectivity probe used by the health endpoint. */
export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the schema the code expects has actually been deployed.
 *
 * A reachable PostgreSQL server is not the same thing as a MIGRATED one: after
 * the D.1 cutover an operator can easily start the app against a database that
 * exists but has never had `prisma migrate deploy` run against it, and every
 * request would then fail at the first query instead of at startup. Readiness
 * asks Prisma's own `_prisma_migrations` ledger, which is the only source of
 * truth for "the deployed schema matches this build".
 *
 * Returns `null` when the question cannot be answered (server unreachable) so
 * the caller can distinguish "not migrated" from "not connected".
 *
 * Nothing here surfaces SQL, a migration name or a connection string to the
 * caller — readiness is a boolean-shaped answer by design.
 */
export async function checkMigrationsApplied(): Promise<boolean | null> {
  try {
    const rows = await prisma.$queryRaw<{ pending: bigint }[]>`
      SELECT count(*)::bigint AS pending
      FROM "_prisma_migrations"
      WHERE "finished_at" IS NULL OR "rolled_back_at" IS NOT NULL
    `;
    const applied = await prisma.$queryRaw<{ total: bigint }[]>`
      SELECT count(*)::bigint AS total
      FROM "_prisma_migrations"
      WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
    `;
    const pending = Number(rows[0]?.pending ?? 0n);
    const total = Number(applied[0]?.total ?? 0n);
    return pending === 0 && total > 0;
  } catch {
    // The table is absent on a database that was never migrated, and the query
    // also fails when the server is down. `checkDatabase` disambiguates.
    return null;
  }
}
