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
 * THE ROOM CLEANING. A completed "Dọn phòng" moves the stock of the items the
 * branch keeps in its warehouses (`catalogKey`): what was put into the room
 * leaves AVAILABLE ("Đồ sạch cấp cho phòng"), the linen taken out enters DIRTY
 * ("Đồ bẩn thu về"), traced to the room, the task and its day. An item the
 * branch has not added to a warehouse is not tracked — no stock is invented.
 */
import type { InventoryMovementType, InventoryStockState, InventoryWarehouse, Prisma, UserRole } from '@prisma/client';
import { ApiError } from '../lib/errors';
import { LINEN_ITEMS, LINEN_QUANTITY_CODES, LINEN_SIZES, QUANTITY_ITEMS, REPLACEMENT_ITEMS, type CleaningForm } from './roomTaskCatalog';

export const WAREHOUSES: readonly InventoryWarehouse[] = ['LINEN', 'AMENITY', 'EQUIPMENT'];

export const WAREHOUSE_LABELS: Record<InventoryWarehouse, string> = {
  LINEN: 'Kho Linens',
  AMENITY: 'Kho Amenities',
  EQUIPMENT: 'Kho đồ dùng, thiết bị',
};

/**
 * The states each warehouse keeps, in display order. Linen is clean, dirty or
 * damaged: "Giặt xong" brings dirty linen straight back to clean (there is no
 * separate "đang giặt" stage — IN_LAUNDRY stays in the enum, unused).
 */
