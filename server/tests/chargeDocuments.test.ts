/**
 * The Chứng từ API: authorization, CRUD, attachments, the reveal, and the
 * monthly report.
 *
 * Two themes run through all of it:
 *
 *   RECEPTION IS REFUSED BY THE SERVER, not by a hidden menu. Every endpoint is
 *   probed directly with a receptionist session.
 *
 *   A CARD NUMBER LEAVES ONLY THROUGH THE REVEAL. The list, the detail, the
 *   report, the export and the audit trail are each checked for its absence —
 *   because "we did not add it" is not the same as "it cannot appear".
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
const OTHER_PAN = '5555555555554444';

let app: ReturnType<typeof createApp>;
let adminAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let deptAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let receptionAgent: Awaited<ReturnType<typeof loginAgent>>['agent'];
let cn1: number;
let cn2: number;

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
    reason: 'Khách không đến nhận phòng (no-show).',
    ...over,
  };
}

const create = (over: Record<string, unknown> = {}) =>
  adminAgent.post('/api/charge-documents').send(body(over));

/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');

beforeAll(async () => {
  await resetAll();
  await testPrisma.branchSourceAlias.deleteMany({});
  await seedBranches(testPrisma);
  app = createApp();

  cn1 = (await testPrisma.branch.findFirstOrThrow({ orderBy: { id: 'asc' } })).id;
  cn2 = (await testPrisma.branch.findFirstOrThrow({ orderBy: { id: 'desc' } })).id;

  await createAdmin({ mustChangePassword: false });
  adminAgent = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;

  // Bộ phận đặt phòng: GLOBAL, so no branch.
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
/* Authorization                                                       */
/* ================================================================== */

describe('authorization', () => {
  it('lets an ADMIN use the module', async () => {
    expect((await create()).status).toBe(201);
    expect((await adminAgent.get('/api/charge-documents')).status).toBe(200);
  });

  it('lets BỘ PHẬN ĐẶT PHÒNG use the module, across any branch', async () => {
    // Global role: it has no branch of its own and must still reach both.
    const first = await deptAgent.post('/api/charge-documents').send(body({ branchId: cn1 }));
    const second = await deptAgent.post('/api/charge-documents').send(body({ branchId: cn2 }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await deptAgent.get('/api/charge-documents')).body.documents).toHaveLength(2);
  });

  it('refuses a RECEPTIONIST on every endpoint, not just the menu', async () => {
    const created = (await create()).body.document;
    const attachment = 'does-not-matter';

    // Built lazily and awaited one at a time: eleven simultaneous supertest
    // requests exhaust the ephemeral server rather than testing anything.
    const calls: [string, () => Promise<{ status: number }>][] = [
      ['list', () => receptionAgent.get('/api/charge-documents')],
      ['create', () => receptionAgent.post('/api/charge-documents').send(body())],
      ['detail', () => receptionAgent.get(`/api/charge-documents/${created.id}`)],
      ['update', () => receptionAgent.put(`/api/charge-documents/${created.id}`).send({ amount: 1 })],
      ['audit', () => receptionAgent.get(`/api/charge-documents/${created.id}/audit`)],
      ['reveal', () => receptionAgent.post(`/api/charge-documents/${created.id}/card`)],
      ['report', () => receptionAgent.get('/api/charge-documents/report?month=2026-08')],
      ['export', () => receptionAgent.get('/api/charge-documents/report/export?month=2026-08')],
      ['upload', () => receptionAgent.post(`/api/charge-documents/${created.id}/attachments`)],
      ['file', () => receptionAgent.get(`/api/charge-documents/attachments/${attachment}/file`)],
      ['delete', () => receptionAgent.delete(`/api/charge-documents/attachments/${attachment}`)],
    ];

    for (const [name, call] of calls) {
      expect((await call()).status, name).toBe(403);
    }
  });

  it('refuses an anonymous caller', async () => {
    const { default: request } = await import('supertest');
    expect((await request(app).get('/api/charge-documents')).status).toBe(401);
  });
});

/* ================================================================== */
/* CRUD                                                                */
/* ================================================================== */

