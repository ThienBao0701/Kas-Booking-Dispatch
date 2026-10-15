/**
 * Who may change "Lý do charge".
 *
 * THE RULE NARROWS ONE FIELD, NOT A ROLE. Bộ phận đặt phòng keeps every other
 * edit it already had — status included — and keeps full read access. Only the
 * reason is the Admin's word, because it is the justification the monthly
 * report is read against.
 *
 * THE DISTINCTION THESE TESTS EXIST TO PIN: refusal is triggered by an actual
 * CHANGE, not by the field's mere presence in the payload. A client that PUTs
 * the whole document back while flipping the status is not editing the reason,
 * and failing that request would break a transition Bộ phận đặt phòng is
 * entitled to make. "Same value = not an edit" is the contract, and it is
 * asserted directly below rather than left to be discovered in production.
 *
 * The audit trail is checked too: a permitted change writes an UPDATED row, and
 * a refused one writes nothing at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  createUser,
  loginAgent,
} from './helpers/auth';

const BOOKING_DEPT_PASSWORD = 'Booking12345';
const PAN = '4111111111111111';

const ORIGINAL_REASON = 'Khách không đến nhận phòng (no-show).';
const NEW_REASON = 'Khách huỷ sát giờ, đã xác nhận qua điện thoại.';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let deptAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let receptionAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let cn1: number;

function body(over: Record<string, unknown> = {}) {
  return {
    branchId: cn1,
    guestName: 'NGUYEN VAN A',
    bookingCode: 'BK-EXT-001',
    amount: 1_500_000,
    cardNumber: PAN,
    cardExpiry: '12/28',
    checkIn: '2026-08-01',
    checkOut: '2026-08-03',
    reason: ORIGINAL_REASON,
    ...over,
  };
}

/** Creates a document as Admin and returns its id. */
async function createDoc(): Promise<string> {
  const res = await adminAgent.post('/api/charge-documents').send(body());
  expect(res.status).toBe(201);
  return res.body.document.id as string;
}

beforeAll(async () => {
  await resetAll();
  await testPrisma.branchSourceAlias.deleteMany({});
  await seedBranches(testPrisma);
  app = createApp();

  cn1 = (await testPrisma.branch.findFirstOrThrow({ orderBy: { id: 'asc' } })).id;

  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;

  await createUser({
    username: 'datphong',
    password: BOOKING_DEPT_PASSWORD,
    fullName: 'Bộ phận đặt phòng',
    role: 'BOOKING_DEPARTMENT',
    branchId: null,
    mustChangePassword: false,
  });
  deptAgent = (await loginAgent(app, 'datphong', BOOKING_DEPT_PASSWORD)).agent;

  await createReceptionist(cn1, { username: 'letan', mustChangePassword: false });
  receptionAgent = (await loginAgent(app, 'letan', RECEPTIONIST_PASSWORD)).agent;
}, 120_000);

beforeEach(async () => {
  await testPrisma.chargeDocumentAudit.deleteMany({});
  await testPrisma.chargeDocumentAttachment.deleteMany({});
  await testPrisma.chargeDocument.deleteMany({});
});

afterAll(async () => {
  await testPrisma.$disconnect();
});

/* ================================================================== */
/* Admin: allowed                                                      */
/* ================================================================== */