export const WAREHOUSE_STATES: Record<InventoryWarehouse, InventoryStockState[]> = {
  LINEN: ['AVAILABLE', 'DIRTY', 'DAMAGED'],
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
 * The "Dọn phòng" form as warehouse items
 * ------------------------------------------------------------------ */

const UNITS: Record<string, string> = { WATER: 'chai', TOILET_ROLL: 'cuộn', SLIPPERS: 'đôi' };

/**
 * WHAT A FORM FIELD DOES TO THE STOCK, said once:
 *   CLEAN_AND_DIRTY  linen — "Đồ sạch cấp cho phòng" out of Sẵn dùng, and
 *                    "Đồ bẩn thu về" into Bẩn: two quantities, two movements
 *   CLEAN_ISSUE      a supply — "Cấp cho phòng" out of Sẵn dùng; never dirty
 *   TICK             a replacement ✓ — ONE unit (one set) out of Sẵn dùng
 */
export type FieldMeaning = 'CLEAN_AND_DIRTY' | 'CLEAN_ISSUE' | 'TICK';

export interface CatalogEntry {
  catalogKey: string;
  warehouse: InventoryWarehouse;
  /** The form field, as the form names it ("Ga giường — King", "✓ Dầu gội"). */
  field: string;
  meaning: FieldMeaning;
  /**
   * A grouped replacement ("Lược, tăm bông, chụp tóc"): one ✓ is ONE KIT of
   * several things, so it may only deduct an item that IS that kit — mapped
   * only with an explicit confirmation, never silently to one of its parts.
   */
  kit: boolean;
  /** For bed linen: the size the item must be ("King" / "Queen" / "Twin"). */
  size: string | null;
  /** What "Thêm từ form dọn phòng" creates for it. */
  name: string;
  variant: string;
  unit: string;
}

/**
 * Every field of the "Dọn phòng" form and the stock it moves: bed linen per
 * size (a King and a Queen sheet are two items), the counted linen, the counted
 * supplies, and the six replacements (one ✓ = one set). A field moves stock
 * only once a manager has tied it to an item of its warehouse (`catalogKey`).
 */
export function cleaningCatalog(): CatalogEntry[] {
  return [
    ...LINEN_ITEMS.flatMap((i) =>
      LINEN_SIZES.map((z) => ({
        catalogKey: `LINEN:${i.code}:${z.code}`,
        warehouse: 'LINEN' as const,
        field: `${i.label} — ${z.label}`,
        meaning: 'CLEAN_AND_DIRTY' as const,
        kit: false,
        size: z.label,
        name: i.label,
        variant: z.label,
        unit: 'cái',
      })),
    ),
    ...QUANTITY_ITEMS.map((i) => {
      const linen = LINEN_QUANTITY_CODES.includes(i.code);
      return {
        catalogKey: `QTY:${i.code}`,
        warehouse: linen ? ('LINEN' as const) : ('AMENITY' as const),
        field: i.label,
        meaning: linen ? ('CLEAN_AND_DIRTY' as const) : ('CLEAN_ISSUE' as const),
        kit: false,
        size: null,
        name: i.label,
        variant: '',
        unit: UNITS[i.code] ?? 'cái',
      };
    }),
    ...REPLACEMENT_ITEMS.map((i) => {
      const kit = i.label.includes(',');
      return {
        catalogKey: `REPLACED:${i.code}`,
        warehouse: 'AMENITY' as const,
        field: `✓ ${i.label}`,
        meaning: 'TICK' as const,
        kit,
        size: null,
        // A kit is created AS the kit ("Bộ: …"), never as one of its parts.
        name: kit ? `Bộ: ${i.label}` : i.label,
        variant: '',
        unit: 'bộ',
      };
    }),
  ];
}

export const MEANING_LABELS: Record<FieldMeaning, string> = {
  CLEAN_AND_DIRTY: 'Đồ sạch cấp cho phòng trừ “Sẵn dùng”; đồ bẩn thu về cộng vào “Bẩn”',
  CLEAN_ISSUE: 'Số cấp cho phòng trừ “Sẵn dùng” (đồ tiêu hao, không thành đồ bẩn)',
  TICK: 'Mỗi ô ✓ trừ 1 bộ khỏi “Sẵn dùng”',
};

/** What one completed form puts into the room and takes out of it, per catalog key. */
export function cleaningNeeds(form: CleaningForm): { catalogKey: string; provided: number; collected: number }[] {
  const out: { catalogKey: string; provided: number; collected: number }[] = [];
  for (const i of LINEN_ITEMS) {
    const e = form.linen[i.code];
    if (!e) continue;
    out.push({ catalogKey: `LINEN:${i.code}:${e.size}`, provided: e.quantity, collected: form.collected[i.code] ?? 0 });
  }
  for (const i of QUANTITY_ITEMS) {
    const linen = LINEN_QUANTITY_CODES.includes(i.code);
    const provided = form.quantities[i.code] ?? 0;
    const collected = linen ? (form.collected[i.code] ?? 0) : 0;
    if (provided > 0 || collected > 0) out.push({ catalogKey: `QTY:${i.code}`, provided, collected });
  }
  for (const code of form.replaced) out.push({ catalogKey: `REPLACED:${code}`, provided: 1, collected: 0 });
  return out.filter((n) => n.provided > 0 || n.collected > 0);
}

/**
 * A COMPLETED CLEANING'S STOCK — in the transaction that marks it completed, so
 * the task and its stock succeed or fail together, and its guarded update makes
 * it once. A shortage refuses the whole completion, naming every short item.
 */
export async function applyCleaningStock(
  tx: Prisma.TransactionClient,
  task: { id: string; branchId: number; roomNumber: string; workDate: string },
  form: CleaningForm,
  actor: Mover,
  now: Date,
): Promise<void> {
  const needs = cleaningNeeds(form);
  if (needs.length === 0) return;
  const items = await tx.inventoryItem.findMany({
    where: { branchId: task.branchId, archivedAt: null, catalogKey: { in: needs.map((n) => n.catalogKey) } },
    select: { id: true, branchId: true, warehouse: true, name: true, variant: true, unit: true, catalogKey: true },
  });
  const byKey = new Map(items.map((i) => [i.catalogKey!, i]));
  // Every shortage at once, so the manager can fix them in one receipt or count.
  const short: string[] = [];
  let unopened = false;
  for (const n of needs) {
    const item = byKey.get(n.catalogKey);
    if (!item || n.provided === 0) continue;
    const left = await balanceOf(tx, item.id, 'AVAILABLE');
    if (left >= n.provided) continue;
    // An item tied to the form but never counted or received: its stock was never set up.
    const history = await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id }, select: { _count: { select: { movements: true, countLines: true } } } });
    const never = history._count.movements === 0 && history._count.countLines === 0;
    unopened ||= never;
    short.push(`${itemLabel(item)} cần ${n.provided}, còn ${left} (${WAREHOUSE_LABELS[item.warehouse]}${never ? ', chưa khai báo tồn đầu kỳ' : ''})`);
  }
  if (short.length > 0) {
    throw ApiError.conflict(
      `Không đủ tồn kho để hoàn thành: ${short.join('; ')}. ` +
        (unopened
          ? 'Quản lý buồng phòng cần “Khai báo tồn đầu kỳ” (đếm thực tế) hoặc “Nhập kho” rồi bấm “Hoàn thành” lại.'
          : 'Báo quản lý nhập kho hoặc kiểm kho rồi bấm “Hoàn thành” lại.'),
    );
  }
  const where = { roomNumber: task.roomNumber, workDate: task.workDate, taskId: task.id, sourceKey: `TASK:${task.id}` };
  const moves: MoveInput[] = [];
  for (const n of needs) {
    const item = byKey.get(n.catalogKey);
    if (!item) continue;
    if (n.provided > 0) moves.push({ item, state: 'AVAILABLE', delta: -n.provided, type: 'ROOM_ISSUE', ...where });
    if (n.collected > 0 && item.warehouse === 'LINEN') moves.push({ item, state: 'DIRTY', delta: n.collected, type: 'DIRTY_COLLECTED', ...where });
  }
  await applyMovements(tx, moves, actor, now);
}