describe('creating a charge document', () => {
  it('stores it as Chưa xử lý, with no charge date', async () => {
    // A new document must never be assumed charged.
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body.document.status).toBe('CHUA_XU_LY');
    expect(res.body.document.chargedAt).toBeNull();
  });

  it('encrypts the card and returns only the last four', async () => {
    const res = await create();
    const doc = res.body.document;
    expect(doc.cardLast4).toBe('1111');
    expect(doc.cardMasked).toBe('•••• 1111');
    expect(JSON.stringify(doc)).not.toContain(PAN);

    const row = await testPrisma.chargeDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(row.cardNumberCipher).not.toContain(PAN);
    expect(row.cardKeyVersion).toBe(1);
  });

  it('requires a reason', async () => {
    const res = await create({ reason: '   ' });
    expect(res.status).toBe(422);
    expect(await testPrisma.chargeDocument.count()).toBe(0);
  });

  it('requires a branch that exists', async () => {
    expect((await create({ branchId: 99_999 })).status).toBe(422);
  });

  it('rejects an implausible card number without echoing it', async () => {
    const res = await create({ cardNumber: '4111111111111112' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain('4111111111111112');
  });

  it('records a creation audit event carrying no card data', async () => {
    const doc = (await create()).body.document;
    const events = await testPrisma.chargeDocumentAudit.findMany({
      where: { chargeDocumentId: doc.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('CREATED');
    expect(JSON.stringify(events)).not.toContain(PAN);
  });
});

describe('updating', () => {
  it('sets chargedAt when the status becomes Đã bị charge', async () => {
    const doc = (await create()).body.document;
    const res = await adminAgent
      .put(`/api/charge-documents/${doc.id}`)
      .send({ status: 'DA_BI_CHARGE' });
    expect(res.body.document.status).toBe('DA_BI_CHARGE');
    expect(res.body.document.chargedAt).not.toBeNull();
  });

  it('clears chargedAt when a charge stops being successful', async () => {
    // Otherwise a stale timestamp would keep inflating a month's total.
    const doc = (await create()).body.document;
    await adminAgent.put(`/api/charge-documents/${doc.id}`).send({ status: 'DA_BI_CHARGE' });
    const res = await adminAgent
      .put(`/api/charge-documents/${doc.id}`)
      .send({ status: 'CHARGE_THAT_BAI' });
    expect(res.body.document.chargedAt).toBeNull();
  });

  it('preserves the original charge time across an unrelated edit', async () => {
    const doc = (await create()).body.document;
    const charged = (
      await adminAgent.put(`/api/charge-documents/${doc.id}`).send({ status: 'DA_BI_CHARGE' })
    ).body.document.chargedAt;
    const after = await adminAgent
      .put(`/api/charge-documents/${doc.id}`)
      .send({ guestName: 'TEN MOI' });
    expect(after.body.document.chargedAt).toBe(charged);
  });

  it('audits a status change and an amount change', async () => {
    const doc = (await create()).body.document;
    await adminAgent
      .put(`/api/charge-documents/${doc.id}`)
      .send({ status: 'DA_BI_CHARGE', amount: 2_000_000 });
    const events = await testPrisma.chargeDocumentAudit.findMany({
      where: { chargeDocumentId: doc.id },
      orderBy: { createdAt: 'asc' },
    });
    const actions = events.map((e) => e.action);
    expect(actions).toContain('UPDATED');
    expect(actions).toContain('STATUS_CHANGED');
  });

  it('records a card change as masked values only', async () => {
    const doc = (await create()).body.document;
    await adminAgent.put(`/api/charge-documents/${doc.id}`).send({ cardNumber: OTHER_PAN });
    const events = await testPrisma.chargeDocumentAudit.findMany({
      where: { chargeDocumentId: doc.id, field: 'cardNumber' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.oldValue).toBe('•••• 1111');
    expect(events[0]!.newValue).toBe('•••• 4444');
    expect(JSON.stringify(events)).not.toContain(PAN);
    expect(JSON.stringify(events)).not.toContain(OTHER_PAN);
  });

  it('leaves the card alone when the field is omitted', async () => {
    const doc = (await create()).body.document;
    const res = await adminAgent.put(`/api/charge-documents/${doc.id}`).send({ amount: 9 });
    expect(res.body.document.cardLast4).toBe('1111');
  });
});

/* ================================================================== */
/* The reveal                                                          */
/* ================================================================== */

describe('revealing the card number', () => {
  it('returns the full number to an authorized role', async () => {
    const doc = (await create()).body.document;
    const res = await adminAgent.post(`/api/charge-documents/${doc.id}/card`);
    expect(res.status).toBe(200);
    expect(res.body.cardNumber).toBe(PAN);
  });

  it('works for Bộ phận đặt phòng too', async () => {
    const doc = (await create()).body.document;
    expect((await deptAgent.post(`/api/charge-documents/${doc.id}/card`)).body.cardNumber).toBe(PAN);
  });

  it('is refused for a receptionist', async () => {
    const doc = (await create()).body.document;
    expect((await receptionAgent.post(`/api/charge-documents/${doc.id}/card`)).status).toBe(403);
  });

  it('audits WHO looked, without recording the number', async () => {
    const doc = (await create()).body.document;
    await adminAgent.post(`/api/charge-documents/${doc.id}/card`);
    const events = await testPrisma.chargeDocumentAudit.findMany({
      where: { chargeDocumentId: doc.id, action: 'CARD_REVEALED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorRole).toBe('ADMIN');
    expect(events[0]!.newValue).toBe('•••• 1111');
    expect(JSON.stringify(events)).not.toContain(PAN);
  });

  it('sets no-store so the response is never cached', async () => {
    const doc = (await create()).body.document;
    const res = await adminAgent.post(`/api/charge-documents/${doc.id}/card`);
    expect(res.headers['cache-control']).toContain('no-store');
  });
});

/* ================================================================== */
/* The card number never appears anywhere else                         */
/* ================================================================== */

describe('the card number is absent from every other surface', () => {
  it('is absent from the list', async () => {
    await create();
    const res = await adminAgent.get('/api/charge-documents');
    expect(JSON.stringify(res.body)).not.toContain(PAN);
    expect(res.body.documents[0].cardMasked).toBe('•••• 1111');
  });

  it('is absent from the detail', async () => {
    const doc = (await create()).body.document;
    const res = await adminAgent.get(`/api/charge-documents/${doc.id}`);
    expect(JSON.stringify(res.body)).not.toContain(PAN);
  });

  it('is absent from the report', async () => {
    const doc = (await create()).body.document;
    await adminAgent.put(`/api/charge-documents/${doc.id}`).send({ status: 'DA_BI_CHARGE' });
    const month = new Date().toISOString().slice(0, 7);
    const res = await adminAgent.get(`/api/charge-documents/report?month=${month}`);
    expect(JSON.stringify(res.body)).not.toContain(PAN);
  });

  it('is absent from the XLSX export', async () => {
    const doc = (await create()).body.document;
    await adminAgent.put(`/api/charge-documents/${doc.id}`).send({ status: 'DA_BI_CHARGE' });
    const month = new Date().toISOString().slice(0, 7);
    const res = await adminAgent
      .get(`/api/charge-documents/report/export?month=${month}`)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    // A .xlsx is a zip; the digits must not survive anywhere in the bytes.
    expect((res.body as Buffer).includes(Buffer.from(PAN, 'utf8'))).toBe(false);
    expect((res.body as Buffer).includes(Buffer.from('cvv', 'utf8'))).toBe(false);
  });

  it('is absent from the audit endpoint', async () => {
    const doc = (await create()).body.document;
    await adminAgent.post(`/api/charge-documents/${doc.id}/card`);
    const res = await adminAgent.get(`/api/charge-documents/${doc.id}/audit`);
    expect(JSON.stringify(res.body)).not.toContain(PAN);
  });
});

/* ================================================================== */
/* Filtering                                                           */
/* ================================================================== */

describe('filtering happens on the server', () => {
  beforeEach(async () => {
    await create({ branchId: cn1, guestName: 'ALPHA', bookingCode: 'AAA-1', checkIn: '2026-08-01' });
    await create({ branchId: cn2, guestName: 'BETA', bookingCode: 'BBB-2', checkIn: '2026-09-01' });
    const third = (await create({ branchId: cn1, guestName: 'GAMMA', bookingCode: 'CCC-3' })).body
      .document;
    await adminAgent.put(`/api/charge-documents/${third.id}`).send({ status: 'DA_BI_CHARGE' });
  });

  const list = async (qs: string) =>
    (await adminAgent.get(`/api/charge-documents${qs}`)).body.documents as { guestName: string }[];

  it('filters by branch', async () => {
    expect(await list(`?branchId=${cn2}`)).toHaveLength(1);
  });

  it('filters by status', async () => {
    expect(await list('?status=DA_BI_CHARGE')).toHaveLength(1);
    expect(await list('?status=CHUA_XU_LY')).toHaveLength(2);
  });

  it('filters by guest name, case-insensitively', async () => {
    const found = await list('?guestName=alp');
    expect(found).toHaveLength(1);
    expect(found[0]!.guestName).toBe('ALPHA');
  });

  it('filters by booking code', async () => {
    expect(await list('?bookingCode=BBB')).toHaveLength(1);
  });

  it('filters by check-in range, inclusively at both ends', async () => {
    expect(await list('?checkInFrom=2026-09-01&checkInTo=2026-09-01')).toHaveLength(1);
    expect(await list('?checkInFrom=2026-08-01&checkInTo=2026-08-01')).toHaveLength(2);
  });
});

/* ================================================================== */
/* Attachments                                                         */
/* ================================================================== */

describe('attachments', () => {
  it('accepts several images at once for Ảnh khách', async () => {
    const doc = (await create()).body.document;
    const res = await adminAgent
      .post(`/api/charge-documents/${doc.id}/attachments`)
      .field('category', 'GUEST_IMAGE')
      .attach('files', PNG, 'a.png')
      .attach('files', PNG, 'b.png');
    expect(res.status).toBe(201);
    expect(res.body.added).toBe(2);
    expect(res.body.document.attachments).toHaveLength(2);
  });

  it('accepts a PDF for File chứng từ', async () => {
    const doc = (await create()).body.document;
    const res = await adminAgent
      .post(`/api/charge-documents/${doc.id}/attachments`)
      .field('category', 'CHARGE_DOCUMENT')
      .attach('files', PDF, 'chungtu.pdf');
    expect(res.status).toBe(201);
    expect(res.body.document.attachments[0].mimeType).toBe('application/pdf');
  });

  it('refuses a PDF in an image-only slot', async () => {
    const doc = (await create()).body.document;
    const res = await adminAgent
      .post(`/api/charge-documents/${doc.id}/attachments`)
      .field('category', 'CARD_IMAGE')
      .attach('files', PDF, 'not-an-image.pdf');
    expect(res.status).toBe(415);
  });

  it('refuses a file whose real bytes are not what it claims', async () => {
    // The declared MIME is not trusted: a renamed executable must not be stored.
    const doc = (await create()).body.document;
    const res = await adminAgent
      .post(`/api/charge-documents/${doc.id}/attachments`)
      .field('category', 'GUEST_IMAGE')
      .attach('files', Buffer.from('MZ\x90\x00 not really a png at all'), 'evil.png');
    expect(res.status).toBe(415);
    expect(await testPrisma.chargeDocumentAttachment.count()).toBe(0);
  });

  it('serves the bytes only to an authorized caller, privately', async () => {
    const doc = (await create()).body.document;
    const uploaded = await adminAgent
      .post(`/api/charge-documents/${doc.id}/attachments`)
      .field('category', 'CARD_IMAGE')
      .attach('files', PNG, 'card.png');
    const attachmentId = uploaded.body.document.attachments[0].id as string;

    const ok = await adminAgent.get(`/api/charge-documents/attachments/${attachmentId}/file`);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toContain('no-store');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');

    expect(
      (await receptionAgent.get(`/api/charge-documents/attachments/${attachmentId}/file`)).status,
    ).toBe(403);
  });

  it('refuses a path-traversal attempt in the attachment id', async () => {
    const res = await adminAgent.get(
      '/api/charge-documents/attachments/..%2F..%2F.env/file',
    );
    expect([400, 404]).toContain(res.status);
  });

  it('removes an attachment and audits it', async () => {
    const doc = (await create()).body.document;
    const uploaded = await adminAgent
      .post(`/api/charge-documents/${doc.id}/attachments`)
      .field('category', 'GUEST_IMAGE')
      .attach('files', PNG, 'a.png');
    const attachmentId = uploaded.body.document.attachments[0].id as string;

    expect((await adminAgent.delete(`/api/charge-documents/attachments/${attachmentId}`)).status).toBe(200);
    expect(await testPrisma.chargeDocumentAttachment.count()).toBe(0);
    const events = await testPrisma.chargeDocumentAudit.findMany({
      where: { chargeDocumentId: doc.id, action: 'ATTACHMENT_REMOVED' },
    });
    expect(events).toHaveLength(1);
  });
});

/* ================================================================== */
/* The monthly report                                                  */
/* ================================================================== */

describe('the monthly report', () => {
  /** Charges a document and pins its chargedAt to an exact moment. */
  async function chargedOn(iso: string, amount: number, guestName = 'KHACH') {
    const doc = (await create({ amount, guestName })).body.document;
    await adminAgent.put(`/api/charge-documents/${doc.id}`).send({ status: 'DA_BI_CHARGE' });
    await testPrisma.chargeDocument.update({
      where: { id: doc.id },
      data: { chargedAt: new Date(iso) },
    });
    return doc.id;
  }

  const report = async (month: string) =>
    (await adminAgent.get(`/api/charge-documents/report?month=${month}`)).body.report;

  it('totals only successful charges', async () => {
    await chargedOn('2026-08-10T03:00:00.000Z', 1_000_000, 'A');
    await chargedOn('2026-08-20T03:00:00.000Z', 2_000_000, 'B');

    // A failure and a pending document in the same month: counted, never added.
    const failed = (await create({ amount: 500_000, guestName: 'C' })).body.document;
    await adminAgent.put(`/api/charge-documents/${failed.id}`).send({ status: 'CHARGE_THAT_BAI' });
    await create({ amount: 700_000, guestName: 'D' });

    const r = await report('2026-08');
    expect(r.totals.chargedCount).toBe(2);
    expect(r.totals.chargedAmount).toBe(3_000_000);
    expect(r.totals.failedCount).toBe(1);
    expect(r.totals.failedAmount).toBe(500_000);
    expect(r.totals.pendingCount).toBe(1);
    expect(r.totals.pendingAmount).toBe(700_000);
    // The headline must not have absorbed the others.
    expect(r.totals.chargedAmount).not.toBe(3_000_000 + 500_000);
    expect(r.rows).toHaveLength(2);
  });

  it('uses the charge date, not the creation date', async () => {
    // Raised now, charged in a different month: it belongs to the charge month.
    await chargedOn('2026-07-15T03:00:00.000Z', 900_000, 'JULY');
    expect((await report('2026-07')).totals.chargedAmount).toBe(900_000);
    expect((await report('2026-08')).totals.chargedAmount).toBe(0);
  });

  it('handles month boundaries exactly', async () => {
    // 31 Aug 23:30 UTC is still August; 1 Sep 00:30 UTC is September.
    await chargedOn('2026-08-31T23:30:00.000Z', 100_000, 'LAST');
    await chargedOn('2026-09-01T00:30:00.000Z', 200_000, 'FIRST');
    expect((await report('2026-08')).totals.chargedAmount).toBe(100_000);
    expect((await report('2026-09')).totals.chargedAmount).toBe(200_000);
  });

  it('counts customers, not documents, in the charged figure', async () => {
    await chargedOn('2026-08-02T03:00:00.000Z', 100_000, 'X');
    const r = await report('2026-08');
    expect(r.totals.chargedCount).toBe(r.rows.length);
  });

  it('rejects a malformed month', async () => {
    expect((await adminAgent.get('/api/charge-documents/report?month=2026-13')).status).toBe(422);
    expect((await adminAgent.get('/api/charge-documents/report?month=nonsense')).status).toBe(422);
  });

  it('exports an XLSX whose totals come from the same query', async () => {
    await chargedOn('2026-08-10T03:00:00.000Z', 1_000_000, 'A');
    await chargedOn('2026-08-11T03:00:00.000Z', 2_500_000, 'B');
    const ui = await report('2026-08');

    const res = await adminAgent
      .get('/api/charge-documents/report/export?month=2026-08')
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('bao-cao-charge-2026-08.xlsx');

    // Read it back and compare against the UI's own numbers.
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    // Handed over as an ArrayBuffer: exceljs accepts one, and it sidesteps the
    // Buffer/Uint8Array nominal mismatch between @types/node and exceljs.
    const bytes = new Uint8Array(res.body as Buffer);
    await wb.xlsx.load(bytes.buffer as ArrayBuffer);
    const detail = wb.getWorksheet('Chi tiết đã charge')!;
    // Header + one row per charged document + the TỔNG row.
    expect(detail.rowCount).toBe(ui.rows.length + 2);
    const totalCell = detail.getRow(detail.rowCount).getCell(4).value;
    expect(totalCell).toBe(ui.totals.chargedAmount);
    expect(totalCell).toBe(3_500_000);
  });
});
