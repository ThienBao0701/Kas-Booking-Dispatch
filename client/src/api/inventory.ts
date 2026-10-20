/**
 * Housekeeping warehouses — Kho Linens, Kho Amenities, Kho đồ dùng, thiết bị.
 * Every balance, receipt, count and damage report is the server's; the screens
 * never compute stock of their own.
 */
import { api } from './client';

export const INVENTORY_KEY = ['housekeeping', 'inventory'] as const;

export type Warehouse = 'LINEN' | 'AMENITY' | 'EQUIPMENT';
export type StockState = 'AVAILABLE' | 'DIRTY' | 'IN_LAUNDRY' | 'ISSUED' | 'DAMAGED';
export type TransferKind = 'LAUNDRY_SEND' | 'LAUNDRY_RETURN' | 'STOCK_ISSUE' | 'STOCK_RETURN';
export type DamageStatus = 'PENDING' | 'ACKNOWLEDGED' | 'REJECTED';

export const WAREHOUSE_LABELS: Record<Warehouse, string> = {
  LINEN: 'Kho Linens',
  AMENITY: 'Kho Amenities',
  EQUIPMENT: 'Kho đồ dùng, thiết bị',
};

/** The states each warehouse keeps, in display order — the server's own rule. */
export const WAREHOUSE_STATES: Record<Warehouse, StockState[]> = {
  LINEN: ['AVAILABLE', 'DIRTY', 'DAMAGED'],
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
  pendingDamage: number;
  /** Its stock was set up: counted or moved at least once. */
  opened: boolean;
}

/** What a "Dọn phòng" field does to the stock. */
export type FieldMeaning = 'CLEAN_AND_DIRTY' | 'CLEAN_ISSUE' | 'TICK';

/** One field of the "Dọn phòng" form and the ONE item it moves (or none). */
export interface FormField {
  catalogKey: string;
  field: string;
  warehouse: Warehouse;
  meaning: FieldMeaning;
  meaningLabel: string;
  /** A grouped replacement: tied only to an item confirmed to BE that kit. */
  kit: boolean;
  size: string | null;
  item: InventoryItem | null;
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
  createItem: (body: { warehouse: Warehouse; name: string; variant?: string; code?: string; unit: string; lowStockThreshold?: number | null; note?: string }) =>
    api.post<{ item: InventoryItem }>(`${BASE}/items`, body),
  /** "Thêm mặt hàng": several new items of one warehouse, all or none. */
  createItems: (warehouse: Warehouse, items: { name: string; variant?: string; code?: string; unit: string; note?: string }[]) =>
    api.post<{ items: InventoryItem[] }>(`${BASE}/items/batch`, { warehouse, items }),
  addFromCatalog: (warehouse: Warehouse) => api.post<{ added: number }>(`${BASE}/items/from-catalog`, { warehouse }),
  updateItem: (id: string, body: { code?: string; unit?: string; lowStockThreshold?: number | null; note?: string }) =>
    api.patch<{ item: InventoryItem }>(`${BASE}/items/${id}`, body),
  removeItem: (id: string) => api.del<{ removed: boolean; archived: boolean }>(`${BASE}/items/${id}`),
  receipts: (p: { branchId?: number; warehouse?: Warehouse } = {}) => api.get<{ receipts: Receipt[] }>(`${BASE}/receipts${query(p)}`),
  createReceipt: (body: { warehouse: Warehouse; requestId: string; receivedAt?: string; reference?: string; note?: string; lines: { itemId: string; quantity: number; note?: string }[] }) =>
    api.post<{ receipt: Receipt; duplicate: boolean }>(`${BASE}/receipts`, body),
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
  mapping: (p: { branchId?: number; warehouse?: Warehouse } = {}) => api.get<{ fields: FormField[] }>(`${BASE}/mapping${query(p)}`),
  mapItem: (id: string, body: { catalogKey: string | null; confirmKit?: boolean }) => api.put<{ item: InventoryItem }>(`${BASE}/items/${id}/mapping`, body),
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
