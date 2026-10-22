/**
 * THE HOUSEKEEPING STOCK LEDGER — the one place a balance ever changes.
 *
 * EVERY CHANGE IS A MOVEMENT. A balance (`InventoryBalance`, per item and
 * state) is a projection of the movement rows and is written only here, in the
 * caller's transaction, beside the movement that explains it: a receipt, a room
 * cleaning, the laundry, a count, a damage report. Nothing overwrites a balance.
 *
 * NEVER BELOW ZERO. A decrease is ONE conditional UPDATE ("… AND quantity +
 * delta >= 0"): PostgreSQL re-checks the condition on the locked row, so two
 * writers can never both take the last towel — the second finds nothing to
 * update and the whole transaction is refused. A CHECK constraint backs it up.
 *
 * NEVER TWICE. Each movement names its action (`sourceKey`: "TASK:<id>",
 * "RECEIPT:<id>", …), unique per action, item and state.
 *
 * THE ROOM CLEANING. A completed "Dọn phòng" takes the quantities counted for
 * the branch's room-cleaning items (`cleaningOrder`) out of their on-hand
 * stock (AVAILABLE), traced to the room, the task and its day — one ordinary
 * quantity per item, no clean / dirty pair. Nothing moves before "Hoàn thành".
 */
import type { InventoryMovementType, InventoryStockState, InventoryWarehouse, Prisma, UserRole } from '@prisma/client';
import { ApiError } from '../lib/errors';
/** "Kho hàng": the four warehouses, in their order (and the order of their code prefixes). */
export const WAREHOUSES: readonly InventoryWarehouse[] = ['CHEMICAL_TOOLS', 'GUEST_SUPPLIES', 'LINEN', 'AMENITY'];

/** The former "Kho đồ dùng, thiết bị": not offered any more; its items wait to be classified. */
export const LEGACY_WAREHOUSE: InventoryWarehouse = 'EQUIPMENT';

/** Every warehouse a stored row may name — the four, and the legacy one. */
export const ALL_WAREHOUSES: readonly InventoryWarehouse[] = [...WAREHOUSES, LEGACY_WAREHOUSE];

export const WAREHOUSE_LABELS: Record<InventoryWarehouse, string> = {
  CHEMICAL_TOOLS: 'Kho hóa chất & dụng cụ',
  GUEST_SUPPLIES: 'Đồ dùng cho khách',
  LINEN: 'Kho đồ vải',
  AMENITY: 'Kho đồ dùng khác / Đồ tiêu hao (Amenities)',
  EQUIPMENT: 'Chưa phân loại (kho đồ dùng, thiết bị cũ)',
};

/** The item code's prefix: "1.001", "2.001", "3.001", "4.001". The legacy warehouse has none. */
export const CODE_PREFIX: Partial<Record<InventoryWarehouse, string>> = { CHEMICAL_TOOLS: '1', GUEST_SUPPLIES: '2', LINEN: '3', AMENITY: '4' };

/** "3.001" … "3.999", then "3.1000" — the number grows, never wraps. */
export function itemCode(warehouse: InventoryWarehouse, n: number): string {
  return `${CODE_PREFIX[warehouse]}.${String(n).padStart(3, '0')}`;
}

/**
 * The states each warehouse keeps, in display order: ONE on-hand quantity
 * (Sẵn dùng) and what was written off (Hỏng). A DIRTY or ISSUED balance left
 * from before is history to review, never folded into Sẵn dùng.
 */
export const WAREHOUSE_STATES: Record<InventoryWarehouse, InventoryStockState[]> = {
  CHEMICAL_TOOLS: ['AVAILABLE', 'DAMAGED'],
  GUEST_SUPPLIES: ['AVAILABLE', 'DAMAGED'],
  LINEN: ['AVAILABLE', 'DAMAGED'],
  AMENITY: ['AVAILABLE', 'DAMAGED'],
  EQUIPMENT: ['AVAILABLE', 'ISSUED', 'DAMAGED'],
};

export const STATE_LABELS: Record<InventoryStockState, string> = {
  AVAILABLE: 'Sẵn dùng',
  DIRTY: 'Bẩn',
  IN_LAUNDRY: 'Đang giặt',
  ISSUED: 'Đang sử dụng',
  DAMAGED: 'Hỏng',
};

export const MOVEMENT_LABELS: Record<InventoryMovementType, string> = {
  RECEIPT: 'Nhập kho',
  ROOM_ISSUE: 'Cấp cho phòng',
  DIRTY_COLLECTED: 'Thu đồ bẩn',
  LAUNDRY_SENT: 'Gửi giặt',
  LAUNDRY_RETURNED: 'Giặt xong',
  STOCK_ISSUED: 'Xuất dùng',
  STOCK_RETURNED: 'Thu hồi',
  DAMAGE: 'Báo hỏng',
  DAMAGE_REVERSAL: 'Hoàn báo hỏng',
  COUNT_ADJUSTMENT: 'Điều chỉnh kiểm kho',
};

export interface LedgerItem {
  id: string;
  branchId: number;
  warehouse: InventoryWarehouse;
  name: string;
  variant: string;
  unit: string;
}

export interface Mover {
  id: number;
  fullName: string;
  role: UserRole;
}

