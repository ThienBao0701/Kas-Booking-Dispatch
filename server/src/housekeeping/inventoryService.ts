/**
 * HOUSEKEEPING WAREHOUSES — the items, deliveries, counts, laundry, equipment
 * issues and damage reports of each branch's three warehouses.
 *
 * WHO. The Quản lý buồng phòng runs its OWN branch's warehouses (the branch is
 * its account's, never the request's). The Admin reads every branch, counts
 * stock ("Kiểm kho") and reviews damage reports. Housekeeping staff move stock
 * only by completing a room (see `inventoryLedger.applyCleaningStock`). Every
 * id in a request is checked against the actor's branch.
 *
 * HOW. Every document (receipt, count, transfer, damage report) and all its
 * movements are written in ONE transaction, keyed by the client's `requestId`:
 * a retried save returns the document already saved and moves nothing again.
 */
import { Prisma, type InventoryDamageStatus, type InventoryStockState, type InventoryTransferKind, type InventoryWarehouse, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, hcmDateOnly, type Clock } from '../lib/clock';
import { describeLocation } from '../issue/issueArea';
import { ISSUE_STATUS_LABELS } from '../report/incidentPdf';
import { dispatchPush } from '../push/pushService';
import type { HousekeepingActor } from './roomIssueService';
import { managedBranch, managerBranchWhere } from './roomTaskService';
import {
  ALL_WAREHOUSES,
  CODE_PREFIX,
  LEGACY_WAREHOUSE,
  MOVEMENT_LABELS,
  STATE_LABELS,
  WAREHOUSES,
  WAREHOUSE_LABELS,
  WAREHOUSE_STATES,
  applyMovements,
  itemCode,
  itemLabel,
  type MoveInput,
} from './inventoryLedger';

const MAX_LINES = 100;
const MAX_QUANTITY = 100_000;

/* ------------------------------------------------------------------ *
 * Input checks
 * ------------------------------------------------------------------ */

/** Any warehouse a row may name — the four, and the legacy "chưa phân loại" one. */
function warehouseOf(raw: unknown): InventoryWarehouse {
  if (typeof raw !== 'string' || !(ALL_WAREHOUSES as readonly string[]).includes(raw)) throw ApiError.validation('Kho không hợp lệ.');
  return raw as InventoryWarehouse;
}

/** One of the four "Kho hàng" — where new items, receipts and classifications go. */
function activeWarehouseOf(raw: unknown): InventoryWarehouse {
  if (typeof raw !== 'string' || !(WAREHOUSES as readonly string[]).includes(raw)) throw ApiError.validation('Vui lòng chọn một trong bốn kho hàng.');
  return raw as InventoryWarehouse;
}

/**
 * THE NEXT ITEM CODE NUMBER of a warehouse — ONE numbering for the whole
 * system (shared and branch items alike), incremented under its row lock in the
 * caller's transaction: two creations at once wait for each other and never
 * share a number, a shared item never collides with a branch's own, and an
 * archived or deleted item's number is never handed out again.
 */
async function nextCodeNumber(tx: Prisma.TransactionClient, warehouse: InventoryWarehouse): Promise<number> {
  const rows = await tx.$queryRaw<{ lastNumber: number }[]>`
    INSERT INTO "InventoryGlobalCodeSequence" ("warehouse", "lastNumber")
    VALUES (${warehouse}::"InventoryWarehouse", 1)
    ON CONFLICT ("warehouse") DO UPDATE SET "lastNumber" = "InventoryGlobalCodeSequence"."lastNumber" + 1
    RETURNING "lastNumber"`;
  return rows[0]!.lastNumber;
}

function stateOf(raw: unknown, warehouse: InventoryWarehouse): InventoryStockState {
  if (typeof raw !== 'string' || !(WAREHOUSE_STATES[warehouse] as string[]).includes(raw)) {
    throw ApiError.validation(`Trạng thái không hợp lệ cho ${WAREHOUSE_LABELS[warehouse]}.`);
  }
  return raw as InventoryStockState;
}

function quantityOf(raw: unknown, label = 'Số lượng'): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_QUANTITY) {
    throw ApiError.validation(`${label} phải là số nguyên từ 1 đến ${MAX_QUANTITY.toLocaleString('vi-VN')}.`);
  }
  return raw;
}

function countOf(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_QUANTITY) {
    throw ApiError.validation('Số đếm thực tế phải là số nguyên không âm.');
  }
  return raw;
}

function textOf(raw: unknown, max: number, label: string): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length > max) throw ApiError.validation(`${label} quá dài.`);
  return value || null;
}

function requestIdOf(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(raw)) throw ApiError.validation('Thiếu mã yêu cầu.');
  return raw;
}

/** Writes are the Quản lý buồng phòng's — on its own branch. */
async function managerBranch(actor: HousekeepingActor, client: PrismaClient) {
  if (actor.role !== 'HOUSEKEEPING_MANAGER') throw ApiError.forbidden('Chỉ Quản lý buồng phòng mới thao tác kho của chi nhánh.');
  return managedBranch(actor, undefined, client);
}

