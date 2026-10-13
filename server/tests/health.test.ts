import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { testPrisma } from './helpers/db';

const app = createApp();

describe('GET /api/health', () => {
  it('returns 200 with a real database connectivity result', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.database.connected).toBe(true);
    expect(typeof response.body.database.latencyMs).toBe('number');
    expect(typeof response.body.uptimeSeconds).toBe('number');
  });

  it('echoes a request id header', async () => {
    const response = await request(app).get('/api/health');

    expect(response.headers['x-request-id']).toBeTruthy();
  });
});

describe('GET /api/ready — the migration ledger', () => {
  const ledger = (name: string, finished: boolean, rolledBack: boolean) =>
    testPrisma.$executeRaw`
      INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
      VALUES (${`test-${name}`}, 'test', ${name}, now(), ${finished ? new Date() : null}, ${rolledBack ? new Date() : null}, 0)`;
  const migrationsCheck = async () =>
    ((await request(app).get('/api/ready')).body.checks as { name: string; ok: boolean }[]).find((c) => c.name === 'migrations')!.ok;

  afterEach(async () => {
    await testPrisma.$executeRaw`DELETE FROM "_prisma_migrations" WHERE id LIKE 'test-%'`;
  });

  it('treats a failed attempt that was resolved as rolled back as history, not as pending', async () => {
    // As on the production database: the failed attempt, resolved, and the
    // same migration applied again afterwards.
    await ledger('29990101000000_resolved_failure', false, true);
    expect(await migrationsCheck()).toBe(true);
  });

  it('still fails readiness while an attempt is unfinished and unresolved', async () => {
    await ledger('29990101000001_stuck', false, false);
    expect(await migrationsCheck()).toBe(false);
  });
});
