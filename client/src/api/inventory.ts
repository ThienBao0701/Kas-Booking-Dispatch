/**
 * Housekeeping "Kho hàng" — four warehouses: Kho hóa chất & dụng cụ, Đồ dùng
 * cho khách, Kho đồ vải, Kho đồ dùng khác / Đồ tiêu hao (Amenities).
 * Every balance, receipt, count and damage report is the server's; the screens
 * never compute stock of their own.
 */
import { api } from './client';

export const INVENTORY_KEY = ['housekeeping', 'inventory'] as const;

/** The four, and EQUIPMENT — the former "Kho đồ dùng, thiết bị", whose items wait to be classified. */
export type Warehouse = 'CHEMICAL_TOOLS' | 'GUEST_SUPPLIES' | 'LINEN' | 'AMENITY' | 'EQUIPMENT';

/** "Kho hàng", in order — the code prefixes 1, 2, 3, 4. */
export const WAREHOUSES: Warehouse[] = ['CHEMICAL_TOOLS', 'GUEST_SUPPLIES', 'LINEN', 'AMENITY'];
export type StockState = 'AVAILABLE' | 'DIRTY' | 'IN_LAUNDRY' | 'ISSUED' | 'DAMAGED';
export type TransferKind = 'LAUNDRY_SEND' | 'LAUNDRY_RETURN' | 'STOCK_ISSUE' | 'STOCK_RETURN';
export type DamageStatus = 'PENDING' | 'ACKNOWLEDGED' | 'REJECTED';

export const WAREHOUSE_LABELS: Record<Warehouse, string> = {
  CHEMICAL_TOOLS: 'Kho hóa chất & dụng cụ',
  GUEST_SUPPLIES: 'Đồ dùng cho khách',
  LINEN: 'Kho đồ vải',
  AMENITY: 'Kho đồ dùng khác / Đồ tiêu hao (Amenities)',
  EQUIPMENT: 'Chưa phân loại (kho đồ dùng, thiết bị cũ)',
};

/** Short names where four must fit side by side. */
export const WAREHOUSE_SHORT: Record<Warehouse, string> = {
  CHEMICAL_TOOLS: 'Hóa chất & dụng cụ',
  GUEST_SUPPLIES: 'Đồ dùng cho khách',
  LINEN: 'Đồ vải',
  AMENITY: 'Đồ tiêu hao',
  EQUIPMENT: 'Chưa phân loại',
};

/** The states each warehouse keeps, in display order — the server's own rule: one on-hand quantity, and what was written off. */
export const WAREHOUSE_STATES: Record<Warehouse, StockState[]> = {
  CHEMICAL_TOOLS: ['AVAILABLE', 'DAMAGED'],
  GUEST_SUPPLIES: ['AVAILABLE', 'DAMAGED'],
  LINEN: ['AVAILABLE', 'DAMAGED'],
  AMENITY: ['AVAILABLE', 'DAMAGED'],
  EQUIPMENT: ['AVAILABLE', 'ISSUED', 'DAMAGED'],
};

export const STATE_LABELS: Record<StockState, string> = {
  AVAILABLE: 'Sẵn dùng',
  DIRTY: 'Bẩn',
  IN_LAUNDRY: 'Đang giặt',
  ISSUED: 'Đang sử dụng',
  DAMAGED: 'Hỏng',
};

export interface BranchRef {
  id: number;
  address: string;
  branchNumber: number;
}

export interface InventoryItem {
  id: string;
  branch: BranchRef;
  warehouse: Warehouse;
  name: string;
  variant: string;
  label: string;
  code: string | null;
  unit: string;
  catalogKey: string | null;
  lowStockThreshold: number | null;
  lowStock: boolean;
  note: string | null;
  archived: boolean;
  balances: Partial<Record<StockState, number>>;
  /** A balance in a state the warehouse no longer keeps (dirty linen, issued equipment) — for review. */
  legacyBalances?: { state: StockState; stateLabel: string; quantity: number }[];
  /** Still in the former equipment warehouse: waits to be classified. */
  unclassified?: boolean;
  /** SYSTEM: the Admin's shared catalog (one row in every branch, its own stock); BRANCH: this branch's own item. */
  scope?: 'SYSTEM' | 'BRANCH';
  /** In the branch's room-cleaning list at this position; null: not in it. */
  cleaningOrder?: number | null;
  pendingDamage: number;
  /** Its stock was set up: counted or moved at least once. */
  opened: boolean;
}

