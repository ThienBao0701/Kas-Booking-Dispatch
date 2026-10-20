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
  MEANING_LABELS,
  MOVEMENT_LABELS,
  STATE_LABELS,
  WAREHOUSES,
  WAREHOUSE_LABELS,
  WAREHOUSE_STATES,
  applyMovements,
  cleaningCatalog,
  itemLabel,
  type MoveInput,
} from './inventoryLedger';

const MAX_LINES = 100;
const MAX_QUANTITY = 100_000;

/* ------------------------------------------------------------------ *
 * Input checks
 * ------------------------------------------------------------------ */

function warehouseOf(raw: unknown): InventoryWarehouse {
  if (typeof raw !== 'string' || !(WAREHOUSES as readonly string[]).includes(raw)) throw ApiError.validation('Kho không hợp lệ.');
  return raw as InventoryWarehouse;
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
  unit: true,
  catalogKey: true,
  lowStockThreshold: true,
  note: true,
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
    unit: r.unit,
    catalogKey: r.catalogKey,
    lowStockThreshold: r.lowStockThreshold,
    // "Sắp hết" only where a threshold was configured.
    lowStock: r.lowStockThreshold !== null && !r.archivedAt && balances.AVAILABLE <= r.lowStockThreshold,
    note: r.note,
    archived: r.archivedAt !== null,
    balances,
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

/** "Thêm mặt hàng" — one item of one variant; its balances start at zero. */
export async function createItem(actor: HousekeepingActor, input: ItemInput, client: PrismaClient = defaultPrisma) {
  const branch = await managerBranch(actor, client);
  const name = textOf(input.name, 200, 'Tên mặt hàng');
  const unit = textOf(input.unit, 30, 'Đơn vị');
  if (!name) throw ApiError.validation('Vui lòng nhập tên mặt hàng.');
  if (!unit) throw ApiError.validation('Vui lòng nhập đơn vị tính.');
  try {
    const row = await client.inventoryItem.create({
      data: {
        branchId: branch.id,
        warehouse: warehouseOf(input.warehouse),
        name,
        variant: textOf(input.variant, 50, 'Kích cỡ / loại') ?? '',
        code: textOf(input.code, 50, 'Mã mặt hàng'),
        unit,
        lowStockThreshold: thresholdOf(input.lowStockThreshold),
        note: textOf(input.note, 500, 'Ghi chú'),
        createdByUserId: actor.id,
        createdByNameSnapshot: actor.fullName,
      },
      select: ITEM_SELECT,
    });
    return serializeItem(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw ApiError.conflict('Kho đã có mặt hàng cùng tên và kích cỡ (hoặc cùng mã) đang dùng.');
    throw e;
  }
}

/** Most new items one "Thêm mặt hàng" may save together. */
export const MAX_NEW_ITEMS = 50;

/**
 * "THÊM MẶT HÀNG" — one or several new items of one warehouse, ALL OR NONE: one
 * transaction, so a refused row (a duplicate name and size, a code already used)
 * leaves none of the others saved. Two rows of the request naming the same item
 * are refused before anything is written. Balances start at zero.
 */
export async function createItems(
  actor: HousekeepingActor,
  input: { warehouse: unknown; items: unknown },
  client: PrismaClient = defaultPrisma,
) {
  const branch = await managerBranch(actor, client);
  const warehouse = warehouseOf(input.warehouse);
  const raw = Array.isArray(input.items) ? (input.items as ItemInput[]) : [];
  if (raw.length === 0) throw ApiError.validation('Vui lòng nhập ít nhất một mặt hàng.');
  if (raw.length > MAX_NEW_ITEMS) throw ApiError.validation(`Tối đa ${MAX_NEW_ITEMS} mặt hàng mỗi lần.`);
  const rows = raw.map((r, i) => {
    const name = textOf(r.name, 200, 'Tên mặt hàng');
    const unit = textOf(r.unit, 30, 'Đơn vị');
    if (!name) throw ApiError.validation(`Dòng ${i + 1}: vui lòng nhập tên mặt hàng.`);
    if (!unit) throw ApiError.validation(`Dòng ${i + 1}: vui lòng nhập đơn vị tính.`);
    return {
      branchId: branch.id,
      warehouse,
      name,
      variant: textOf(r.variant, 50, 'Kích cỡ / loại') ?? '',
      code: textOf(r.code, 50, 'Mã mặt hàng'),
      unit,
      lowStockThreshold: thresholdOf(r.lowStockThreshold),
      note: textOf(r.note, 500, 'Ghi chú'),
      createdByUserId: actor.id,
      createdByNameSnapshot: actor.fullName,
    };
  });
  const fold = (v: string) => v.normalize('NFC').toLocaleLowerCase('vi');
  assertDistinct(rows.map((r) => `${fold(r.name)}|${fold(r.variant)}`), (i) => itemLabel(rows[i]!));
  const codes = rows.filter((r) => r.code).map((r) => fold(r.code!));
  if (new Set(codes).size !== codes.length) throw ApiError.validation('Hai dòng đang dùng cùng một mã mặt hàng.');
  try {
    const created = await client.$transaction((tx) => Promise.all(rows.map((data) => tx.inventoryItem.create({ data, select: ITEM_SELECT }))));
    return created.map(serializeItem);
  } catch (e) {
    if (isUniqueViolation(e)) throw ApiError.conflict('Kho đã có mặt hàng cùng tên và kích cỡ (hoặc cùng mã) đang dùng — không mặt hàng nào được lưu.');
    throw e;
  }
}

/**
 * "Thêm từ form dọn phòng" — the "Dọn phòng" form's items of one warehouse that
 * this branch does not keep yet, each at zero: no opening balance is invented.
 */
export async function addCatalogItems(actor: HousekeepingActor, warehouseRaw: unknown, client: PrismaClient = defaultPrisma) {
  const branch = await managerBranch(actor, client);
  const warehouse = warehouseOf(warehouseRaw);
  const wanted = cleaningCatalog().filter((c) => c.warehouse === warehouse);
  const existing = await client.inventoryItem.findMany({
    where: { branchId: branch.id, archivedAt: null, catalogKey: { in: wanted.map((c) => c.catalogKey) } },
    select: { catalogKey: true },
  });
  const have = new Set(existing.map((e) => e.catalogKey));
  const missing = wanted.filter((c) => !have.has(c.catalogKey));
  if (missing.length > 0) {
    await client.inventoryItem.createMany({
      data: missing.map((c) => ({
        branchId: branch.id,
        warehouse: c.warehouse,
        name: c.name,
        variant: c.variant,
        unit: c.unit,
        // Created FOR this field: the manager's own, explicit act ("Thêm từ form dọn phòng").
        catalogKey: c.catalogKey,
        createdByUserId: actor.id,
        createdByNameSnapshot: actor.fullName,
      })),
      // A name the manager already added by hand keeps its own row.
      skipDuplicates: true,
    });
  }
  return { added: missing.length };
}

/** Edits what does not change the stock's meaning: code, unit, threshold, note. */
export async function updateItem(
  actor: HousekeepingActor,
  id: string,
  input: { code?: unknown; unit?: unknown; lowStockThreshold?: unknown; note?: unknown },
  client: PrismaClient = defaultPrisma,
) {
  const branch = await managerBranch(actor, client);
  const item = await client.inventoryItem.findUnique({ where: { id }, select: { branchId: true, archivedAt: true } });
  if (!item || item.branchId !== branch.id) throw ApiError.notFound('Không tìm thấy mặt hàng.');
  if (item.archivedAt) throw ApiError.conflict('Mặt hàng đã ngừng sử dụng.');
  const data: Prisma.InventoryItemUpdateInput = {};
  if (input.code !== undefined) data.code = textOf(input.code, 50, 'Mã mặt hàng');
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
    if (isUniqueViolation(e)) throw ApiError.conflict('Mã mặt hàng đã được dùng cho mặt hàng khác.');
    throw e;
  }
}

/**
 * "Xóa" — an item never used is removed; one with any stock history is only
 * archived ("Ngừng sử dụng"): its movements, receipts and counts stay.
 */
export async function removeItem(actor: HousekeepingActor, id: string, client: PrismaClient = defaultPrisma) {
  const branch = await managerBranch(actor, client);
  const item = await client.inventoryItem.findUnique({
    where: { id },
    select: {
      branchId: true,
      archivedAt: true,
      _count: { select: { movements: true, receiptLines: true, countLines: true, transferLines: true, damageReports: true } },
    },
  });
  if (!item || item.branchId !== branch.id) throw ApiError.notFound('Không tìm thấy mặt hàng.');
  const used = Object.values(item._count).some((n) => n > 0);
  if (!used) {
    await client.inventoryItem.delete({ where: { id } });
    return { removed: true, archived: false };
  }
  if (!item.archivedAt) await client.inventoryItem.update({ where: { id }, data: { archivedAt: new Date() } });
  return { removed: false, archived: true };
}

/* ------------------------------------------------------------------ *
 * "Gắn với form dọn phòng" — which item each form field moves, explicitly
 * ------------------------------------------------------------------ */

/**
 * The "Dọn phòng" form, field by field, for one branch: what each field does to
 * the stock and the ONE item it moves — or none, and then a completed cleaning
 * moves nothing for it (no stock is invented, nothing deducted by a guess).
 */
export async function listFormMapping(
  actor: HousekeepingActor,
  query: { branchId?: number; warehouse?: unknown },
  client: PrismaClient = defaultPrisma,
) {
  const branchId = actor.role === 'HOUSEKEEPING_MANAGER' ? (actor.branchId ?? -1) : query.branchId;
  if (branchId === undefined) throw ApiError.validation('Vui lòng chọn chi nhánh.');
  const where = managerBranchWhere(actor, branchId);
  const warehouse = query.warehouse ? warehouseOf(query.warehouse) : undefined;
  const fields = cleaningCatalog().filter((c) => !warehouse || c.warehouse === warehouse);
  const items = await client.inventoryItem.findMany({
    where: { ...where, archivedAt: null, catalogKey: { in: fields.map((f) => f.catalogKey) } },
    select: ITEM_SELECT,
  });
  return fields.map((f) => {
    const item = items.find((i) => i.catalogKey === f.catalogKey);
    return {
      catalogKey: f.catalogKey,
      field: f.field,
      warehouse: f.warehouse,
      meaning: f.meaning,
      meaningLabel: MEANING_LABELS[f.meaning],
      kit: f.kit,
      size: f.size,
      item: item ? serializeItem(item) : null,
    };
  });
}

/**
 * Ties ONE form field to ONE item of this branch — or unties it (`null`). The
 * item must be of the field's warehouse; bed linen of the field's size; and a
 * grouped replacement ("Lược, tăm bông, chụp tóc") only an item the manager
 * confirms IS that kit — never silently one of its parts. One item per field.
 */
export async function mapItemToForm(
  actor: HousekeepingActor,
  id: string,
  input: { catalogKey: unknown; confirmKit?: unknown },
  client: PrismaClient = defaultPrisma,
) {
  const branch = await managerBranch(actor, client);
  const item = await client.inventoryItem.findUnique({
    where: { id },
    select: { branchId: true, warehouse: true, name: true, variant: true, unit: true, archivedAt: true },
  });
  if (!item || item.branchId !== branch.id) throw ApiError.notFound('Không tìm thấy mặt hàng.');
  if (item.archivedAt) throw ApiError.conflict('Mặt hàng đã ngừng sử dụng.');
  if (input.catalogKey === null) {
    return serializeItem(await client.inventoryItem.update({ where: { id }, data: { catalogKey: null }, select: ITEM_SELECT }));
  }
  const entry = cleaningCatalog().find((c) => c.catalogKey === input.catalogKey);
  if (!entry) throw ApiError.validation('Ô của form dọn phòng không hợp lệ.');
  if (entry.warehouse !== item.warehouse) throw ApiError.validation(`“${entry.field}” thuộc ${WAREHOUSE_LABELS[entry.warehouse]}.`);
  if (entry.size && item.variant.trim().toLowerCase() !== entry.size.toLowerCase()) {
    throw ApiError.validation(`“${entry.field}” chỉ gắn được với mặt hàng cỡ ${entry.size}; ${itemLabel(item)} không phải cỡ ${entry.size}.`);
  }
  if (entry.kit && input.confirmKit !== true) {
    throw ApiError.validation(`“${entry.field}” là một bộ nhiều món: chỉ gắn với mặt hàng là trọn bộ đó, và cần xác nhận (mỗi ô ✓ trừ 1 ${item.unit}).`);
  }
  try {
    return serializeItem(await client.inventoryItem.update({ where: { id }, data: { catalogKey: entry.catalogKey }, select: ITEM_SELECT }));
  } catch (e) {
    if (isUniqueViolation(e)) throw ApiError.conflict(`“${entry.field}” đã gắn với một mặt hàng khác. Bỏ gắn mặt hàng đó trước.`);
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * Receipts — "Lưu phiếu nhập"
 * ------------------------------------------------------------------ */

export interface ReceiptInput {
  warehouse: unknown;
  requestId: unknown;
  receivedAt?: unknown;
  reference?: unknown;
  note?: unknown;
  lines: { itemId: unknown; quantity: unknown; note?: unknown }[];
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

/** ONE delivery of many items — the header, every line and every movement, or nothing. */
export async function createReceipt(actor: HousekeepingActor, input: ReceiptInput, clock: Clock = getClock(), client: PrismaClient = defaultPrisma) {
  const branch = await managerBranch(actor, client);
  const warehouse = warehouseOf(input.warehouse);
  const requestId = requestIdOf(input.requestId);
  const again = await client.inventoryReceipt.findUnique({ where: { requestId }, include: RECEIPT_INCLUDE });
  if (again) return { receipt: serializeReceipt(again), duplicate: true };
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const items = await lineItems(client, branch.id, warehouse, lines.map((l) => l.itemId));
  assertDistinct(items.map((i) => i.id), (i) => itemLabel(items[i]!));
  const quantities = lines.map((l, i) => quantityOf(l.quantity, `Số lượng của ${itemLabel(items[i]!)}`));
  const now = clock.now();
  let receivedAt = now;
  if (input.receivedAt !== undefined && input.receivedAt !== null && input.receivedAt !== '') {
    receivedAt = new Date(String(input.receivedAt));
    if (Number.isNaN(receivedAt.getTime())) throw ApiError.validation('Thời gian nhận hàng không hợp lệ.');
    if (receivedAt.getTime() > now.getTime() + 5 * 60_000) throw ApiError.validation('Thời gian nhận hàng không thể ở tương lai.');
  }
  try {
    const id = await client.$transaction(async (tx) => {
      const receipt = await tx.inventoryReceipt.create({
        data: {
          branchId: branch.id,
          warehouse,
          requestId,
          receivedAt,
          reference: textOf(input.reference, 100, 'Số phiếu / tham chiếu'),
          note: textOf(input.note, 1000, 'Ghi chú'),
          createdByUserId: actor.id,
          createdByNameSnapshot: actor.fullName,
          createdAt: now,
          lines: { create: lines.map((l, i) => ({ itemId: items[i]!.id, quantity: quantities[i]!, note: textOf(l.note, 300, 'Ghi chú dòng') })) },
        },
      });
      await applyMovements(
        tx,
        items.map((item, i) => ({ item, state: 'AVAILABLE', delta: quantities[i]!, type: 'RECEIPT', sourceKey: `RECEIPT:${receipt.id}`, receiptId: receipt.id })),
        actor,
        now,
      );
      return receipt.id;
    });
    return { receipt: serializeReceipt(await client.inventoryReceipt.findUniqueOrThrow({ where: { id }, include: RECEIPT_INCLUDE })), duplicate: false };
  } catch (e) {
    // The same request racing itself: the first one's receipt is the answer.
    if (isUniqueViolation(e)) {
      const first = await client.inventoryReceipt.findUnique({ where: { requestId }, include: RECEIPT_INCLUDE });
      if (first) return { receipt: serializeReceipt(first), duplicate: true };
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
    warehouses: WAREHOUSES.map((w) => ({ code: w, label: WAREHOUSE_LABELS[w], states: WAREHOUSE_STATES[w] })),
    states: STATE_LABELS,
    movements: MOVEMENT_LABELS,
    damageStatuses: DAMAGE_STATUS_LABELS,
    transfers: Object.fromEntries(Object.entries(TRANSFERS).map(([k, v]) => [k, v])),
  };
}
