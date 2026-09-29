/**
 * "GIAO NHẬN HÀNG HÓA CỦA KHÁCH SẠN" — one shared record, three departments'
 * views, and the 12-hour rule.
 *
 * THE CLAIMS THIS FILE EXISTS TO PROVE:
 *   1. Submitting records the item as "Đã hoàn thành", with the creation and
 *      completion instants preserved.
 *   2. Quantity is a NUMBER — a string, zero, a fraction and a negative are all
 *      refused — and the department is one of the three.
 *   3. The 12-hour rule is read off the clock: an item is ACTIVE until exactly
 *      twelve hours after it was completed and ARCHIVED from then on, at the
 *      boundary and not a minute either side.
 *   4. There is ONE copy of the record: Reception, the Admin, Technical and
 *      Housekeeping read the same rows, each scoped to what its role may see.
 *   5. A correction changes what was delivered but never when, and leaves an
 *      audit row; a voided row leaves the departments' views.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { seedBranches } from '../src/db/seed';
import { resetAll, resetIssueData, resetShiftData, testPrisma } from './helpers/db';
import {
  ADMIN_PASSWORD,
  RECEPTIONIST_PASSWORD,
  createAdmin,
  createReceptionist,
  createUser,
  loginAgent,
} from './helpers/auth';
import { resetClock, setClock } from '../src/lib/clock';

const app = createApp();
type Agent = Awaited<ReturnType<typeof loginAgent>>['agent'];

const hcm = (day: string, hhmm: string) =>
  new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 7 * 60 * 60 * 1000);

let cn1 = 0;
let cn2 = 0;
let letan: Agent;
let letan2: Agent;
let admin: Agent;
let tech: Agent;
let housekeeping: Agent;
let housekeeping2: Agent;
let booking: Agent;

beforeAll(async () => {
  await resetAll();
  await seedBranches(testPrisma);
  cn1 = (await testPrisma.branch.findUniqueOrThrow({ where: { code: 'TRUONG_DINH_05' } })).id;
  cn2 = (await testPrisma.branch.findFirstOrThrow({ where: { id: { not: cn1 } }, orderBy: { id: 'asc' } })).id;

  await createReceptionist(cn1, { username: 'letan1', mustChangePassword: false });
  await createReceptionist(cn2, { username: 'letan2', mustChangePassword: false });
  await createAdmin({ mustChangePassword: false });
  await createUser({ username: 'kythuat', password: RECEPTIONIST_PASSWORD, fullName: 'Kỹ thuật', role: 'TECHNICAL' });
  await createUser({ username: 'buong1', password: RECEPTIONIST_PASSWORD, fullName: 'Buồng 1', role: 'HOUSEKEEPING', branchId: cn1 });
  await createUser({ username: 'buong2', password: RECEPTIONIST_PASSWORD, fullName: 'Buồng 2', role: 'HOUSEKEEPING', branchId: cn2 });
  await createUser({ username: 'datphong', password: RECEPTIONIST_PASSWORD, fullName: 'Đặt phòng', role: 'BOOKING_DEPARTMENT' });

  letan = (await loginAgent(app, 'letan1', RECEPTIONIST_PASSWORD)).agent;
  letan2 = (await loginAgent(app, 'letan2', RECEPTIONIST_PASSWORD)).agent;
  admin = (await loginAgent(app, 'admin', ADMIN_PASSWORD)).agent;
  tech = (await loginAgent(app, 'kythuat', RECEPTIONIST_PASSWORD)).agent;
  housekeeping = (await loginAgent(app, 'buong1', RECEPTIONIST_PASSWORD)).agent;
  housekeeping2 = (await loginAgent(app, 'buong2', RECEPTIONIST_PASSWORD)).agent;
  booking = (await loginAgent(app, 'datphong', RECEPTIONIST_PASSWORD)).agent;
});

beforeEach(async () => {
  await resetIssueData();
  await resetShiftData();
  setClock({ now: () => hcm('2026-09-19', '07:00') });
  for (const [agent, name] of [[letan, 'Nguyễn Văn A'], [letan2, 'Trần Thị B']] as const) {
    const res = await agent.post('/api/reception/shifts/check-in').send({ shiftType: 'A', receptionistName: name });
    expect(res.status).toBe(201);
  }
});

afterAll(async () => {
  resetClock();
  await resetAll();
});

const deliver = (delivery: Record<string, unknown>, agent: Agent = letan) =>
  agent.post('/api/reception/reports').send({ category: 'HOTEL_DELIVERY', delivery });

const list = async (agent: Agent, scope: 'active' | 'archived' = 'active') => {
  const res = await agent.get(`/api/hotel-deliveries?scope=${scope}`);
  expect(res.status).toBe(200);
  return res.body.deliveries as { id: string; delivery: { itemName: string; department: string }; voided: boolean }[];
};

describe('recording a delivery', () => {
  it('is born "Đã hoàn thành", with the creation and completion instants kept', async () => {
    const res = await deliver({ department: 'HOUSEKEEPING', itemName: 'Khăn tắm', quantity: 24, note: 'Giao 8h' });
    expect(res.status).toBe(201);
    const report = res.body.report;
    expect(report.category).toBe('HOTEL_DELIVERY');
    expect(report.delivery).toMatchObject({
      department: 'HOUSEKEEPING',
      departmentLabel: 'Buồng phòng',
      itemName: 'Khăn tắm',
      quantity: 24,
      note: 'Giao 8h',
      status: 'COMPLETED',
      statusLabel: 'Đã hoàn thành',
      archived: false,
    });
    expect(report.createdAt).toBe(hcm('2026-09-19', '07:00').toISOString());
    expect(report.delivery.completedAt).toBe(report.createdAt);
    // The branch, the shift and the person come from the session, as for every category.
    expect(report).toMatchObject({ branchId: cn1, shiftName: 'Ca A', createdByName: 'Nguyễn Văn A' });
  });

  it('serves the three departments in the operator’s words', async () => {
    const res = await letan.get('/api/reception/reports/options');
    expect(res.body.deliveryDepartments).toEqual([
      { code: 'RECEPTION', label: 'Lễ tân' },
      { code: 'HOUSEKEEPING', label: 'Buồng phòng' },
      { code: 'TECHNICAL', label: 'Kỹ thuật' },
    ]);
    expect(res.body.deliveryTitle).toBe('Giao nhận hàng hóa của khách sạn');
    expect(res.body.deliveryArchiveHours).toBe(12);
  });

  it.each([
    ['a string', '5'],
    ['zero', 0],
    ['a fraction', 1.5],
    ['a negative', -3],
    ['nothing', undefined],
  ])('refuses %s as a quantity', async (_label, quantity) => {
    const res = await deliver({ department: 'RECEPTION', itemName: 'Bút', quantity });
    expect(res.status).toBe(422);
    expect(await testPrisma.hotelDeliveryReport.count()).toBe(0);
  });

  it('refuses an unknown department and an empty item name', async () => {
    expect((await deliver({ department: 'KITCHEN', itemName: 'Bút', quantity: 1 })).status).toBe(422);
    expect((await deliver({ department: 'RECEPTION', itemName: '   ', quantity: 1 })).status).toBe(422);
  });

  it('needs an open shift like every other journal entry', async () => {
    await resetShiftData();
    expect((await deliver({ department: 'RECEPTION', itemName: 'Bút', quantity: 1 })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('the 12-hour rule', () => {
  it('keeps an item active until exactly twelve hours after completion, then archives it', async () => {
    await deliver({ department: 'RECEPTION', itemName: 'Chìa khóa dự phòng', quantity: 2 });

    setClock({ now: () => new Date(hcm('2026-09-19', '07:00').getTime() + (12 * 60 - 1) * 60_000) });
    expect(await list(letan, 'active')).toHaveLength(1);
    expect(await list(letan, 'archived')).toHaveLength(0);

    setClock({ now: () => new Date(hcm('2026-09-19', '07:00').getTime() + 12 * 60 * 60_000) });
    expect(await list(letan, 'active')).toHaveLength(0);
    const archived = await list(letan, 'archived');
    expect(archived).toHaveLength(1);
    expect(archived[0]!.delivery.itemName).toBe('Chìa khóa dự phòng');
  });

  it('says so on the record itself, from the same clock', async () => {
    const created = await deliver({ department: 'RECEPTION', itemName: 'Ô dù', quantity: 3 });
    setClock({ now: () => hcm('2026-09-20', '07:00') });
    const [row] = await list(letan, 'archived');
    expect((row as unknown as { delivery: { archived: boolean } }).delivery.archived).toBe(true);
    // Nothing was rewritten: the stored row is exactly what it was.
    const stored = await testPrisma.hotelDeliveryReport.findUniqueOrThrow({ where: { reportId: created.body.report.id } });
    expect(stored.completedAt.toISOString()).toBe(hcm('2026-09-19', '07:00').toISOString());
  });

  it('is not tied to the shift: an item outlives the shift that recorded it', async () => {
    await deliver({ department: 'RECEPTION', itemName: 'Ô dù', quantity: 3 });
    await letan.post('/api/reception/shifts/end').send({}).catch(() => undefined);
    await testPrisma.receptionShiftSession.updateMany({ data: { closedAt: hcm('2026-09-19', '14:00') } });
    setClock({ now: () => hcm('2026-09-19', '15:00') });
    expect(await list(letan, 'active')).toHaveLength(1);
  });
});

describe('one record, four views', () => {
  beforeEach(async () => {
    await deliver({ department: 'RECEPTION', itemName: 'Bút', quantity: 10 });
    await deliver({ department: 'HOUSEKEEPING', itemName: 'Khăn', quantity: 20 });
    await deliver({ department: 'TECHNICAL', itemName: 'Bóng đèn', quantity: 5 });
    await deliver({ department: 'HOUSEKEEPING', itemName: 'Ga giường', quantity: 8 }, letan2);
    await deliver({ department: 'TECHNICAL', itemName: 'Ống nước', quantity: 2 }, letan2);
  });

  const names = async (agent: Agent) => (await list(agent)).map((r) => r.delivery.itemName).sort();

  it('shows Reception its own branch, every department', async () => {
    expect(await names(letan)).toEqual(['Bút', 'Bóng đèn', 'Khăn'].sort());
    expect(await names(letan2)).toEqual(['Ga giường', 'Ống nước'].sort());
  });

  it('shows the Admin every branch', async () => {
    expect(await names(admin)).toEqual(['Bút', 'Bóng đèn', 'Ga giường', 'Khăn', 'Ống nước'].sort());
    const one = await admin.get(`/api/hotel-deliveries?branchId=${cn2}`);
    expect(one.body.deliveries).toHaveLength(2);
  });

  it('shows Technical only the Kỹ thuật department, across branches', async () => {
    expect(await names(tech)).toEqual(['Bóng đèn', 'Ống nước'].sort());
  });

  it('shows Housekeeping only its own branch’s Buồng phòng items', async () => {
    expect(await names(housekeeping)).toEqual(['Khăn']);
    expect(await names(housekeeping2)).toEqual(['Ga giường']);
  });

  it('refuses a role with no part in it', async () => {
    expect((await booking.get('/api/hotel-deliveries')).status).toBe(403);
  });

  it('lets none of the reading departments write', async () => {
    const body = { category: 'HOTEL_DELIVERY', delivery: { department: 'TECHNICAL', itemName: 'X', quantity: 1 } };
    expect((await tech.post('/api/reception/reports').send(body)).status).toBe(403);
    expect((await housekeeping.post('/api/reception/reports').send(body)).status).toBe(403);
    expect((await admin.post('/api/reception/reports').send(body)).status).toBe(403);
  });

  it('appears in the Admin period report under its own category, counted', async () => {
    const res = await admin.get(`/api/admin/reports/operational?branchId=${cn1}&category=HOTEL_DELIVERY`);
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(3);
    expect(res.body.counts.HOTEL_DELIVERY).toBe(3);
  });
});

describe('correcting and voiding', () => {
  it('changes what was delivered, never when, and writes an audit row per field', async () => {
    const created = await deliver({ department: 'RECEPTION', itemName: 'Bút', quantity: 10 });
    const id = created.body.report.id as string;
    setClock({ now: () => hcm('2026-09-19', '09:00') });

    const res = await letan
      .patch(`/api/reception/reports/${id}`)
      .send({ delivery: { quantity: 12, department: 'TECHNICAL', completedAt: '2020-01-01T00:00:00Z' } });
    expect(res.status).toBe(200);
    expect(res.body.report.delivery).toMatchObject({ quantity: 12, department: 'TECHNICAL' });
    expect(res.body.report.delivery.completedAt).toBe(hcm('2026-09-19', '07:00').toISOString());
    expect(res.body.report.audits.map((a: { field: string }) => a.field).sort()).toEqual(['department', 'quantity']);
  });

  it('refuses a corrected quantity that is not a whole number', async () => {
    const created = await deliver({ department: 'RECEPTION', itemName: 'Bút', quantity: 10 });
    const res = await letan
      .patch(`/api/reception/reports/${created.body.report.id}`)
      .send({ delivery: { quantity: 0 } });
    expect(res.status).toBe(422);
  });

  it('takes a voided item out of the other departments’ views, and keeps it for Reception', async () => {
    const created = await deliver({ department: 'HOUSEKEEPING', itemName: 'Khăn', quantity: 20 });
    const id = created.body.report.id as string;
    expect((await letan.post(`/api/reception/reports/${id}/void`).send({ reason: 'Nhập nhầm' })).status).toBe(200);

    expect(await list(housekeeping)).toHaveLength(0);
    const own = await list(letan);
    expect(own).toHaveLength(1);
    expect(own[0]!.voided).toBe(true);
    expect(await testPrisma.hotelDeliveryReport.count()).toBe(1);
  });
});
