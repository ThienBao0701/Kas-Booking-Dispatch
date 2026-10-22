/**
 * Production bootstrap seed.
 *
 * Creates ONLY configuration: the branches and their Booking.com / Agoda hotel
 * names. It never creates a booking, a proof, an issue, a notification, a demo
 * batch, the `reception_test` account or any other operational row — a
 * production database starts empty of business data by design.
 *
 * It reuses the existing `seedBranches` + `backfillBranchAliases`, which are
 * already idempotent and non-destructive:
 *   - branches are upserted by stable code, so re-running never duplicates one;
 *   - a branch number the Admin has changed is preserved (only an unset 0 is
 *     filled in);
 *   - an alias row that already exists is left exactly as it is, so an alias the
 *     Admin deliberately DISABLED is never re-enabled by a later seed;
 *   - a name already claimed by another branch is skipped rather than moved.
 *
 * Safe to run on every deploy.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { backfillBranchAliases, seedBranches } from '../db/seed';
import { BRANCHES } from '../db/branches';
import { TEST_RECEPTIONIST_USERNAME } from '../devtest/constants';
import { normalizeUsername } from '../auth/username';

export interface ProductionSeedResult {
  branches: number;
  aliasesCreated: number;
  aliasesTotal: number;
  /** Operational rows found. All must be 0 on a freshly bootstrapped system. */
  operational: {
    bookings: number;
    proofs: number;
    issues: number;
    notifications: number;
    demoBatches: number;
    demoBookings: number;
  };
  /** True when the dev-only test receptionist exists (must not, in production). */
  testReceptionistPresent: boolean;
  warnings: string[];
}

export async function runProductionSeed(
  client: PrismaClient = defaultPrisma,
): Promise<ProductionSeedResult> {
  const branches = await seedBranches(client);
  const aliasesCreated = await backfillBranchAliases(client);
  const aliasesTotal = await client.branchSourceAlias.count();

  const [bookings, proofs, issues, notifications, demoBatches, demoBookings, testUser] =
    await Promise.all([
      client.booking.count(),
      client.bookingCreationProof.count(),
      client.hotelIssue.count(),
      client.notification.count(),
      client.demoDataBatch.count(),
      client.booking.count({ where: { isDemo: true } }),
      client.user.findUnique({ where: { username: normalizeUsername(TEST_RECEPTIONIST_USERNAME) } }),
    ]);

  const warnings: string[] = [];
  if (branches !== BRANCHES.length) {
    // Not an error: the Admin may legitimately have added a ninth branch.
    warnings.push(
      `Cơ sở dữ liệu có ${branches} chi nhánh (seed cấu hình ${BRANCHES.length}). Kiểm tra nếu không mong đợi.`,
    );
  }
  if (demoBookings > 0 || demoBatches > 0) {
    warnings.push('Phát hiện DỮ LIỆU DEMO trong cơ sở dữ liệu này — không được dùng cho production.');
  }
  if (testUser) {
    warnings.push(`Tài khoản "${TEST_RECEPTIONIST_USERNAME}" tồn tại — phải xóa/khóa trước khi vận hành thật.`);
  }

  return {
    branches,
    aliasesCreated,
    aliasesTotal,
    operational: { bookings, proofs, issues, notifications, demoBatches, demoBookings },
    testReceptionistPresent: testUser !== null,
    warnings,
  };
}