/** One item the branch's room cleaning may count — with its code, for its managers and the Admin. */
export interface CleaningChoice {
  id: string;
  warehouse: Warehouse;
  warehouseLabel: string;
  code: string | null;
  label: string;
  unit: string;
  available: number;
  cleaningOrder: number | null;
}

/** A damage report's possible source. */
export interface SourceRef {
  id: string;
  label: string;
}

export interface Receipt {
  id: string;
  branch?: BranchRef;
  warehouse: Warehouse;
  receivedAt: string;
  reference: string | null;
  note: string | null;
  createdBy: { id: number; name: string };
  createdAt: string;
  lines: { itemId: string; label: string; unit: string; quantity: number; note: string | null }[];
}

export interface StockCount {
  id: string;
  opening: boolean;
  branch: BranchRef;
  warehouse: Warehouse;
  note: string | null;
  createdBy: { id: number; name: string; role: string };
  createdAt: string;
  lines: {
    itemId: string;
    label: string;
    unit: string;
    state: StockState;
    stateLabel: string;
    /** The book quantity and the difference — the Admin's only (absent for a Quản lý buồng phòng). */
    systemQuantity?: number;
    countedQuantity: number;
    difference?: number;
    reason: string | null;
  }[];
}

export interface DamageReport {
  id: string;
  branch: BranchRef;
  warehouse: Warehouse;
  warehouseLabel: string;
  itemId: string;
  label: string;
  unit: string;
  quantity: number;
  fromState: StockState;
  fromStateLabel: string;
  reason: string;
  roomNumber: string | null;
  taskId: string | null;
  issueId: string | null;
  /** The linked housekeeping work item and technical incident, if any. */
  task: (SourceRef & { roomNumber: string; workDate: string }) | null;
  issue: (SourceRef & { status: string; statusLabel: string; reportedAt: string }) | null;
  status: DamageStatus;
  statusLabel: string;
  reportedBy: { id: number; name: string };
  reportedAt: string;
  reviewedBy: { id: number; name: string | null } | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  balances: Partial<Record<StockState, number>>;
  history: { type: string; typeLabel: string; state: StockState; stateLabel: string; delta: number; balanceAfter: number; createdAt: string; actorNameSnapshot: string }[];
}