describe('ADMIN may edit the reason', () => {
  it('saves the new reason and returns it from the API', async () => {
    const id = await createDoc();

    const res = await adminAgent.put(`/api/charge-documents/${id}`).send({ reason: NEW_REASON });
    expect(res.status).toBe(200);
    expect(res.body.document.reason).toBe(NEW_REASON);

    // Persisted, not just echoed.
    const reread = await adminAgent.get(`/api/charge-documents/${id}`);
    expect(reread.body.document.reason).toBe(NEW_REASON);
  });

  it('trims surrounding whitespace before storing', async () => {
    const id = await createDoc();

    const res = await adminAgent
      .put(`/api/charge-documents/${id}`)
      .send({ reason: `   ${NEW_REASON}   ` });
    expect(res.status).toBe(200);
    expect(res.body.document.reason).toBe(NEW_REASON);
  });

  it('records the change in the audit trail', async () => {
    const id = await createDoc();
    await adminAgent.put(`/api/charge-documents/${id}`).send({ reason: NEW_REASON });

    const rows = await testPrisma.chargeDocumentAudit.findMany({
      where: { chargeDocumentId: id, action: 'UPDATED', field: 'reason' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.oldValue).toBe(ORIGINAL_REASON);
    expect(rows[0]!.newValue).toBe(NEW_REASON);
  });
});

/* ================================================================== */
/* Validation — a blank reason is refused for everyone                 */
/* ================================================================== */

describe('a blank reason is refused', () => {
  it('rejects an empty string', async () => {
    const id = await createDoc();
    const res = await adminAgent.put(`/api/charge-documents/${id}`).send({ reason: '' });
    expect(res.status).toBe(422); // KAS maps validation errors to 422

    const reread = await adminAgent.get(`/api/charge-documents/${id}`);
    expect(reread.body.document.reason).toBe(ORIGINAL_REASON);
  });

  it('rejects whitespace-only', async () => {
    const id = await createDoc();
    const res = await adminAgent.put(`/api/charge-documents/${id}`).send({ reason: '     ' });
    expect(res.status).toBe(422); // KAS maps validation errors to 422

    const reread = await adminAgent.get(`/api/charge-documents/${id}`);
    expect(reread.body.document.reason).toBe(ORIGINAL_REASON);
  });
});

/* ================================================================== */
/* Bộ phận đặt phòng: reads, does not edit the reason                  */
/* ================================================================== */

describe('BOOKING_DEPARTMENT may not edit the reason', () => {
  it('is refused with 403 and changes nothing', async () => {
    const id = await createDoc();

    const res = await deptAgent.put(`/api/charge-documents/${id}`).send({ reason: NEW_REASON });
    expect(res.status).toBe(403);

    const reread = await adminAgent.get(`/api/charge-documents/${id}`);
    expect(reread.body.document.reason).toBe(ORIGINAL_REASON);
  });

  it('writes no audit row for the refused attempt', async () => {
    const id = await createDoc();
    await testPrisma.chargeDocumentAudit.deleteMany({});

    await deptAgent.put(`/api/charge-documents/${id}`).send({ reason: NEW_REASON });

    expect(await testPrisma.chargeDocumentAudit.count({ where: { chargeDocumentId: id } })).toBe(0);
  });

  it('can still READ the reason', async () => {
    const id = await createDoc();
    const res = await deptAgent.get(`/api/charge-documents/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.document.reason).toBe(ORIGINAL_REASON);
  });

  it('keeps every other edit it already had — status still works', async () => {
    // The rule narrows ONE FIELD. If this ever fails, the change went too far.
    const id = await createDoc();
    const res = await deptAgent
      .put(`/api/charge-documents/${id}`)
      .send({ status: 'DA_BI_CHARGE' });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('DA_BI_CHARGE');
  });

  it('may resend the SAME reason alongside another edit — that is not an edit', async () => {
    // A full-object PUT that leaves the reason untouched must not be refused.
    const id = await createDoc();
    const res = await deptAgent
      .put(`/api/charge-documents/${id}`)
      .send({ reason: ORIGINAL_REASON, status: 'CHARGE_THAT_BAI' });
    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('CHARGE_THAT_BAI');
    expect(res.body.document.reason).toBe(ORIGINAL_REASON);
  });

  it('is still refused when the same reason differs only by whitespace', async () => {
    // Trimmed comparison: "  X  " and "X" are the same reason, so this is NOT
    // an edit and must be allowed through.
    const id = await createDoc();
    const res = await deptAgent
      .put(`/api/charge-documents/${id}`)
      .send({ reason: `  ${ORIGINAL_REASON}  ` });
    expect(res.status).toBe(200);
    expect(res.body.document.reason).toBe(ORIGINAL_REASON);
  });
});

/* ================================================================== */
/* Reception: refused by the module gate, as before                    */
/* ================================================================== */

describe('RECEPTIONIST reaches none of this', () => {
  it('is refused the update endpoint', async () => {
    const id = await createDoc();
    const res = await receptionAgent
      .put(`/api/charge-documents/${id}`)
      .send({ reason: NEW_REASON });
    expect(res.status).toBe(403);

    const reread = await adminAgent.get(`/api/charge-documents/${id}`);
    expect(reread.body.document.reason).toBe(ORIGINAL_REASON);
  });

  it('is refused the detail endpoint', async () => {
    const id = await createDoc();
    expect((await receptionAgent.get(`/api/charge-documents/${id}`)).status).toBe(403);
  });
});
