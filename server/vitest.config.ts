import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { resolveTestDatabaseUrl } from './src/d1/testDatabase';

// The suite runs against REAL PostgreSQL, in its own schema inside the
// dedicated, disposable kas_test database — production runs on PostgreSQL, and
// enum handling, concurrent writes, partial unique indexes and sequence
// allocation all behave differently on SQLite.
//
// kas_test exists for nothing but this suite. It replaced kas_dev_cn1, which
// was named here while it was in fact the live production database — so the
// documented `npm test` dropped and recreated a schema inside production.
//
// The URL comes from KAS_TEST_DATABASE_URL and from nowhere else: resolution
// fails closed rather than falling back to a file, so an unset variable stops
// the run instead of silently pointing it at whatever .env.d1.local contains.
// No password is ever written into this file.
const testDatabaseUrl = resolveTestDatabaseUrl();

// Proof screenshots land in a throwaway dir so the suite never writes into the
// real server/uploads tree.
const testProofDir = path.join(__dirname, '.tmp', 'proof-uploads');
const testIssueDir = path.join(__dirname, '.tmp', 'issue-photos');
const testChargeDir = path.join(__dirname, '.tmp', 'charge-documents');
const testChatDir = path.join(__dirname, '.tmp', 'chat-attachments');

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/setup/globalSetup.ts'],
    // The suite shares ONE PostgreSQL schema, and most files reset it in
    // beforeEach. Running files in parallel would let one file's reset delete
    // another file's fixtures mid-test. Kept serial for determinism; the
    // dedicated concurrency suite opens its own extra connections explicitly
    // when it needs two writers at once.
    fileParallelism: false,
    // Generous margin: this can run on a CPU-contended VM where a bcrypt-backed
    // login is occasionally slow. Well above real durations, still catches hangs.
    testTimeout: 20000,
    // beforeEach resets the DB, re-seeds branches and logs in several agents;
    // under full-suite load on a contended VM that can momentarily exceed the
    // 10s default. Match the test timeout so a slow reset is not a false failure.
    hookTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl,
      SESSION_SECRET: 'test-session-secret-value',
      // A throwaway 32-byte key so card encryption is exercised for real in
      // tests. Deliberately NOT the development key, and it never leaves here.
      CARD_ENCRYPTION_KEY: 'dGVzdC1jYXJkLWtleS0zMi1ieXRlcy1leGFjdGx5ISE=',
      // Cheapest valid bcrypt cost so hashing does not dominate the suite.
      BCRYPT_COST: '4',
      PROOF_UPLOAD_DIR: testProofDir,
      ISSUE_UPLOAD_DIR: testIssueDir,
      CHARGE_UPLOAD_DIR: testChargeDir,
      CHAT_UPLOAD_DIR: testChatDir,
      // Developer test tools are exercised by the dev-test suites; the disabled
      // gate is verified via setDevToolsOverride(false) within those tests.
      ENABLE_DEV_TEST_TOOLS: 'true',
    },
    include: ['tests/**/*.test.ts'],
  },
});