export interface Movement {
  id: string;
  branch: BranchRef;
  warehouse: Warehouse;
  itemId: string;
  label: string;
  unit: string;
  state: StockState;
  stateLabel: string;
  delta: number;
  balanceAfter: number;
  type: string;
  typeLabel: string;
  reason: string | null;
  roomNumber: string | null;
  workDate: string | null;
  taskId: string | null;
  actor: { id: number; name: string; role: string };
  createdAt: string;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** A key for one submission: a retried save is the same save. */
export function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `r${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
}

const BASE = '/housekeeping/inventory';

/** "Xuất Excel" — opened as an ordinary link, in the reader's scope. */
export function inventoryExportUrl(p: { branchId?: number; warehouse?: Warehouse } = {}): string {
  return `/api${BASE}/export.xlsx${query(p)}`;
}

export const inventoryApi = {
  items: (p: { branchId?: number; warehouse?: Warehouse; includeArchived?: boolean } = {}) =>
    api.get<{ items: InventoryItem[] }>(`${BASE}/items${query({ ...p, includeArchived: p.includeArchived ? 'true' : undefined })}`),
  /** "Thêm mặt hàng": several new items of one warehouse, by name, all or none — the codes are the server's. */
  createItems: (warehouse: Warehouse, items: { name: string }[]) =>
    api.post<{ items: InventoryItem[] }>(`${BASE}/items/batch`, { warehouse, items }),
  /** Unit, threshold, note — or, for an unclassified item, the warehouse it goes into. */
  updateItem: (id: string, body: { unit?: string; lowStockThreshold?: number | null; note?: string; warehouse?: Warehouse }) =>
    api.patch<{ item: InventoryItem }>(`${BASE}/items/${id}`, body),
  /** "Mặt hàng dùng khi dọn phòng": the branch's list, and every item it may hold. */
  cleaningItems: (branchId?: number) => api.get<{ branchId: number; items: CleaningChoice[] }>(`${BASE}/cleaning-items${query({ branchId })}`),
  setCleaningItems: (itemIds: string[], branchId?: number) =>
    api.put<{ branchId: number; items: CleaningChoice[] }>(`${BASE}/cleaning-items`, { itemIds, ...(branchId ? { branchId } : {}) }),
  removeItem: (id: string) => api.del<{ removed: boolean; archived: boolean }>(`${BASE}/items/${id}`),
  receipts: (p: { branchId?: number; warehouse?: Warehouse } = {}) => api.get<{ receipts: Receipt[] }>(`${BASE}/receipts${query(p)}`),
  createReceipt: (body: { warehouse: Warehouse; requestId: string; receivedAt?: string; reference?: string; note?: string; lines: { itemId: string; quantity: number; note?: string }[] }) =>
    api.post<{ receipt: Receipt; duplicate: boolean }>(`${BASE}/receipts`, body),
  /** The Admin's "Nhập kho" for several branches — each with its own items and quantities, all or none. */
  createMultiReceipt: (body: {
    warehouse: Warehouse;
    requestId: string;
    receivedAt?: string;
    reference?: string;
    branches: { branchId: number; lines: { itemId: string; quantity: number }[] }[];
  }) => api.post<{ receipts: Receipt[]; duplicate: boolean }>(`${BASE}/receipts/multi`, body),
  counts: (p: { branchId?: number; warehouse?: Warehouse; onlyDifferences?: boolean } = {}) =>
    api.get<{ counts: StockCount[] }>(`${BASE}/counts${query({ ...p, onlyDifferences: p.onlyDifferences ? 'true' : undefined })}`),
  createCount: (body: {
    branchId?: number;
    warehouse: Warehouse;
    requestId: string;
    /** "Khai báo tồn đầu kỳ": items with no stock history, counted for the first time. */
    opening?: boolean;
    note?: string;
    /** `systemQuantity`: the book the Admin saw; a blind count (Quản lý buồng phòng) sends none. */
    lines: { itemId: string; state: StockState; systemQuantity?: number; countedQuantity: number; reason?: string }[];
  }) => api.post<{ count: StockCount; duplicate: boolean }>(`${BASE}/counts`, body),
  transfer: (body: { kind: TransferKind; requestId: string; note?: string; lines: { itemId: string; quantity: number }[] }) =>
    api.post<{ id: string; duplicate: boolean }>(`${BASE}/transfers`, body),
  damage: (p: { branchId?: number; warehouse?: Warehouse; status?: DamageStatus; itemId?: string; from?: string; to?: string } = {}) =>
    api.get<{ reports: DamageReport[] }>(`${BASE}/damage${query(p)}`),
  damageSources: (roomNumber?: string) =>
    api.get<{ tasks: (SourceRef & { roomNumber: string; workDate: string })[]; issues: (SourceRef & { statusLabel: string })[] }>(
      `${BASE}/damage/sources${query({ roomNumber })}`,
    ),
  reportDamage: (body: {
    itemId: string;
    quantity: number;
    fromState: StockState;
    reason: string;
    roomNumber?: string;
    taskId?: string;
    issueId?: string;
    requestId: string;
  }) =>
    api.post<{ report: DamageReport; duplicate: boolean }>(`${BASE}/damage`, body),
  reviewDamage: (id: string, body: { decision: 'ACKNOWLEDGE' | 'REJECT'; note?: string }) =>
    api.post<{ report: DamageReport }>(`${BASE}/damage/${id}/review`, body),
  movements: (p: { branchId?: number; warehouse?: Warehouse; itemId?: string; limit?: number } = {}) =>
    api.get<{ movements: Movement[] }>(`${BASE}/movements${query(p)}`),
};