export interface MoveInput {
  item: LedgerItem;
  state: InventoryStockState;
  /** Signed: + into the state, − out of it. Never 0. */
  delta: number;
  type: InventoryMovementType;
  sourceKey: string;
  reason?: string | null;
  roomNumber?: string | null;
  workDate?: string | null;
  taskId?: string | null;
  receiptId?: string | null;
  countId?: string | null;
  transferId?: string | null;
  damageReportId?: string | null;
}

/** "Khăn tắm", "Ga giường (King)". */
export function itemLabel(item: Pick<LedgerItem, 'name' | 'variant'>): string {
  return item.variant ? `${item.name} (${item.variant})` : item.name;
}

/** The current quantity of one item in one state (0 when it never had any). */
export async function balanceOf(tx: Prisma.TransactionClient, itemId: string, state: InventoryStockState): Promise<number> {
  const row = await tx.inventoryBalance.findUnique({ where: { itemId_state: { itemId, state } }, select: { quantity: true } });
  return row?.quantity ?? 0;
}

/**
 * Applies movements in the CALLER'S transaction — all of them or, the caller's
 * transaction being refused, none. Decreases are refused when the stock is not
 * there; the error names the item, what was needed and what is left.
 */
export async function applyMovements(tx: Prisma.TransactionClient, moves: MoveInput[], actor: Mover, now: Date): Promise<void> {
  // One lock order for every writer (item, then state): no two transactions wait on each other.
  const ordered = [...moves].sort((a, b) => (a.item.id === b.item.id ? a.state.localeCompare(b.state) : a.item.id.localeCompare(b.item.id)));
  for (const m of ordered) {
    if (!Number.isInteger(m.delta) || m.delta === 0) throw ApiError.validation('Số lượng không hợp lệ.');
    let rows: { quantity: number }[];
    if (m.delta < 0) {
      rows = await tx.$queryRaw<{ quantity: number }[]>`
        UPDATE "InventoryBalance" SET "quantity" = "quantity" + ${m.delta}, "updatedAt" = ${now}
        WHERE "itemId" = ${m.item.id} AND "state" = ${m.state}::"InventoryStockState" AND "quantity" + ${m.delta} >= 0
        RETURNING "quantity"`;
      if (rows.length === 0) {
        const left = await balanceOf(tx, m.item.id, m.state);
        throw ApiError.conflict(
          `Không đủ tồn kho: ${itemLabel(m.item)} — cần ${-m.delta} ${m.item.unit}, ${STATE_LABELS[m.state].toLowerCase()} chỉ còn ${left}.`,
        );
      }
    } else {
      rows = await tx.$queryRaw<{ quantity: number }[]>`
        INSERT INTO "InventoryBalance" ("itemId", "state", "quantity", "updatedAt")
        VALUES (${m.item.id}, ${m.state}::"InventoryStockState", ${m.delta}, ${now})
        ON CONFLICT ("itemId", "state") DO UPDATE
          SET "quantity" = "InventoryBalance"."quantity" + EXCLUDED."quantity", "updatedAt" = EXCLUDED."updatedAt"
        RETURNING "quantity"`;
    }
    await tx.inventoryMovement.create({
      data: {
        branchId: m.item.branchId,
        itemId: m.item.id,
        warehouse: m.item.warehouse,
        state: m.state,
        delta: m.delta,
        balanceAfter: rows[0]!.quantity,
        type: m.type,
        sourceKey: m.sourceKey,
        reason: m.reason ?? null,
        roomNumber: m.roomNumber ?? null,
        workDate: m.workDate ?? null,
        taskId: m.taskId ?? null,
        receiptId: m.receiptId ?? null,
        countId: m.countId ?? null,
        transferId: m.transferId ?? null,
        damageReportId: m.damageReportId ?? null,
        actorUserId: actor.id,
        actorNameSnapshot: actor.fullName,
        actorRole: actor.role,
        createdAt: now,
      },
    });
  }
}

/* ------------------------------------------------------------------ *
 * The room cleaning
 * ------------------------------------------------------------------ */

/**
 * A COMPLETED CLEANING'S STOCK — in the transaction that marks it completed, so
 * the task and its stock succeed or fail together, and its guarded update makes
 * it once. Each counted item leaves Sẵn dùng; a shortage refuses the whole
 * completion, naming every short item at once.
 */
export async function applyCleaningItems(
  tx: Prisma.TransactionClient,
  task: { id: string; branchId: number; roomNumber: string; workDate: string },
  lines: { item: LedgerItem; quantity: number }[],
  actor: Mover,
  now: Date,
): Promise<void> {
  const used = lines.filter((l) => l.quantity > 0);
  if (used.length === 0) return;
  const short: string[] = [];
  for (const l of used) {
    const left = await balanceOf(tx, l.item.id, 'AVAILABLE');
    if (left < l.quantity) short.push(`${itemLabel(l.item)} cần ${l.quantity}, còn ${left}`);
  }
  if (short.length > 0) {
    throw ApiError.conflict(`Không đủ tồn kho để hoàn thành: ${short.join('; ')}. Báo quản lý nhập kho hoặc kiểm kho rồi bấm “Hoàn thành” lại.`);
  }
  const where = { roomNumber: task.roomNumber, workDate: task.workDate, taskId: task.id, sourceKey: `TASK:${task.id}` };
  await applyMovements(
    tx,
    used.map((l) => ({ item: l.item, state: 'AVAILABLE' as const, delta: -l.quantity, type: 'ROOM_ISSUE' as const, ...where })),
    actor,
    now,
  );
}
