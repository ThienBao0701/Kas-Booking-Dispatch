import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import { createAdmin } from './helpers/auth';
import { generateDemoData } from '../src/devtest/demoFactory';
import { ensureTestReceptionist } from '../src/devtest/testAccount';
import { prepareForProduction, RESET_DUMP_NAME } from '../src/devtest/prepareProduction';
import { env, PROOF_UPLOAD_DIR, ISSUE_UPLOAD_DIR } from '../src/config/env';
import { BRANCH_COUNT } from '../src/db/branches';
import { TEST_RECEPTIONIST_USERNAME } from '../src/devtest/constants';

// The reset takes a real pg_dump archive of DATABASE_URL before it deletes
// anything; there is no database FILE to point at any more.
const databaseUrl = env.DATABASE_URL;
const scratch = path.join(__dirname, '..', '.tmp', 'reset-tests');

function freshBackupRoot(): string {
  return path.join(scratch, `bk-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

let adminId: number;

beforeEach(async () => {
  await resetAll();
  await testPrisma.demoDataBatch.deleteMany({});
  await seedBranches(testPrisma);
  adminId = (await createAdmin({ mustChangePassword: false })).id;
  await ensureTestReceptionist(testPrisma);
  // Seed operational data (demo, incl. a proof file) so the reset has work to do.
  await generateDemoData({ bookingsPerBranch: 3, issuesPerBranch: 2, includeProofs: true, includeOcr: true, includeComparisons: true, seed: 7 }, adminId, testPrisma);
});

afterAll(async () => {
  await testPrisma.$disconnect();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('prepareForProduction — official launch reset', () => {
  it('refuses without confirmation', async () => {
    await expect(prepareForProduction({ confirmed: false, backupRoot: freshBackupRoot() })).rejects.toThrow();
  });

  it('backs up first, wipes all operational data, and preserves branches + admin', async () => {
    expect(await testPrisma.booking.count()).toBeGreaterThan(0);
    const backupRoot = freshBackupRoot();

    const manifest = await prepareForProduction({
      confirmed: true,
      databaseUrl,
      uploadDirs: [PROOF_UPLOAD_DIR, ISSUE_UPLOAD_DIR],
      backupRoot,
      client: testPrisma,
    });

    // Backup exists with a manifest + a copy of the DB.
    expect(manifest.backupDir).not.toBeNull();
    expect(fs.existsSync(path.join(manifest.backupDir!, 'manifest.json'))).toBe(true);
    const dump = path.join(manifest.backupDir!, RESET_DUMP_NAME);
    expect(fs.existsSync(dump), 'pre-reset pg_dump archive must exist').toBe(true);
    // A zero-byte file would satisfy existsSync but restore nothing.
    expect(fs.statSync(dump).size).toBeGreaterThan(0);
    expect(manifest.before.bookings).toBeGreaterThan(0);

    // All operational data gone.
    for (const c of Object.values(manifest.after)) expect(c).toBe(0);
    expect(await testPrisma.booking.count()).toBe(0);
    expect(await testPrisma.hotelIssue.count()).toBe(0);
    expect(await testPrisma.bookingProofComparison.count()).toBe(0);
    expect(await testPrisma.demoDataBatch.count()).toBe(0);

    // Preserved.
    expect(manifest.branchesPreserved).toBe(BRANCH_COUNT);
    expect(manifest.adminsPreserved).toBe(1);
    // reception_test disabled.
    expect(manifest.testReceptionist).toBe('disabled');
    const testUser = await testPrisma.user.findFirst({ where: { username: TEST_RECEPTIONIST_USERNAME } });
    expect(testUser?.active).toBe(false);

    // Upload dirs emptied.
    const proofFiles = fs.existsSync(PROOF_UPLOAD_DIR) ? fs.readdirSync(PROOF_UPLOAD_DIR) : [];
    expect(proofFiles).toHaveLength(0);
  });

  it('aborts (no deletion) if the backup fails', async () => {
    // Use a backupRoot whose parent is a FILE, so mkdir fails.
    const blocker = path.join(scratch, `blocker-${Date.now()}`);
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(blocker, 'x');
    const before = await testPrisma.booking.count();

    await expect(
      prepareForProduction({ confirmed: true, databaseUrl, uploadDirs: [PROOF_UPLOAD_DIR], backupRoot: path.join(blocker, 'sub'), client: testPrisma }),
    ).rejects.toThrow();

    // Nothing was deleted.
    expect(await testPrisma.booking.count()).toBe(before);
  });

  it('is idempotent (a second run leaves the system safely empty)', async () => {
    await prepareForProduction({ confirmed: true, databaseUrl, uploadDirs: [PROOF_UPLOAD_DIR, ISSUE_UPLOAD_DIR], backupRoot: freshBackupRoot(), client: testPrisma });
    const second = await prepareForProduction({ confirmed: true, databaseUrl, uploadDirs: [PROOF_UPLOAD_DIR, ISSUE_UPLOAD_DIR], backupRoot: freshBackupRoot(), client: testPrisma });
    for (const c of Object.values(second.after)) expect(c).toBe(0);
    expect(second.branchesPreserved).toBe(BRANCH_COUNT);
  });
});