/** Lines naming items of THIS branch and warehouse, each once, active. */
async function lineItems(client: PrismaClient | Prisma.TransactionClient, branchId: number, warehouse: InventoryWarehouse, ids: unknown[]) {
  if (ids.length === 0) throw ApiError.validation('Vui lòng thêm ít nhất một mặt hàng.');
  if (ids.length > MAX_LINES) throw ApiError.validation(`Tối đa ${MAX_LINES} dòng.`);
  if (ids.some((id) => typeof id !== 'string')) throw ApiError.validation('Mặt hàng không hợp lệ.');
  const items = await client.inventoryItem.findMany({
    where: { id: { in: ids as string[] } },
    select: { id: true, branchId: true, warehouse: true, name: true, variant: true, unit: true, archivedAt: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  return (ids as string[]).map((id) => {
    const item = byId.get(id);
    if (!item || item.branchId !== branchId) throw ApiError.validation('Mặt hàng không thuộc kho của chi nhánh.');
    if (item.warehouse !== warehouse) throw ApiError.validation(`${itemLabel(item)} không thuộc ${WAREHOUSE_LABELS[warehouse]}.`);
    if (item.archivedAt) throw ApiError.validation(`${itemLabel(item)} đã ngừng sử dụng.`);
    return item;
  });
}

/** Lines are each item once — a second line for the same item is refused, never merged silently. */
function assertDistinct(keys: string[], labelOf: (i: number) => string): void {
  const seen = new Set<string>();
  keys.forEach((k, i) => {
    if (seen.has(k)) throw ApiError.validation(`${labelOf(i)} xuất hiện hai lần — gộp thành một dòng.`);
    seen.add(k);
  });
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/* ------------------------------------------------------------------ *
 * Items
 * ------------------------------------------------------------------ */

const ITEM_SELECT = {
  id: true,
  branchId: true,
  warehouse: true,
  name: true,
  variant: true,
  code: true,
  scope: true,
  unit: true,
  catalogKey: true,
  lowStockThreshold: true,
  note: true,
  cleaningOrder: true,
  archivedAt: true,
  createdAt: true,
  branch: { select: { id: true, address: true, branchNumber: true } },
  balances: { select: { state: true, quantity: true } },
  _count: { select: { damageReports: { where: { status: 'PENDING' as const } }, movements: true, countLines: true } },
} satisfies Prisma.InventoryItemSelect;

type ItemRow = Prisma.InventoryItemGetPayload<{ select: typeof ITEM_SELECT }>;

function serializeItem(r: ItemRow) {
  const balances = Object.fromEntries(WAREHOUSE_STATES[r.warehouse].map((s) => [s, r.balances.find((b) => b.state === s)?.quantity ?? 0])) as Record<
    InventoryStockState,
    number
  >;
  return {
    id: r.id,
    branch: r.branch,
    warehouse: r.warehouse,
    name: r.name,
    variant: r.variant,
    label: itemLabel(r),
    code: r.code,
    /** SYSTEM: the Admin's shared catalog ("Danh mục dùng chung toàn hệ thống"); BRANCH: this branch's own ("Mặt hàng riêng chi nhánh"). */
    scope: r.scope,
    unit: r.unit,
    catalogKey: r.catalogKey,
    lowStockThreshold: r.lowStockThreshold,
    // "Sắp hết" only where a threshold was configured.
    lowStock: r.lowStockThreshold !== null && !r.archivedAt && balances.AVAILABLE <= r.lowStockThreshold,
    note: r.note,
    archived: r.archivedAt !== null,
    balances,
    /**
     * A balance in a state the warehouse no longer keeps (dirty linen, issued
     * equipment) — kept, never folded into Sẵn dùng, shown for review.
     */
    legacyBalances: r.balances.filter((b) => b.quantity !== 0 && !WAREHOUSE_STATES[r.warehouse].includes(b.state)).map((b) => ({ state: b.state, stateLabel: STATE_LABELS[b.state], quantity: b.quantity })),
    /** In the legacy warehouse: waits to be classified into one of the four. */
    unclassified: r.warehouse === LEGACY_WAREHOUSE,
    /** In the branch's "Dọn phòng" list, at this position; null: not in it. */
    cleaningOrder: r.cleaningOrder,
    pendingDamage: r._count.damageReports,
    // Its stock was set up: counted ("Khai báo tồn đầu kỳ", "Kiểm kho") or moved at least once.
    opened: r._count.movements > 0 || r._count.countLines > 0,
  };
}

/** The warehouses' items and balances — one branch (the manager's own, or the Admin's choice) or, for the Admin, all. */
export async function listItems(
  actor: HousekeepingActor,
  query: { branchId?: number; warehouse?: unknown; includeArchived?: boolean },
  client: PrismaClient = defaultPrisma,
) {
  const where: Prisma.InventoryItemWhereInput = {
    ...managerBranchWhere(actor, actor.role === 'HOUSEKEEPING_MANAGER' ? (actor.branchId ?? -1) : query.branchId),
    ...(query.warehouse ? { warehouse: warehouseOf(query.warehouse) } : {}),
    ...(query.includeArchived ? {} : { archivedAt: null }),
  };
  const rows = await client.inventoryItem.findMany({
    where,
    select: ITEM_SELECT,
    orderBy: [{ branchId: 'asc' }, { warehouse: 'asc' }, { name: 'asc' }, { variant: 'asc' }],
  });
  return rows.map(serializeItem);
}

export interface ItemInput {
  warehouse: unknown;
  name: unknown;
  variant?: unknown;
  code?: unknown;
  unit: unknown;
  lowStockThreshold?: unknown;
  note?: unknown;
}

function thresholdOf(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_QUANTITY) throw ApiError.validation('Ngưỡng sắp hết không hợp lệ.');
  return raw;
}

/** "Thêm mặt hàng" — one item (the same path as several). */
export async function createItem(actor: HousekeepingActor, input: ItemInput, client: PrismaClient = defaultPrisma) {
  return (await createItems(actor, { warehouse: input.warehouse, items: [input] }, client))[0]!;
}

/** Most new items one "Thêm mặt hàng" may save together. */
export const MAX_NEW_ITEMS = 50;

/**
 * "THÊM MẶT HÀNG" — one or several new items of one of the four warehouses,
 * named, ALL OR NONE: one transaction, so a refused row (a name already in use)
 * leaves none of the others saved. Each gets the warehouse's next code ("3.016")
 * from the server — never typed, never reused. Unit "cái" unless given;
 * balances start at zero (stock comes with "Nhập kho" or a count).
 */
export async function createItems(
  actor: HousekeepingActor,
  input: { warehouse: unknown; items: unknown },
  client: PrismaClient = defaultPrisma,
) {
  if (actor.role === 'ADMIN') return createSharedItems(actor, input, client);
  const branch = await managerBranch(actor, client);
  const warehouse = activeWarehouseOf(input.warehouse);
  const raw = Array.isArray(input.items) ? (input.items as ItemInput[]) : [];
  if (raw.length === 0) throw ApiError.validation('Vui lòng nhập ít nhất một mặt hàng.');
  if (raw.length > MAX_NEW_ITEMS) throw ApiError.validation(`Tối đa ${MAX_NEW_ITEMS} mặt hàng mỗi lần.`);
  const rows = raw.map((r, i) => {
    const name = textOf(r.name, 200, 'Tên mặt hàng');
    if (!name) throw ApiError.validation(`Dòng ${i + 1}: vui lòng nhập tên mặt hàng.`);
    return {
      branchId: branch.id,
      warehouse,
      name,
      variant: textOf(r.variant, 50, 'Kích cỡ / loại') ?? '',
      unit: textOf(r.unit, 30, 'Đơn vị') ?? 'cái',
      lowStockThreshold: thresholdOf(r.lowStockThreshold),
      note: textOf(r.note, 500, 'Ghi chú'),
      createdByUserId: actor.id,
      createdByNameSnapshot: actor.fullName,
    };
  });
  const fold = (v: string) => v.normalize('NFC').toLocaleLowerCase('vi');
  assertDistinct(rows.map((r) => `${fold(r.name)}|${fold(r.variant)}`), (i) => itemLabel(rows[i]!));
  try {
    const created = await client.$transaction(async (tx) => {
      const out = [];
      for (const data of rows) {
        const code = itemCode(warehouse, await nextCodeNumber(tx, warehouse));
        out.push(await tx.inventoryItem.create({ data: { ...data, code, scope: 'BRANCH' }, select: ITEM_SELECT }));
      }
      return out;
    });
    return created.map(serializeItem);
  } catch (e) {
    if (isUniqueViolation(e)) throw ApiError.conflict('Kho đã có mặt hàng cùng tên đang dùng — không mặt hàng nào được lưu.');
    throw e;
  }
}

/**
 * "DANH MỤC DÙNG CHUNG TOÀN HỆ THỐNG" — the Admin's items, by name, all or none:
 * each gets ONE code and one row in every active branch (scope SYSTEM), so all
 * eight can receive, count and use it. No stock is created: every branch's
 * balance starts at nothing until it receives its own. A branch that already
 * has an active item of that name in that warehouse refuses the whole save —
 * names are never merged.
 */
async function createSharedItems(actor: HousekeepingActor, input: { warehouse: unknown; items: unknown }, client: PrismaClient) {
  const warehouse = activeWarehouseOf(input.warehouse);
  const raw = Array.isArray(input.items) ? (input.items as ItemInput[]) : [];
  if (raw.length === 0) throw ApiError.validation('Vui lòng nhập ít nhất một mặt hàng.');
  const names = newItemNames(raw);
  await assertNamesFree(client, warehouse, names, 'ALL');
  const branches = await activeBranchIds(client);
  try {
    const firstRows = await client.$transaction(async (tx) => {
      const created = await insertSharedItems(tx, actor, warehouse, names, branches);
      return names.map((n) => created.get(n)!.get(branches[0]!)!.id);
    });
    const rows = await client.inventoryItem.findMany({ where: { id: { in: firstRows } }, select: ITEM_SELECT });
    return firstRows.map((id) => serializeItem(rows.find((r) => r.id === id)!));
  } catch (e) {
    if (isUniqueViolation(e)) throw ApiError.conflict('Một chi nhánh đã có mặt hàng cùng tên đang dùng — không mặt hàng nào được lưu.');
    throw e;
  }
}

/**
 * Edits what does not change the stock's meaning: unit, threshold, note. The
 * code is the server's and never edited. An item still in the legacy warehouse
 * may be CLASSIFIED once into one of the four (`warehouse`): it keeps its id,
 * balances and history, and gets that warehouse's next code.
 */
export async function updateItem(
  actor: HousekeepingActor,
  id: string,
  input: { unit?: unknown; lowStockThreshold?: unknown; note?: unknown; warehouse?: unknown },
  client: PrismaClient = defaultPrisma,
) {
  const branch = await managerBranch(actor, client);
  const item = await client.inventoryItem.findUnique({ where: { id }, select: { branchId: true, archivedAt: true, warehouse: true, scope: true, unit: true } });
  if (!item || item.branchId !== branch.id) throw ApiError.notFound('Không tìm thấy mặt hàng.');
  if (item.archivedAt) throw ApiError.conflict('Mặt hàng đã ngừng sử dụng.');
  // A shared item is the Admin's: its name, code and unit are the same everywhere; the branch keeps its own threshold and note.
  if (item.scope === 'SYSTEM' && (input.warehouse !== undefined || (input.unit !== undefined && textOf(input.unit, 30, 'Đơn vị') !== item.unit))) {
    throw ApiError.forbidden('Mặt hàng dùng chung do Admin quản lý — chỉ sửa được ngưỡng sắp hết và ghi chú.');
  }
  if (input.warehouse !== undefined) {
    const target = activeWarehouseOf(input.warehouse);
    if (item.warehouse !== LEGACY_WAREHOUSE) throw ApiError.conflict('Chỉ mặt hàng chưa phân loại mới được xếp vào kho.');
    // A quantity "đang sử dụng" has no place in the four warehouses: count it first.
    const issued = await client.inventoryBalance.findUnique({ where: { itemId_state: { itemId: id, state: 'ISSUED' } }, select: { quantity: true } });
    if ((issued?.quantity ?? 0) > 0) throw ApiError.conflict('Mặt hàng còn số lượng "Đang sử dụng" — kiểm kho đưa về 0 trước khi phân loại.');
    const moved = await client.$transaction(async (tx) => {
      const code = itemCode(target, await nextCodeNumber(tx, target));
      const { count } = await tx.inventoryItem.updateMany({ where: { id, warehouse: LEGACY_WAREHOUSE, archivedAt: null }, data: { warehouse: target, code } });
      if (count === 0) throw ApiError.conflict('Mặt hàng vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
      return tx.inventoryItem.findUniqueOrThrow({ where: { id }, select: ITEM_SELECT });
    });
    return serializeItem(moved);
  }
  const data: Prisma.InventoryItemUpdateInput = {};
  if (input.unit !== undefined) {
    const unit = textOf(input.unit, 30, 'Đơn vị');
    if (!unit) throw ApiError.validation('Vui lòng nhập đơn vị tính.');
    data.unit = unit;
  }
  if (input.lowStockThreshold !== undefined) data.lowStockThreshold = thresholdOf(input.lowStockThreshold);
  if (input.note !== undefined) data.note = textOf(input.note, 500, 'Ghi chú');
  try {
    return serializeItem(await client.inventoryItem.update({ where: { id }, data, select: ITEM_SELECT }));
  } catch (e) {
    if (isUniqueViolation(e)) throw ApiError.conflict('Mặt hàng vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
    throw e;
  }
}

/**
 * "Xóa" — an item never used is removed; one with any stock history is only
 * archived ("Ngừng sử dụng"): its movements, receipts and counts stay.
 */
export async function removeItem(actor: HousekeepingActor, id: string, client: PrismaClient = defaultPrisma) {
  if (actor.role === 'ADMIN') return removeSharedItem(id, client);
  const branch = await managerBranch(actor, client);
  const item = await client.inventoryItem.findUnique({
    where: { id },
    select: {
      branchId: true,
      archivedAt: true,
      scope: true,
      _count: { select: { movements: true, receiptLines: true, countLines: true, transferLines: true, damageReports: true } },
    },
  });
  if (!item || item.branchId !== branch.id) throw ApiError.notFound('Không tìm thấy mặt hàng.');
  if (item.scope === 'SYSTEM') throw ApiError.forbidden('Mặt hàng dùng chung do Admin quản lý — chi nhánh không xóa được.');
  const used = Object.values(item._count).some((n) => n > 0);
  if (!used) {
    await client.inventoryItem.delete({ where: { id } });
    return { removed: true, archived: false };
  }
  if (!item.archivedAt) await client.inventoryItem.update({ where: { id }, data: { archivedAt: new Date() } });
  return { removed: false, archived: true };
}

/**
 * The Admin removes a SHARED item: in every branch, the row never used is
 * removed and the row with any history only archived ("Ngừng sử dụng").
 */
async function removeSharedItem(id: string, client: PrismaClient) {
  const item = await client.inventoryItem.findUnique({ where: { id }, select: { scope: true, warehouse: true, code: true } });
  if (!item || item.scope !== 'SYSTEM' || !item.code) throw ApiError.notFound('Không tìm thấy mặt hàng dùng chung.');
  const rows = await client.inventoryItem.findMany({
    where: { scope: 'SYSTEM', warehouse: item.warehouse, code: item.code },
    select: { id: true, archivedAt: true, _count: { select: { movements: true, receiptLines: true, countLines: true, transferLines: true, damageReports: true } } },
  });
  let archived = 0;
  await client.$transaction(async (tx) => {
    for (const row of rows) {
      if (Object.values(row._count).some((n) => n > 0)) {
        archived += 1;
        if (!row.archivedAt) await tx.inventoryItem.update({ where: { id: row.id }, data: { archivedAt: new Date() } });
      } else await tx.inventoryItem.delete({ where: { id: row.id } });
    }
  });
  return { removed: archived === 0, archived: archived > 0 };
}

/* ------------------------------------------------------------------ *
 * "Mặt hàng dùng khi dọn phòng" — the branch's list, chosen from the warehouses
 * ------------------------------------------------------------------ */

const CLEANING_SELECT = {
  id: true,
  branchId: true,
  warehouse: true,
  name: true,
  variant: true,
  unit: true,
  code: true,
  cleaningOrder: true,
  archivedAt: true,
  balances: { where: { state: 'AVAILABLE' as const }, select: { quantity: true } },
} satisfies Prisma.InventoryItemSelect;

/**
 * THE BRANCH'S ROOM-CLEANING LIST for its managers and the Admin: every active
 * item of the four warehouses, with its code, on-hand quantity and, when it is
 * in the list, its position. The Quản lý buồng phòng reads its own branch; the
 * Admin names one.
 */
export async function listCleaningItems(actor: HousekeepingActor, query: { branchId?: unknown }, client: PrismaClient = defaultPrisma) {
  const branch = await managedBranch(actor, actor.role === 'HOUSEKEEPING_MANAGER' ? undefined : query.branchId, client);
  const rows = await client.inventoryItem.findMany({
    where: { branchId: branch.id, archivedAt: null, warehouse: { in: [...WAREHOUSES] } },
    select: CLEANING_SELECT,
    orderBy: [{ warehouse: 'asc' }, { code: 'asc' }],
  });
  return {
    branchId: branch.id,
    items: rows.map((r) => ({
      id: r.id,
      warehouse: r.warehouse,
      warehouseLabel: WAREHOUSE_LABELS[r.warehouse],
      code: r.code,
      label: itemLabel(r),
      unit: r.unit,
      available: r.balances[0]?.quantity ?? 0,
      cleaningOrder: r.cleaningOrder,
    })),
  };
}

/**
 * "LƯU DANH SÁCH" — exactly these items, in this order, are the branch's room
 * cleaning list; every other item of the branch leaves it. Items of the
 * branch's four warehouses only, each once, active. One transaction.
 */
export async function setCleaningItems(actor: HousekeepingActor, input: { branchId?: unknown; itemIds?: unknown }, client: PrismaClient = defaultPrisma) {
  const branch = await managedBranch(actor, actor.role === 'HOUSEKEEPING_MANAGER' ? undefined : input.branchId, client);
  const ids = Array.isArray(input.itemIds) ? input.itemIds : [];
  if (ids.some((i) => typeof i !== 'string')) throw ApiError.validation('Mặt hàng không hợp lệ.');
  if (ids.length > MAX_LINES) throw ApiError.validation(`Tối đa ${MAX_LINES} mặt hàng.`);
  if (new Set(ids).size !== ids.length) throw ApiError.validation('Một mặt hàng chỉ chọn một lần.');
  const found = await client.inventoryItem.findMany({
    where: { id: { in: ids as string[] }, branchId: branch.id, archivedAt: null, warehouse: { in: [...WAREHOUSES] } },
    select: { id: true },
  });
  if (found.length !== ids.length) throw ApiError.validation('Chỉ chọn được mặt hàng đang dùng của bốn kho hàng của chi nhánh.');
  await client.$transaction(async (tx) => {
    await tx.inventoryItem.updateMany({ where: { branchId: branch.id, cleaningOrder: { not: null } }, data: { cleaningOrder: null } });
    for (const [i, id] of (ids as string[]).entries()) await tx.inventoryItem.update({ where: { id }, data: { cleaningOrder: i + 1 } });
  });
  return listCleaningItems(actor, { branchId: branch.id }, client);
}

/**
 * THE ITEMS A ROOM'S CLEANING COUNTS — the branch's list, in its order, with
 * what is on hand. The worker's view: no codes.
 */
export async function cleaningItemsOfBranch(branchId: number, client: PrismaClient | Prisma.TransactionClient = defaultPrisma) {
  const rows = await client.inventoryItem.findMany({
    where: { branchId, archivedAt: null, cleaningOrder: { not: null }, warehouse: { in: [...WAREHOUSES] } },
    select: CLEANING_SELECT,
    orderBy: { cleaningOrder: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, label: itemLabel(r), unit: r.unit, warehouse: r.warehouse, available: r.balances[0]?.quantity ?? 0 }));
}

/** The same list as ledger items, for a completion — refusing anything outside it. */
export async function cleaningLines(tx: Prisma.TransactionClient, branchId: number, quantities: Record<string, number>) {
  const ids = Object.keys(quantities);
  if (ids.length === 0) return [];
  const items = await tx.inventoryItem.findMany({
    where: { id: { in: ids }, branchId, archivedAt: null, cleaningOrder: { not: null }, warehouse: { in: [...WAREHOUSES] } },
    select: { id: true, branchId: true, warehouse: true, name: true, variant: true, unit: true },
  });
  if (items.length !== ids.length) throw ApiError.validation('Có mặt hàng không thuộc danh sách dọn phòng của chi nhánh. Vui lòng tải lại.');
  return items.map((item) => ({ item, quantity: quantities[item.id]! }));
}

/**
 * A NEW ITEM NAMED IN A RECEIPT — created and received in the same save.
 * `quantity` for a manager's receipt; `quantities` (per chosen branch) for
 * the Admin's.
 */
export interface NewReceiptItem {
  name: unknown;
  quantity?: unknown;
  quantities?: { branchId: unknown; quantity: unknown }[];
}

export interface ReceiptInput {
  warehouse: unknown;
  requestId: unknown;
  receivedAt?: unknown;
  reference?: unknown;
  note?: unknown;
  lines?: { itemId: unknown; quantity: unknown; note?: unknown }[];
  newItems?: NewReceiptItem[];
}

const RECEIPT_INCLUDE = {
  lines: { include: { item: { select: { name: true, variant: true, unit: true } } } },
  branch: { select: { id: true, address: true, branchNumber: true } },
} satisfies Prisma.InventoryReceiptInclude;

function serializeReceipt(r: Prisma.InventoryReceiptGetPayload<{ include: typeof RECEIPT_INCLUDE }>) {
  return {
    id: r.id,
    branch: r.branch,
    warehouse: r.warehouse,
    receivedAt: r.receivedAt,
    reference: r.reference,
    note: r.note,
    createdBy: { id: r.createdByUserId, name: r.createdByNameSnapshot },
    createdAt: r.createdAt,
    lines: r.lines.map((l) => ({ itemId: l.itemId, label: itemLabel(l.item), unit: l.item.unit, quantity: l.quantity, note: l.note })),
  };
}

/** What a receipt line and a movement need of an item. */
const LEDGER_SELECT = { id: true, branchId: true, warehouse: true, name: true, variant: true, unit: true, archivedAt: true } as const;
type LedgerRow = Prisma.InventoryItemGetPayload<{ select: typeof LEDGER_SELECT }>;

const foldName = (v: string) => v.normalize('NFC').toLocaleLowerCase('vi');

/** New items' names: each given, each once. */
function newItemNames(raw: { name?: unknown }[]): string[] {
  if (raw.length > MAX_NEW_ITEMS) throw ApiError.validation(`Tối đa ${MAX_NEW_ITEMS} mặt hàng mới mỗi lần.`);
  const names = raw.map((r, i) => {
    const name = textOf(r.name, 200, 'Tên mặt hàng');
    if (!name) throw ApiError.validation(`Mặt hàng mới ${i + 1}: vui lòng nhập tên.`);
    return name;
  });
  assertDistinct(names.map(foldName), (i) => names[i]!);
  return names;
}

/**
 * A NEW NAME THAT IS ALREADY AN ACTIVE ITEM where it would be created refuses
 * the whole save, naming that item (and its id, so the screen can take it
 * instead) — never a second item of the same name, never a silent merge.
 * 'ALL': a shared item, which every active branch would get.
 */
async function assertNamesFree(client: PrismaClient, warehouse: InventoryWarehouse, names: string[], branchIds: number[] | 'ALL') {
  if (names.length === 0) return;
  const taken = await client.inventoryItem.findFirst({
    where: { warehouse, archivedAt: null, variant: '', name: { in: names, mode: 'insensitive' }, ...(branchIds === 'ALL' ? {} : { branchId: { in: branchIds } }) },
    select: { id: true, name: true, code: true, branchId: true, branch: { select: { address: true } } },
  });
  if (taken) {
    throw new ApiError(
      'CONFLICT',
      `${taken.branch.address} đã có “${taken.code ? `${taken.code} ` : ''}${taken.name}” trong kho này — chọn mặt hàng đó thay vì tạo mới. Chưa có gì được lưu.`,
      { existingItemId: taken.id, branchId: taken.branchId, name: taken.name, code: taken.code },
    );
  }
}

const activeBranchIds = async (client: PrismaClient) =>
  (await client.branch.findMany({ where: { active: true }, select: { id: true }, orderBy: { branchNumber: 'asc' } })).map((b) => b.id);

/** The branch's OWN new items (scope BRANCH), coded under the warehouse's one numbering. */
async function insertBranchItems(tx: Prisma.TransactionClient, actor: HousekeepingActor, branchId: number, warehouse: InventoryWarehouse, names: string[]) {
  const out: LedgerRow[] = [];
  for (const name of names) {
    const code = itemCode(warehouse, await nextCodeNumber(tx, warehouse));
    out.push(
      await tx.inventoryItem.create({
        data: { branchId, warehouse, name, variant: '', unit: 'cái', code, scope: 'BRANCH', createdByUserId: actor.id, createdByNameSnapshot: actor.fullName },
        select: LEDGER_SELECT,
      }),
    );
  }
  return out;
}

/**
 * THE ADMIN'S SHARED ITEMS: one code each and one row in every active branch
 * (scope SYSTEM). No stock: a branch receives only what a receipt gives it.
 * name → branch → its row.
 */
async function insertSharedItems(tx: Prisma.TransactionClient, actor: HousekeepingActor, warehouse: InventoryWarehouse, names: string[], branchIds: number[]) {
  const out = new Map<string, Map<number, LedgerRow>>();
  for (const name of names) {
    const code = itemCode(warehouse, await nextCodeNumber(tx, warehouse));
    const rows = new Map<number, LedgerRow>();
    for (const branchId of branchIds) {
      rows.set(
        branchId,
        await tx.inventoryItem.create({
          data: { branchId, warehouse, name, variant: '', unit: 'cái', code, scope: 'SYSTEM', createdByUserId: actor.id, createdByNameSnapshot: actor.fullName },
          select: LEDGER_SELECT,
        }),
      );
    }
    out.set(name, rows);
  }
  return out;
}

function receivedAtOf(raw: unknown, now: Date): Date {
  if (raw === undefined || raw === null || raw === '') return now;
  const at = new Date(String(raw));
  if (Number.isNaN(at.getTime())) throw ApiError.validation('Thời gian nhận hàng không hợp lệ.');
  if (at.getTime() > now.getTime() + 5 * 60_000) throw ApiError.validation('Thời gian nhận hàng không thể ở tương lai.');
  return at;
}

/** One branch's receipt: the header, every line and its movement — inside the caller's transaction. */
async function writeReceipt(
  tx: Prisma.TransactionClient,
  actor: HousekeepingActor,
  head: { branchId: number; warehouse: InventoryWarehouse; requestId: string; receivedAt: Date; reference: string | null; note: string | null; now: Date },
  entries: { item: LedgerRow; quantity: number; note?: string | null }[],
): Promise<string> {
  const receipt = await tx.inventoryReceipt.create({
    data: {
      branchId: head.branchId,
      warehouse: head.warehouse,
      requestId: head.requestId,
      receivedAt: head.receivedAt,
      reference: head.reference,
      note: head.note,
      createdByUserId: actor.id,
      createdByNameSnapshot: actor.fullName,
      createdAt: head.now,
      lines: { create: entries.map((e) => ({ itemId: e.item.id, quantity: e.quantity, note: e.note ?? null })) },
    },
  });
  await applyMovements(
    tx,
    entries.map((e) => ({ item: e.item, state: 'AVAILABLE', delta: e.quantity, type: 'RECEIPT', sourceKey: `RECEIPT:${receipt.id}`, receiptId: receipt.id })),
    actor,
    head.now,
  );
  return receipt.id;
}

/**
 * ONE DELIVERY OF MANY ITEMS — the items ticked, and new ones named with their
 * quantity, created as the branch's own and received in the same save: the new
 * items, the header, every line and every movement, or nothing. Once per request.
 */
export async function createReceipt(actor: HousekeepingActor, input: ReceiptInput, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  const branch = await managerBranch(actor, client);
  const warehouse = activeWarehouseOf(input.warehouse);
  const requestId = requestIdOf(input.requestId);
  const again = await client.inventoryReceipt.findUnique({ where: { requestId }, include: RECEIPT_INCLUDE });
  if (again) return { receipt: serializeReceipt(again), duplicate: true };
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const fresh = Array.isArray(input.newItems) ? input.newItems : [];
  if (lines.length + fresh.length === 0) throw ApiError.validation('Vui lòng chọn ít nhất một mặt hàng.');
  if (lines.length + fresh.length > MAX_LINES) throw ApiError.validation(`Tối đa ${MAX_LINES} dòng.`);
  const items = lines.length > 0 ? await lineItems(client, branch.id, warehouse, lines.map((l) => l.itemId)) : [];
  assertDistinct(items.map((i) => i.id), (i) => itemLabel(items[i]!));
  const quantities = lines.map((l, i) => quantityOf(l.quantity, `Số lượng của ${itemLabel(items[i]!)}`));
  const names = newItemNames(fresh);
  const freshQuantities = fresh.map((f, i) => quantityOf(f.quantity, `Số lượng của ${names[i]}`));
  await assertNamesFree(client, warehouse, names, [branch.id]);
  const now = clock.now();
  const receivedAt = receivedAtOf(input.receivedAt, now);
  try {
    const id = await client.$transaction(async (tx) => {
      const created = await insertBranchItems(tx, actor, branch.id, warehouse, names);
      return writeReceipt(
        tx,
        actor,
        { branchId: branch.id, warehouse, requestId, receivedAt, reference: textOf(input.reference, 100, 'Số phiếu / tham chiếu'), note: textOf(input.note, 1000, 'Ghi chú'), now },
        [
          ...items.map((item, i) => ({ item, quantity: quantities[i]!, note: textOf(lines[i]!.note, 300, 'Ghi chú dòng') })),
          ...created.map((item, i) => ({ item, quantity: freshQuantities[i]! })),
        ],
      );
    });
    return { receipt: serializeReceipt(await client.inventoryReceipt.findUniqueOrThrow({ where: { id }, include: RECEIPT_INCLUDE })), duplicate: false };
  } catch (e) {
    // The same request racing itself: the first one's receipt is the answer.
    if (isUniqueViolation(e)) {
      const first = await client.inventoryReceipt.findUnique({ where: { requestId }, include: RECEIPT_INCLUDE });
      if (first) return { receipt: serializeReceipt(first), duplicate: true };
      throw ApiError.conflict('Một mặt hàng cùng tên vừa được tạo ở nơi khác — tải lại rồi chọn mặt hàng đó. Chưa có gì được lưu.');
    }
    throw e;
  }
}

export interface MultiReceiptInput {
  warehouse: unknown;
  requestId: unknown;
  receivedAt?: unknown;
  reference?: unknown;
  note?: unknown;
  branches: { branchId: unknown; lines?: { itemId: unknown; quantity: unknown; note?: unknown }[] }[];
  newItems?: NewReceiptItem[];
}

/**
 * THE ADMIN'S "NHẬP KHO" FOR SEVERAL BRANCHES — each chosen branch with ITS OWN
 * items and quantities (never one figure copied to all), one receipt per branch
 * under the same reference, all or none, once per request. A new item named
 * here joins the SHARED catalog (every active branch gets its row) and only the
 * branches given a quantity receive it.
 */
export async function createMultiBranchReceipt(actor: HousekeepingActor, input: MultiReceiptInput, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  if (actor.role !== 'ADMIN') throw ApiError.forbidden('Chỉ Admin nhập kho cho nhiều chi nhánh.');
  const warehouse = activeWarehouseOf(input.warehouse);
  const requestId = requestIdOf(input.requestId);
  const targets = Array.isArray(input.branches) ? input.branches : [];
  if (targets.length === 0) throw ApiError.validation('Vui lòng chọn ít nhất một chi nhánh.');
  const keyOf = (branchId: number) => `${requestId}-${branchId}`;
  // Each branch checked as its own receipt would be: in scope, its own items of this warehouse, each once.
  const plan = async (t: MultiReceiptInput['branches'][number]) => {
    const branch = await managedBranch(actor, t.branchId, client);
    const lines = Array.isArray(t.lines) ? t.lines : [];
    const items = lines.length > 0 ? await lineItems(client, branch.id, warehouse, lines.map((l) => l.itemId)) : [];
    assertDistinct(items.map((i) => i.id), (i) => itemLabel(items[i]!));
    const quantities = lines.map((l, i) => quantityOf(l.quantity, `Số lượng của ${itemLabel(items[i]!)}`));
    return { branch, lines, items, quantities };
  };
  const plans: Awaited<ReturnType<typeof plan>>[] = [];
  for (const t of targets) plans.push(await plan(t));
  assertDistinct(plans.map((p) => String(p.branch.id)), (i) => `Chi nhánh #${plans[i]!.branch.id}`);
  // A retry is answered before anything else: its new names now exist.
  const again = await client.inventoryReceipt.findMany({ where: { requestId: { in: plans.map((p) => keyOf(p.branch.id)) } }, include: RECEIPT_INCLUDE });
  if (again.length > 0) return { receipts: again.map(serializeReceipt), duplicate: true };
  // New items: each with a quantity for at least one chosen branch, and only for chosen branches.
  const fresh = Array.isArray(input.newItems) ? input.newItems : [];
  const names = newItemNames(fresh);
  const chosen = new Set(plans.map((p) => p.branch.id));
  const freshQuantities = fresh.map((f, i) => {
    const per = Array.isArray(f.quantities) ? f.quantities : [];
    const map = new Map<number, number>();
    for (const q of per) {
      const branchId = Number(q.branchId);
      if (!chosen.has(branchId)) throw ApiError.validation(`${names[i]}: chi nhánh nhận hàng chưa được chọn.`);
      if (map.has(branchId)) throw ApiError.validation(`${names[i]}: một chi nhánh chỉ một số lượng.`);
      map.set(branchId, quantityOf(q.quantity, `Số lượng của ${names[i]}`));
    }
    if (map.size === 0) throw ApiError.validation(`${names[i]}: nhập số lượng cho ít nhất một chi nhánh.`);
    return map;
  });
  for (const p of plans) {
    if (p.lines.length === 0 && !freshQuantities.some((m) => m.has(p.branch.id))) {
      throw ApiError.validation('Mỗi chi nhánh được chọn cần ít nhất một mặt hàng nhập.');
    }
  }
  await assertNamesFree(client, warehouse, names, 'ALL');
  const now = clock.now();
  const receivedAt = receivedAtOf(input.receivedAt, now);
  const reference = textOf(input.reference, 100, 'Số phiếu / tham chiếu');
  const note = textOf(input.note, 1000, 'Ghi chú');
  const everyBranch = names.length > 0 ? await activeBranchIds(client) : [];
  try {
    const ids = await client.$transaction(async (tx) => {
      const shared = await insertSharedItems(tx, actor, warehouse, names, everyBranch);
      const out: string[] = [];
      for (const p of plans) {
        const entries = [
          ...p.items.map((item, i) => ({ item, quantity: p.quantities[i]!, note: textOf(p.lines[i]!.note, 300, 'Ghi chú dòng') })),
          ...names.flatMap((name, i) => {
            const quantity = freshQuantities[i]!.get(p.branch.id);
            return quantity === undefined ? [] : [{ item: shared.get(name)!.get(p.branch.id)!, quantity }];
          }),
        ];
        out.push(await writeReceipt(tx, actor, { branchId: p.branch.id, warehouse, requestId: keyOf(p.branch.id), receivedAt, reference, note, now }, entries));
      }
      return out;
    });
    const rows = await client.inventoryReceipt.findMany({ where: { id: { in: ids } }, include: RECEIPT_INCLUDE });
    return { receipts: rows.map(serializeReceipt), duplicate: false };
  } catch (e) {
    if (isUniqueViolation(e)) {
      const first = await client.inventoryReceipt.findMany({ where: { requestId: { in: plans.map((p) => keyOf(p.branch.id)) } }, include: RECEIPT_INCLUDE });
      if (first.length > 0) return { receipts: first.map(serializeReceipt), duplicate: true };
      throw ApiError.conflict('Một mặt hàng cùng tên vừa được tạo ở nơi khác — tải lại rồi chọn mặt hàng đó. Chưa có gì được lưu.');
    }
    throw e;
  }
}

export async function listReceipts(actor: HousekeepingActor, query: { branchId?: number; warehouse?: unknown }, client: PrismaClient = defaultPrisma) {
  const rows = await client.inventoryReceipt.findMany({
    where: {
      ...managerBranchWhere(actor, actor.role === 'HOUSEKEEPING_MANAGER' ? (actor.branchId ?? -1) : query.branchId),
      ...(query.warehouse ? { warehouse: warehouseOf(query.warehouse) } : {}),
    },
    include: RECEIPT_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return rows.map(serializeReceipt);
}

/* ------------------------------------------------------------------ *
 * "Kiểm kho" — the physical count
 * ------------------------------------------------------------------ */

export interface CountInput {
  branchId?: unknown;
  warehouse: unknown;
  requestId: unknown;
  /** "Khai báo tồn đầu kỳ": the first count of items with no stock history yet. */
  opening?: unknown;
  note?: unknown;
  lines: { itemId: unknown; state: unknown; systemQuantity: unknown; countedQuantity: unknown; reason?: unknown }[];
}

const COUNT_INCLUDE = {
  lines: { include: { item: { select: { name: true, variant: true, unit: true } } } },
  branch: { select: { id: true, address: true, branchNumber: true } },
} satisfies Prisma.InventoryCountInclude;

/**
 * WHO SEES THE RECONCILIATION: the Admin — the book quantity the count was set
 * against and the difference. A Quản lý buồng phòng counts BLIND: its counts
 * come back with what was counted and why, and nothing else.
 */
export function seesReconciliation(actor: HousekeepingActor): boolean {
  return actor.role === 'ADMIN';
}

function serializeCount(r: Prisma.InventoryCountGetPayload<{ include: typeof COUNT_INCLUDE }>, full: boolean) {
  return {
    id: r.id,
    opening: r.opening,
    branch: r.branch,
    warehouse: r.warehouse,
    note: r.note,
    createdBy: { id: r.createdByUserId, name: r.createdByNameSnapshot, role: r.createdByRole },
    createdAt: r.createdAt,
    lines: r.lines.map((l) => ({
      itemId: l.itemId,
      label: itemLabel(l.item),
      unit: l.item.unit,
      state: l.state,
      stateLabel: STATE_LABELS[l.state],
      countedQuantity: l.countedQuantity,
      reason: l.reason,
      ...(full ? { systemQuantity: l.systemQuantity, difference: l.difference } : {}),
    })),
  };
}

/**
 * Sets each counted balance to what was physically counted — by an adjusting
 * MOVEMENT, never by overwriting. The recorded quantity the counter saw must
 * still be the recorded quantity (locked while the count is saved): stock that
 * moved meanwhile asks for a recount instead of being silently overwritten.
 */
export async function createCount(actor: HousekeepingActor, input: CountInput, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  const branch = await managedBranch(actor, actor.role === 'HOUSEKEEPING_MANAGER' ? undefined : input.branchId, client);
  const warehouse = warehouseOf(input.warehouse);
  const requestId = requestIdOf(input.requestId);
  const full = seesReconciliation(actor);
  const again = await client.inventoryCount.findUnique({ where: { requestId }, include: COUNT_INCLUDE });
  if (again) return { count: serializeCount(again, full), duplicate: true };
  const opening = input.opening === true;
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const items = await lineItems(client, branch.id, warehouse, lines.map((l) => l.itemId));
  const parsed = lines.map((l, i) => {
    const item = items[i]!;
    const state = stateOf(l.state, warehouse);
    // A blind count sends no book quantity: the server reads it, under lock, below.
    const systemQuantity = full ? countOf(l.systemQuantity) : null;
    const countedQuantity = countOf(l.countedQuantity);
    if (opening && systemQuantity !== null && systemQuantity !== 0) throw ApiError.validation(`${itemLabel(item)} đã có số tồn — dùng “Kiểm kho” để điều chỉnh.`);
    // The opening count's difference IS the opening balance: its reason says so.
    const reason = textOf(l.reason, 500, 'Lý do chênh lệch') ?? (opening ? 'Tồn đầu kỳ (đếm thực tế)' : null);
    return { item, state, systemQuantity, countedQuantity, difference: 0, reason };
  });
  assertDistinct(parsed.map((p) => `${p.item.id}:${p.state}`), (i) => `${itemLabel(parsed[i]!.item)} (${STATE_LABELS[parsed[i]!.state].toLowerCase()})`);
  const now = clock.now();
  try {
    const id = await client.$transaction(async (tx) => {
      if (opening) {
        // ONCE per item: the items are locked, then must have no history at all —
        // two openings racing for one item: the second finds the first's lines.
        const ids = [...new Set(parsed.map((p) => p.item.id))].sort();
        await tx.$queryRaw`SELECT "id" FROM "InventoryItem" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
        const used = await tx.inventoryItem.findMany({
          where: { id: { in: ids }, OR: [{ movements: { some: {} } }, { countLines: { some: {} } }] },
          select: { name: true, variant: true },
        });
        if (used.length > 0) {
          throw ApiError.conflict(`${used.map(itemLabel).join(', ')} đã có tồn đầu kỳ hoặc đã phát sinh — dùng “Kiểm kho” để điều chỉnh.`);
        }
      }
      for (const p of parsed) {
        const locked = await tx.$queryRaw<{ quantity: number }[]>`
          SELECT "quantity" FROM "InventoryBalance" WHERE "itemId" = ${p.item.id} AND "state" = ${p.state}::"InventoryStockState" FOR UPDATE`;
        const current = locked[0]?.quantity ?? 0;
        // The Admin saw a book quantity: it must still be the book's. A blind count takes the book's as it stands now.
        if (p.systemQuantity !== null && current !== p.systemQuantity) {
          throw ApiError.conflict(`Số tồn của ${itemLabel(p.item)} vừa thay đổi (nay là ${current}). Tải lại rồi kiểm lại dòng này.`);
        }
        if (opening && current !== 0) throw ApiError.validation(`${itemLabel(p.item)} đã có số tồn — dùng “Kiểm kho” để điều chỉnh.`);
        p.systemQuantity = current;
        p.difference = p.countedQuantity - current;
        // The reason is asked for every line that differs — a blind count is told which, never by how much.
        if (p.difference !== 0 && !p.reason) {
          throw ApiError.validation(
            full
              ? `Vui lòng nhập lý do chênh lệch cho ${itemLabel(p.item)} (${STATE_LABELS[p.state].toLowerCase()}).`
              : `Số đếm của ${itemLabel(p.item)} (${STATE_LABELS[p.state].toLowerCase()}) khác sổ sách — vui lòng ghi lý do cho dòng này.`,
          );
        }
      }
      const count = await tx.inventoryCount.create({
        data: {
          branchId: branch.id,
          warehouse,
          requestId,
          opening,
          note: textOf(input.note, 1000, 'Ghi chú') ?? (opening ? 'Khai báo tồn đầu kỳ' : null),
          createdByUserId: actor.id,
          createdByNameSnapshot: actor.fullName,
          createdByRole: actor.role,
          createdAt: now,
          lines: {
            create: parsed.map((p) => ({
              itemId: p.item.id,
              state: p.state,
              systemQuantity: p.systemQuantity!,
              countedQuantity: p.countedQuantity,
              difference: p.difference,
              reason: p.reason,
            })),
          },
        },
      });
      const moves: MoveInput[] = parsed
        .filter((p) => p.difference !== 0)
        .map((p) => ({
          item: p.item,
          state: p.state,
          delta: p.difference,
          type: 'COUNT_ADJUSTMENT',
          sourceKey: `COUNT:${count.id}`,
          countId: count.id,
          reason: p.reason,
        }));
      await applyMovements(tx, moves, actor, now);
      return count.id;
    });
    return { count: serializeCount(await client.inventoryCount.findUniqueOrThrow({ where: { id }, include: COUNT_INCLUDE }), full), duplicate: false };
  } catch (e) {
    if (isUniqueViolation(e)) {
      const first = await client.inventoryCount.findUnique({ where: { requestId }, include: COUNT_INCLUDE });
      if (first) return { count: serializeCount(first, full), duplicate: true };
    }
    throw e;
  }
}

/** The counts — and their discrepancies — newest first. */
export async function listCounts(
  actor: HousekeepingActor,
  query: { branchId?: number; warehouse?: unknown; onlyDifferences?: boolean },
  client: PrismaClient = defaultPrisma,
) {
  const full = seesReconciliation(actor);
  const rows = await client.inventoryCount.findMany({
    where: {
      ...managerBranchWhere(actor, actor.role === 'HOUSEKEEPING_MANAGER' ? (actor.branchId ?? -1) : query.branchId),
      ...(query.warehouse ? { warehouse: warehouseOf(query.warehouse) } : {}),
      // "Only the differences" is itself the reconciliation — the Admin's question.
      ...(query.onlyDifferences && full ? { lines: { some: { difference: { not: 0 } } } } : {}),
    },
    include: COUNT_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return rows.map((r) => serializeCount(r, full));
}

/* ------------------------------------------------------------------ *
 * Laundry and equipment — moves between states
 * ------------------------------------------------------------------ */

/**
 * The moves in use: equipment out and back. The laundry moves ("Gửi giặt",
 * "Giặt xong") are no longer offered — clean linen enters by "Nhập kho" and
 * dirty linen is never turned clean by the system; their past movements stay.
 */
const TRANSFERS: Partial<Record<InventoryTransferKind, { warehouse: InventoryWarehouse; from: InventoryStockState; to: InventoryStockState; label: string }>> = {
  STOCK_ISSUE: { warehouse: 'EQUIPMENT', from: 'AVAILABLE', to: 'ISSUED', label: 'Xuất dùng' },
  STOCK_RETURN: { warehouse: 'EQUIPMENT', from: 'ISSUED', to: 'AVAILABLE', label: 'Thu hồi' },
};
const TRANSFER_MOVES: Record<InventoryTransferKind, 'LAUNDRY_SENT' | 'LAUNDRY_RETURNED' | 'STOCK_ISSUED' | 'STOCK_RETURNED'> = {
  LAUNDRY_SEND: 'LAUNDRY_SENT',
  LAUNDRY_RETURN: 'LAUNDRY_RETURNED',
  STOCK_ISSUE: 'STOCK_ISSUED',
  STOCK_RETURN: 'STOCK_RETURNED',
};

export interface TransferInput {
  kind: unknown;
  requestId: unknown;
  note?: unknown;
  lines: { itemId: unknown; quantity: unknown }[];
}

/**
 * "Giặt xong" (bẩn → sẵn dùng), and an
 * equipment "Xuất dùng" / "Thu hồi": the SAME pieces change state — never new
 * stock. Each line is a pair of movements under one source.
 */
export async function createTransfer(actor: HousekeepingActor, input: TransferInput, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  const branch = await managerBranch(actor, client);
  if (typeof input.kind !== 'string' || !(input.kind in TRANSFERS)) throw ApiError.validation('Loại chuyển kho không hợp lệ.');
  const kind = input.kind as InventoryTransferKind;
  const rule = TRANSFERS[kind]!;
  const requestId = requestIdOf(input.requestId);
  const again = await client.inventoryTransfer.findUnique({ where: { requestId }, select: { id: true } });
  if (again) return { id: again.id, duplicate: true };
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const items = await lineItems(client, branch.id, rule.warehouse, lines.map((l) => l.itemId));
  assertDistinct(items.map((i) => i.id), (i) => itemLabel(items[i]!));
  const quantities = lines.map((l, i) => quantityOf(l.quantity, `Số lượng của ${itemLabel(items[i]!)}`));
  const now = clock.now();
  try {
    const id = await client.$transaction(async (tx) => {
      const transfer = await tx.inventoryTransfer.create({
        data: {
          branchId: branch.id,
          warehouse: rule.warehouse,
          kind,
          requestId,
          note: textOf(input.note, 1000, 'Ghi chú'),
          createdByUserId: actor.id,
          createdByNameSnapshot: actor.fullName,
          createdAt: now,
          lines: { create: items.map((item, i) => ({ itemId: item.id, quantity: quantities[i]! })) },
        },
      });
      const common = { type: TRANSFER_MOVES[kind], sourceKey: `TRANSFER:${transfer.id}`, transferId: transfer.id } as const;
      await applyMovements(
        tx,
        items.flatMap((item, i) => [
          { item, state: rule.from, delta: -quantities[i]!, ...common },
          { item, state: rule.to, delta: quantities[i]!, ...common },
        ]),
        actor,
        now,
      );
      return transfer.id;
    });
    return { id, duplicate: false };
  } catch (e) {
    if (isUniqueViolation(e)) {
      const first = await client.inventoryTransfer.findUnique({ where: { requestId }, select: { id: true } });
      if (first) return { id: first.id, duplicate: true };
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * "Báo hỏng / Không thể tái sử dụng"
 * ------------------------------------------------------------------ */

export interface DamageInput {
  itemId: unknown;
  quantity: unknown;
  fromState: unknown;
  reason: unknown;
  roomNumber?: unknown;
  /** The housekeeping work item it came from — this branch's, this room's. */
  taskId?: unknown;
  /** The technical incident it relates to — this branch's. */
  issueId?: unknown;
  requestId: unknown;
}

const TASK_SOURCE_SELECT = {
  id: true,
  roomNumber: true,
  workDate: true,
  cycleNumber: true,
  workGroup: { select: { number: true } },
} satisfies Prisma.HousekeepingRoomTaskSelect;

const ISSUE_SOURCE_SELECT = {
  id: true,
  description: true,
  status: true,
  createdAt: true,
  areaCategory: true,
  roomNumber: true,
  floorNumber: true,
  areaSubtype: true,
  locationDetail: true,
} satisfies Prisma.HotelIssueSelect;

const dayLabel = (iso: string) => iso.split('-').reverse().join('/');

/** "Phòng 102 · 20/10/2026 · Công việc 3 (lần 2)". */
function taskSource(t: Prisma.HousekeepingRoomTaskGetPayload<{ select: typeof TASK_SOURCE_SELECT }>) {
  const label = [`Phòng ${t.roomNumber}`, dayLabel(t.workDate), t.workGroup ? `Công việc ${t.workGroup.number}` : null].filter(Boolean).join(' · ');
  return { id: t.id, roomNumber: t.roomNumber, workDate: t.workDate, label: t.cycleNumber > 1 ? `${label} (lần ${t.cycleNumber})` : label };
}

/** "Phòng 102 — Điều hòa không lạnh · Đang sửa". */
function issueSource(i: Prisma.HotelIssueGetPayload<{ select: typeof ISSUE_SOURCE_SELECT }>) {
  const what = i.description.length > 60 ? `${i.description.slice(0, 60)}…` : i.description;
  return { id: i.id, label: `${describeLocation(i)} — ${what}`, status: i.status, statusLabel: ISSUE_STATUS_LABELS[i.status], reportedAt: i.createdAt };
}

const DAMAGE_INCLUDE = {
  item: { select: { name: true, variant: true, unit: true, balances: { select: { state: true, quantity: true } } } },
  branch: { select: { id: true, address: true, branchNumber: true } },
  movements: { orderBy: [{ createdAt: 'asc' as const }, { delta: 'asc' as const }], select: { type: true, state: true, delta: true, balanceAfter: true, createdAt: true, actorNameSnapshot: true } },
  task: { select: TASK_SOURCE_SELECT },
  issue: { select: ISSUE_SOURCE_SELECT },
} satisfies Prisma.InventoryDamageReportInclude;

export const DAMAGE_STATUS_LABELS: Record<InventoryDamageStatus, string> = {
  PENDING: 'Chờ Admin xem',
  ACKNOWLEDGED: 'Đã xác nhận',
  REJECTED: 'Đã từ chối — hoàn kho',
};

function serializeDamage(r: Prisma.InventoryDamageReportGetPayload<{ include: typeof DAMAGE_INCLUDE }>) {
  return {
    id: r.id,
    branch: r.branch,
    warehouse: r.warehouse,
    warehouseLabel: WAREHOUSE_LABELS[r.warehouse],
    itemId: r.itemId,
    label: itemLabel(r.item),
    unit: r.item.unit,
    quantity: r.quantity,
    fromState: r.fromState,
    fromStateLabel: STATE_LABELS[r.fromState],
    reason: r.reason,
    roomNumber: r.roomNumber,
    taskId: r.taskId,
    issueId: r.issueId,
    // The linked sources, as the Admin reads them.
    task: r.task ? taskSource(r.task) : null,
    issue: r.issue ? issueSource(r.issue) : null,
    status: r.status,
    statusLabel: DAMAGE_STATUS_LABELS[r.status],
    reportedBy: { id: r.reportedByUserId, name: r.reportedByNameSnapshot },
    reportedAt: r.reportedAt,
    reviewedBy: r.reviewedByUserId ? { id: r.reviewedByUserId, name: r.reviewedByNameSnapshot } : null,
    reviewedAt: r.reviewedAt,
    reviewNote: r.reviewNote,
    // The item's balances now — what the write-off left.
    balances: Object.fromEntries(r.item.balances.map((b) => [b.state, b.quantity])),
    history: r.movements.map((m) => ({ ...m, typeLabel: MOVEMENT_LABELS[m.type], stateLabel: STATE_LABELS[m.state] })),
  };
}

/** The Admins who hear of a damage report — every active one. */
async function notifyAdmins(report: { id: string; quantity: number; reason: string }, label: string, unit: string, branch: string, client: PrismaClient) {
  const admins = await client.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true } });
  if (admins.length === 0) return;
  const why = report.reason.length > 80 ? `${report.reason.slice(0, 80)}…` : report.reason;
  await client.notification.createMany({
    data: admins.map((a) => ({
      userId: a.id,
      title: 'Báo hỏng đồ buồng phòng',
      body: `${branch} · ${label}: ${report.quantity} ${unit} — ${why}`,
      link: `/app/inventory?damage=${report.id}`,
      // One notice per report and Admin, whatever retries.
      dedupeKey: `INVENTORY_DAMAGE:${report.id}:${a.id}`,
    })),
    skipDuplicates: true,
  });
  const rows = await client.notification.findMany({
    where: { dedupeKey: { in: admins.map((a) => `INVENTORY_DAMAGE:${report.id}:${a.id}`) } },
    select: { id: true },
  });
  dispatchPush(
    rows.map((r) => r.id),
    client,
  );
}

/**
 * Takes the damaged quantity OUT of the usable stock at once (its state →
 * DAMAGED, by movements) and tells the Admin. Counted once: the report's own
 * request key and source key.
 */
export async function createDamageReport(actor: HousekeepingActor, input: DamageInput, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  const branch = await managerBranch(actor, client);
  const requestId = requestIdOf(input.requestId);
  const again = await client.inventoryDamageReport.findUnique({ where: { requestId }, include: DAMAGE_INCLUDE });
  if (again) return { report: serializeDamage(again), duplicate: true };
  const item = await client.inventoryItem.findUnique({
    where: { id: typeof input.itemId === 'string' ? input.itemId : '' },
    select: { id: true, branchId: true, warehouse: true, name: true, variant: true, unit: true, archivedAt: true },
  });
  if (!item || item.branchId !== branch.id) throw ApiError.validation('Mặt hàng không thuộc kho của chi nhánh.');
  const fromState = stateOf(input.fromState, item.warehouse);
  if (fromState === 'DAMAGED') throw ApiError.validation('Đồ đã ở trạng thái hỏng.');
  const quantity = quantityOf(input.quantity, 'Số lượng hỏng');
  const reason = textOf(input.reason, 1000, 'Lý do hỏng');
  if (!reason) throw ApiError.validation('Vui lòng nhập lý do hỏng.');
  let roomNumber = textOf(input.roomNumber, 50, 'Số phòng');
  // OPTIONAL SOURCES — each this branch's own, and the same room as the report.
  let taskId: string | null = null;
  if (typeof input.taskId === 'string' && input.taskId) {
    const task = await client.housekeepingRoomTask.findUnique({ where: { id: input.taskId }, select: { branchId: true, roomNumber: true, areaKind: true } });
    if (!task || task.branchId !== branch.id) throw ApiError.validation('Công việc buồng phòng không thuộc chi nhánh của bạn.');
    if (task.areaKind === 'ROOM') {
      if (roomNumber && roomNumber !== task.roomNumber) throw ApiError.validation(`Công việc đã chọn là của phòng ${task.roomNumber}, không phải phòng ${roomNumber}.`);
      roomNumber = task.roomNumber;
    }
    taskId = input.taskId;
  }
  let issueId: string | null = null;
  if (typeof input.issueId === 'string' && input.issueId) {
    const issue = await client.hotelIssue.findUnique({ where: { id: input.issueId }, select: { branchId: true, roomNumber: true, areaCategory: true, voidedAt: true } });
    if (!issue || issue.branchId !== branch.id) throw ApiError.validation('Sự cố kỹ thuật không thuộc chi nhánh của bạn.');
    if (issue.voidedAt) throw ApiError.validation('Sự cố kỹ thuật này đã bị xóa.');
    const issueRoom = issue.areaCategory === 'ROOM' || !issue.areaCategory ? issue.roomNumber : null;
    if (roomNumber && issueRoom && issueRoom !== roomNumber) throw ApiError.validation(`Sự cố đã chọn ở phòng ${issueRoom}, không phải phòng ${roomNumber}.`);
    roomNumber ??= issueRoom;
    issueId = input.issueId;
  }
  const now = clock.now();
  let id: string;
  try {
    id = await client.$transaction(async (tx) => {
      const report = await tx.inventoryDamageReport.create({
        data: {
          branchId: branch.id,
          warehouse: item.warehouse,
          itemId: item.id,
          quantity,
          fromState,
          reason,
          roomNumber,
          taskId,
          issueId,
          requestId,
          reportedByUserId: actor.id,
          reportedByNameSnapshot: actor.fullName,
          reportedAt: now,
        },
      });
      const common = { type: 'DAMAGE' as const, sourceKey: `DAMAGE:${report.id}`, damageReportId: report.id, reason, roomNumber, taskId };
      await applyMovements(
        tx,
        [
          { item, state: fromState, delta: -quantity, ...common },
          { item, state: 'DAMAGED', delta: quantity, ...common },
        ],
        actor,
        now,
      );
      return report.id;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const first = await client.inventoryDamageReport.findUnique({ where: { requestId }, include: DAMAGE_INCLUDE });
      if (first) return { report: serializeDamage(first), duplicate: true };
    }
    throw e;
  }
  const saved = await client.inventoryDamageReport.findUniqueOrThrow({ where: { id }, include: DAMAGE_INCLUDE });
  await notifyAdmins(saved, itemLabel(item), item.unit, saved.branch.address, client);
  return { report: serializeDamage(saved), duplicate: false };
}

/**
 * What a damage report may name as its source: this branch's housekeeping work
 * of the last seven days and its technical incidents (open, or reported in the
 * last thirty days) — of one room when one is given. Read on this branch only.
 */
export async function damageSources(actor: HousekeepingActor, query: { roomNumber?: unknown }, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  const branch = await managerBranch(actor, client);
  const room = textOf(query.roomNumber, 50, 'Số phòng');
  const now = clock.now();
  const today = hcmDateOnly(now);
  const since = hcmDateOnly(new Date(now.getTime() - 7 * 24 * 3600_000));
  const [tasks, issues] = await Promise.all([
    client.housekeepingRoomTask.findMany({
      where: { branchId: branch.id, voidedAt: null, workDate: { gte: since, lte: today }, ...(room ? { roomNumber: room } : {}) },
      select: TASK_SOURCE_SELECT,
      orderBy: [{ workDate: 'desc' }, { roomNumber: 'asc' }, { cycleNumber: 'desc' }],
      take: 50,
    }),
    client.hotelIssue.findMany({
      where: {
        branchId: branch.id,
        voidedAt: null,
        ...(room ? { roomNumber: room } : {}),
        OR: [{ status: { not: 'COMPLETED' } }, { createdAt: { gte: new Date(now.getTime() - 30 * 24 * 3600_000) } }],
      },
      select: ISSUE_SOURCE_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);
  return { tasks: tasks.map(taskSource), issues: issues.map(issueSource) };
}

export async function listDamageReports(
  actor: HousekeepingActor,
  query: { branchId?: number; warehouse?: unknown; status?: unknown; itemId?: unknown; from?: unknown; to?: unknown },
  client: PrismaClient = defaultPrisma,
) {
  const status = typeof query.status === 'string' && ['PENDING', 'ACKNOWLEDGED', 'REJECTED'].includes(query.status) ? (query.status as InventoryDamageStatus) : undefined;
  const day = (raw: unknown, end: boolean) => {
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
    const start = new Date(`${raw}T00:00:00+07:00`);
    return end ? new Date(start.getTime() + 24 * 3600_000) : start;
  };
  const from = day(query.from, false);
  const to = day(query.to, true);
  const rows = await client.inventoryDamageReport.findMany({
    where: {
      ...managerBranchWhere(actor, actor.role === 'HOUSEKEEPING_MANAGER' ? (actor.branchId ?? -1) : query.branchId),
      ...(query.warehouse ? { warehouse: warehouseOf(query.warehouse) } : {}),
      ...(status ? { status } : {}),
      ...(typeof query.itemId === 'string' && query.itemId ? { itemId: query.itemId } : {}),
      ...(from || to ? { reportedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
    },
    include: DAMAGE_INCLUDE,
    orderBy: { reportedAt: 'desc' },
    take: 100,
  });
  return rows.map(serializeDamage);
}

/**
 * The Admin's review: "Xác nhận" keeps the write-off; "Từ chối" moves the
 * quantity back where it came from by a DAMAGE_REVERSAL movement. Once only.
 */
export async function reviewDamageReport(
  actor: HousekeepingActor,
  id: string,
  input: { decision: unknown; note?: unknown },
  clock: Clock = getClock(),
  client: PrismaClient = defaultPrisma,
) {
  if (actor.role !== 'ADMIN') throw ApiError.forbidden('Chỉ Admin mới xem xét báo hỏng.');
  const decision = input.decision === 'ACKNOWLEDGE' ? 'ACKNOWLEDGED' : input.decision === 'REJECT' ? 'REJECTED' : null;
  if (!decision) throw ApiError.validation('Chọn "Xác nhận" hoặc "Từ chối".');
  const note = textOf(input.note, 1000, 'Ghi chú');
  if (decision === 'REJECTED' && !note) throw ApiError.validation('Vui lòng nhập lý do từ chối.');
  const row = await client.inventoryDamageReport.findUnique({
    where: { id },
    include: { item: { select: { id: true, branchId: true, warehouse: true, name: true, variant: true, unit: true } } },
  });
  if (!row) throw ApiError.notFound('Không tìm thấy báo hỏng.');
  managerBranchWhere(actor, row.branchId);
  const now = clock.now();
  await client.$transaction(async (tx) => {
    const { count } = await tx.inventoryDamageReport.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: decision, reviewedByUserId: actor.id, reviewedByNameSnapshot: actor.fullName, reviewedAt: now, reviewNote: note },
    });
    if (count === 0) throw ApiError.conflict('Báo hỏng này đã được xem xét.');
    if (decision === 'REJECTED') {
      const common = { type: 'DAMAGE_REVERSAL' as const, sourceKey: `DAMAGE_REVERSAL:${id}`, damageReportId: id, reason: note };
      await applyMovements(
        tx,
        [
          { item: row.item, state: 'DAMAGED', delta: -row.quantity, ...common },
          { item: row.item, state: row.fromState, delta: row.quantity, ...common },
        ],
        actor,
        now,
      );
    }
  });
  return serializeDamage(await client.inventoryDamageReport.findUniqueOrThrow({ where: { id }, include: DAMAGE_INCLUDE }));
}

/* ------------------------------------------------------------------ *
 * The ledger, read
 * ------------------------------------------------------------------ */

export async function listMovements(
  actor: HousekeepingActor,
  query: { branchId?: number; warehouse?: unknown; itemId?: unknown; limit?: number },
  client: PrismaClient = defaultPrisma,
) {
  const rows = await client.inventoryMovement.findMany({
    where: {
      ...managerBranchWhere(actor, actor.role === 'HOUSEKEEPING_MANAGER' ? (actor.branchId ?? -1) : query.branchId),
      ...(query.warehouse ? { warehouse: warehouseOf(query.warehouse) } : {}),
      ...(typeof query.itemId === 'string' && query.itemId ? { itemId: query.itemId } : {}),
      ...(seesReconciliation(actor) ? {} : { type: { not: 'COUNT_ADJUSTMENT' as const } }),
    },
    include: { item: { select: { name: true, variant: true, unit: true } }, branch: { select: { id: true, address: true, branchNumber: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(query.limit ?? 100, 1), 300),
  });
  return rows.map((m) => ({
    id: m.id,
    branch: m.branch,
    warehouse: m.warehouse,
    itemId: m.itemId,
    label: itemLabel(m.item),
    unit: m.item.unit,
    state: m.state,
    stateLabel: STATE_LABELS[m.state],
    delta: m.delta,
    balanceAfter: m.balanceAfter,
    type: m.type,
    typeLabel: MOVEMENT_LABELS[m.type],
    reason: m.reason,
    roomNumber: m.roomNumber,
    workDate: m.workDate,
    taskId: m.taskId,
    actor: { id: m.actorUserId, name: m.actorNameSnapshot, role: m.actorRole },
    createdAt: m.createdAt,
  }));
}

/** What the screens need to draw the warehouses: labels and each warehouse's states. */
export function inventoryCatalog() {
  return {
    warehouses: WAREHOUSES.map((w) => ({ code: w, label: WAREHOUSE_LABELS[w], states: WAREHOUSE_STATES[w], codePrefix: CODE_PREFIX[w] })),
    legacyWarehouse: { code: LEGACY_WAREHOUSE, label: WAREHOUSE_LABELS[LEGACY_WAREHOUSE] },
    states: STATE_LABELS,
    movements: MOVEMENT_LABELS,
    damageStatuses: DAMAGE_STATUS_LABELS,
    transfers: Object.fromEntries(Object.entries(TRANSFERS).map(([k, v]) => [k, v])),
  };
}
