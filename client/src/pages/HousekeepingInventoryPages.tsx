/**
 * HOUSEKEEPING WAREHOUSES — the screens, phone first.
 *
 *   Kho Linens / Kho Amenities / Kho đồ dùng, thiết bị   the stock at a glance
 *        (one card per item), the few daily actions on top — "Nhập kho",
 *        "Xuất dùng / Thu hồi" (equipment), "Báo hỏng" — and the rest
 *        (the catalog, the form mapping, the history) one tap further
 *   Kiểm kho                                            the physical count
 *   Tồn kho & Báo hỏng (Admin)                          every branch's stock and
 *        the damage reports to review
 *
 * Every figure is the server's. A save carries its own request key, so a
 * double tap or a retry is the same save — never a second receipt.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Boxes,
  ClipboardCheck,
  FileSpreadsheet,
  History,
  Link2,
  MoreHorizontal,
  PackagePlus,
  Pencil,
  Plus,
  Send,
  Settings2,
  ShieldAlert,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  INVENTORY_KEY,
  STATE_LABELS,
  WAREHOUSE_LABELS,
  WAREHOUSE_STATES,
  inventoryApi,
  inventoryExportUrl,
  newRequestId,
  type DamageReport,
  type DamageStatus,
  type FormField,
  type InventoryItem,
  type Movement,
  type Receipt,
  type StockState,
  type TransferKind,
  type Warehouse,
} from '../api/inventory';
import { branchesApi } from '../api/bookings';
import { toUserMessage } from '../api/errors';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/Button';
import { DataTable, RowAction, type DataColumn } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorAlert } from '../components/ErrorAlert';
import { Input } from '../components/Input';
import { Modal } from '../components/Modal';
import { QueryState } from '../components/PageState';
import { Toast } from '../components/Toast';
import { BranchPicker } from '../components/ReportFilter';
import { Badge, CAPTION, CONTROL, HkHeader, Segmented, type Tone } from '../components/HkManagerUi';
import type { BranchChoice } from '../lib/reportFilter';
import { formatDateTime } from '../lib/format';

const STATE_TEXT: Record<StockState, string> = {
  AVAILABLE: 'text-green-700',
  DIRTY: 'text-amber-700',
  IN_LAUNDRY: 'text-blue-700',
  ISSUED: 'text-blue-700',
  DAMAGED: 'text-red-700',
};

const DESCRIPTIONS: Record<Warehouse, string> = {
  LINEN: 'Đồ vải theo từng loại và cỡ: sẵn dùng, bẩn và hỏng.',
  AMENITY: 'Đồ dùng cho khách, cấp vào phòng khi dọn.',
  EQUIPMENT: 'Dụng cụ, thiết bị buồng phòng: sẵn dùng, đang sử dụng và hỏng.',
};

/** The moves in use: equipment out and back. Linen has no laundry step — clean linen is received. */
const TRANSFER_LABELS: Partial<Record<TransferKind, { label: string; hint: string; from: StockState; to: StockState; icon: typeof Send }>> = {
  STOCK_ISSUE: { label: 'Xuất dùng', hint: 'Lấy dụng cụ ra dùng.', from: 'AVAILABLE', to: 'ISSUED', icon: Send },
  STOCK_RETURN: { label: 'Thu hồi', hint: 'Dụng cụ dùng xong, trả về kho.', from: 'ISSUED', to: 'AVAILABLE', icon: Undo2 },
};
// Equipment goes out and comes back; linen has no laundry step here — clean linen is received ("Nhập kho").
const TRANSFERS_OF: Record<Warehouse, TransferKind[]> = { LINEN: [], AMENITY: [], EQUIPMENT: ['STOCK_ISSUE', 'STOCK_RETURN'] };

const qty = (n: number | undefined) => (n ?? 0).toLocaleString('vi-VN');

/* ------------------------------------------------------------------ *
 * Scope: the manager's own branch, or the Admin's choice
 * ------------------------------------------------------------------ */

function useInventoryScope(allowAll: boolean) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list(), enabled: isAdmin });
  const [choice, setChoice] = useState<BranchChoice>(allowAll ? 'ALL' : null);
  const list = branches.data?.branches ?? [];
  const branchId = isAdmin ? (typeof choice === 'number' ? choice : undefined) : undefined;
  // The manager's branch is its account's: the server never takes one from here.
  const ready = !isAdmin || allowAll || typeof choice === 'number';
  const picker: ReactNode = isAdmin ? (
    <div className="w-full min-w-0 sm:w-72">
      <p className={CAPTION}>Chi nhánh</p>
      <BranchPicker value={choice} onChange={setChoice} branches={list} allowAll={allowAll} testId="inventory-branch" />
    </div>
  ) : null;
  return { isAdmin, isManager: user?.role === 'HOUSEKEEPING_MANAGER', branchId, ready, picker };
}

function useItems(warehouse: Warehouse | undefined, branchId: number | undefined, enabled = true, includeArchived = false) {
  return useQuery({
    queryKey: [...INVENTORY_KEY, 'items', warehouse ?? 'ALL', branchId ?? null, includeArchived],
    queryFn: () => inventoryApi.items({ warehouse, branchId, includeArchived }),
    enabled,
  });
}

/** "Xuất Excel" — the stock, the damage reports and the count differences of the scope shown. */
function ExportLink({ branchId, warehouse }: { branchId?: number; warehouse?: Warehouse }) {
  return (
    <a
      href={inventoryExportUrl({ branchId, warehouse })}
      data-testid="inventory-export"
      className="inline-flex min-h-[2.75rem] items-center justify-center gap-2 rounded-xl border border-line-strong bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
    >
      <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
      Xuất Excel
    </a>
  );
}

/** A big, plain choice in a sheet: icon, label, one line saying what it does. */
function SheetButton({ icon: Icon, label, hint, onClick, testId, tone = 'default' }: { icon: typeof Send; label: string; hint?: string; onClick: () => void; testId: string; tone?: 'default' | 'danger' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
        tone === 'danger' ? 'border-red-200 text-red-700' : 'border-line-subtle text-slate-900'
      }`}
    >
      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold">{label}</span>
        {hint ? <span className="block text-xs text-slate-500">{hint}</span> : null}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * One warehouse
 * ------------------------------------------------------------------ */

type Dialog =
  | { kind: 'item'; item?: InventoryItem }
  | { kind: 'receipt' }
  | { kind: 'opening' }
  | { kind: 'mapping' }
  | { kind: 'manage' }
  | { kind: 'actions'; item: InventoryItem }
  | { kind: 'remove'; item: InventoryItem }
  | { kind: 'transfer'; transfer: TransferKind }
  | { kind: 'damage'; item?: InventoryItem }
  | null;

export function WarehousePage({ warehouse }: { warehouse: Warehouse }) {
  const scope = useInventoryScope(false);
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'receipts' | 'movements' | 'damage'>('receipts');
  const [showArchived, setShowArchived] = useState(false);
  const items = useItems(warehouse, scope.branchId, scope.ready, showArchived);
  // The figures and the dialogs read the items in use; archived ones are only listed.
  const listed = items.data?.items ?? [];
  const all = listed.filter((i) => !i.archived);
  const states = WAREHOUSE_STATES[warehouse];
  const term = search.trim().toLowerCase();
  const shown = listed.filter((i) => !term || `${i.label} ${i.code ?? ''}`.toLowerCase().includes(term));
  const totals = Object.fromEntries(states.map((s) => [s, all.reduce((n, i) => n + (i.balances[s] ?? 0), 0)])) as Record<StockState, number>;
  const pending = all.reduce((n, i) => n + i.pendingDamage, 0);
  // Items whose stock was never set up: a room using them cannot be completed yet.
  const unopened = all.filter((i) => !i.opened);
  const manager = scope.isManager;
  const refresh = async (message: string) => {
    await queryClient.invalidateQueries({ queryKey: INVENTORY_KEY });
    setDialog(null);
    setToast(message);
  };
  const fromCatalog = useMutation({
    mutationFn: () => inventoryApi.addFromCatalog(warehouse),
    onSuccess: async ({ added }) => refresh(added > 0 ? `Đã thêm ${added} mặt hàng từ form dọn phòng.` : 'Kho đã có đủ mặt hàng của form dọn phòng.'),
  });

  return (
    <div>
      <HkHeader title={WAREHOUSE_LABELS[warehouse]} description={DESCRIPTIONS[warehouse]} actions={manager ? undefined : scope.picker} />
      {!scope.ready ? (
        <EmptyState icon={<Boxes className="h-6 w-6" aria-hidden="true" />} title="Chọn chi nhánh" message="Chọn một chi nhánh để xem kho." />
      ) : (
        <div className="space-y-4">
          {/* The daily actions — big, on top. */}
          {manager ? (
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" data-testid="inventory-actions">
              <Button onClick={() => setDialog({ kind: 'receipt' })} className="min-h-[2.75rem]" data-testid="inventory-receive-open">
                <PackagePlus className="h-4 w-4" aria-hidden="true" />
                Nhập kho
              </Button>
              {TRANSFERS_OF[warehouse].map((t) => {
                const rule = TRANSFER_LABELS[t]!;
                const Icon = rule.icon;
                return (
                  <Button key={t} variant="secondary" className="min-h-[2.75rem]" onClick={() => setDialog({ kind: 'transfer', transfer: t })} data-testid={`inventory-transfer-${t}`}>
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {rule.label}
                  </Button>
                );
              })}
              <Button variant="secondary" className="min-h-[2.75rem]" onClick={() => setDialog({ kind: 'damage' })} data-testid="inventory-damage-open">
                <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                Báo hỏng
              </Button>
            </div>
          ) : null}

          {unopened.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3" data-testid="inventory-unopened">
              <p className="min-w-0 text-sm text-amber-900">
                <b>{unopened.length} mặt hàng chưa khai báo tồn đầu kỳ</b> — phòng dùng chúng chưa “Hoàn thành” được.
              </p>
              {manager ? (
                <Button variant="secondary" onClick={() => setDialog({ kind: 'opening' })} data-testid="inventory-opening-open">
                  Khai báo tồn đầu kỳ
                </Button>
              ) : null}
            </div>
          ) : null}

          {/* The totals: one small card per state. */}
          <div className={`grid gap-2 ${states.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`} data-testid="inventory-cards">
            {states.map((s) => (
              <div key={s} className="rounded-xl border border-line-subtle bg-white px-3 py-2.5 text-center" data-testid={`inventory-total-${s}`}>
                <p className="text-xs font-medium text-slate-600">{STATE_LABELS[s]}</p>
                <p className={`text-2xl font-semibold tabular-nums ${STATE_TEXT[s]}`}>{qty(totals[s])}</p>
              </div>
            ))}
          </div>
          {pending > 0 ? (
            <p className="text-sm text-red-700" data-testid="inventory-pending-damage">
              {pending} báo hỏng đang chờ Admin xem.
            </p>
          ) : null}

          {/* The items, one card each. */}
          <section aria-labelledby="inventory-items-title" className="space-y-2">
            <div className="flex items-center gap-2">
              <h2 id="inventory-items-title" className="text-base font-semibold text-slate-900">
                Mặt hàng
              </h2>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm mặt hàng…"
                aria-label="Tìm mặt hàng"
                data-testid="inventory-search"
                className={`${CONTROL} ml-auto w-full max-w-[14rem]`}
              />
            </div>
            <QueryState isLoading={items.isLoading} isError={items.isError} error={items.error} onRetry={() => void items.refetch()}>
              {shown.length === 0 ? (
                <div data-testid="inventory-items">
                  <EmptyState
                    icon={<Boxes className="h-6 w-6" aria-hidden="true" />}
                    title={term ? 'Không có mặt hàng phù hợp' : 'Kho chưa có mặt hàng'}
                    message={term ? 'Thử từ khóa khác.' : manager ? 'Mở “Quản lý danh mục” để thêm mặt hàng.' : 'Chi nhánh chưa thêm mặt hàng nào vào kho này.'}
                  />
                </div>
              ) : (
                <ul className="space-y-2" data-testid="inventory-items">
                  {shown.map((i) => (
                    <ItemCard key={i.id} item={i} states={states} onMore={manager && !i.archived ? () => setDialog({ kind: 'actions', item: i }) : undefined} />
                  ))}
                </ul>
              )}
            </QueryState>
          </section>

          {manager ? (
            <Button variant="secondary" fullWidth className="min-h-[2.75rem]" onClick={() => setDialog({ kind: 'manage' })} data-testid="inventory-manage-open">
              <Settings2 className="h-4 w-4" aria-hidden="true" />
              Quản lý danh mục
            </Button>
          ) : (
            <ExportLink branchId={scope.branchId} warehouse={warehouse} />
          )}

          <details className="rounded-xl border border-line-subtle bg-white" data-testid="inventory-history">
            <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-[15px] font-semibold text-slate-900">
              <History className="h-4 w-4 text-brand-600" aria-hidden="true" />
              Lịch sử kho
            </summary>
            <div className="space-y-3 border-t border-line-subtle p-3">
              <Segmented
                label="Lịch sử kho"
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'receipts', label: 'Nhập kho' },
                  { value: 'movements', label: 'Phát sinh' },
                  { value: 'damage', label: 'Báo hỏng' },
                ]}
                testId="inventory-tabs"
              />
              {tab === 'receipts' ? (
                <ReceiptHistory warehouse={warehouse} branchId={scope.branchId} />
              ) : tab === 'movements' ? (
                <MovementHistory warehouse={warehouse} branchId={scope.branchId} />
              ) : (
                <DamageList warehouse={warehouse} branchId={scope.branchId} />
              )}
            </div>
          </details>
        </div>
      )}

      {dialog?.kind === 'manage' ? (
        <Modal open title="Quản lý danh mục" onClose={() => setDialog(null)}>
          <div className="space-y-2" data-testid="inventory-manage">
            <SheetButton icon={Plus} label="Thêm mặt hàng" hint="Một hoặc nhiều mặt hàng mới, số tồn bắt đầu từ 0." onClick={() => setDialog({ kind: 'item' })} testId="inventory-item-open" />
            {warehouse !== 'EQUIPMENT' ? (
              <>
                <SheetButton
                  icon={Boxes}
                  label="Thêm từ form dọn phòng"
                  hint="Các mặt hàng có trên form dọn phòng mà kho chưa có."
                  onClick={() => fromCatalog.mutate()}
                  testId="inventory-from-catalog"
                />
                <SheetButton
                  icon={Link2}
                  label="Gắn với form dọn phòng"
                  hint="Ô nào trên form trừ kho mặt hàng nào."
                  onClick={() => setDialog({ kind: 'mapping' })}
                  testId="inventory-mapping-open"
                />
              </>
            ) : null}
            <label className="flex items-center gap-3 rounded-xl border border-line-subtle px-4 py-3 text-[15px] text-slate-900">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="h-5 w-5 accent-brand-600"
                data-testid="inventory-show-archived"
              />
              Hiện mặt hàng ngừng sử dụng
            </label>
            <ExportLink warehouse={warehouse} />
            {fromCatalog.isError ? <ErrorAlert>{toUserMessage(fromCatalog.error)}</ErrorAlert> : null}
          </div>
        </Modal>
      ) : null}
      {dialog?.kind === 'actions' ? (
        <Modal open title={dialog.item.label} onClose={() => setDialog(null)}>
          <div className="space-y-2" data-testid="inventory-item-actions">
            <SheetButton icon={Pencil} label="Sửa thông tin" onClick={() => setDialog({ kind: 'item', item: dialog.item })} testId={`inventory-edit-${dialog.item.id}`} />
            <SheetButton icon={ShieldAlert} label="Báo hỏng" onClick={() => setDialog({ kind: 'damage', item: dialog.item })} testId={`inventory-damage-${dialog.item.id}`} />
            <SheetButton icon={Trash2} label="Xóa" tone="danger" onClick={() => setDialog({ kind: 'remove', item: dialog.item })} testId={`inventory-remove-${dialog.item.id}`} />
          </div>
        </Modal>
      ) : null}
      {dialog?.kind === 'remove' ? <RemoveDialog item={dialog.item} onClose={() => setDialog(null)} onDone={refresh} /> : null}
      {dialog?.kind === 'item' ? (
        dialog.item ? (
          <ItemDialog warehouse={warehouse} item={dialog.item} onClose={() => setDialog(null)} onDone={refresh} />
        ) : (
          <NewItemsDialog warehouse={warehouse} onClose={() => setDialog(null)} onDone={refresh} />
        )
      ) : null}
      {dialog?.kind === 'receipt' ? <ReceiptDialog warehouse={warehouse} items={all} onClose={() => setDialog(null)} onDone={refresh} /> : null}
      {dialog?.kind === 'opening' ? <OpeningDialog warehouse={warehouse} items={unopened} onClose={() => setDialog(null)} onDone={refresh} /> : null}
      {dialog?.kind === 'mapping' ? <MappingDialog warehouse={warehouse} items={all} onClose={() => setDialog(null)} onChanged={refresh} /> : null}
      {dialog?.kind === 'transfer' ? <TransferDialog kind={dialog.transfer} items={all} onClose={() => setDialog(null)} onDone={refresh} /> : null}
      {dialog?.kind === 'damage' ? <DamageDialog warehouse={warehouse} items={all} item={dialog.item} onClose={() => setDialog(null)} onDone={refresh} /> : null}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

/** One item: its name, one figure per state, and — for its manager — "⋯". */
function ItemCard({ item: i, states, onMore }: { item: InventoryItem; states: StockState[]; onMore?: () => void }) {
  return (
    <li className={`rounded-xl border bg-white px-4 py-3 ${i.archived ? 'border-line-subtle opacity-70' : 'border-line-subtle'}`} data-testid={`inventory-item-${i.id}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900">{i.label}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            <span>{i.unit}</span>
            {i.archived ? <Badge tone="gray">Ngừng sử dụng</Badge> : !i.opened ? <Badge tone="amber">Chưa khai báo tồn đầu kỳ</Badge> : i.lowStock ? <Badge tone="amber">Sắp hết</Badge> : null}
          </div>
        </div>
        {onMore ? (
          <button
            type="button"
            onClick={onMore}
            aria-label={`Thao tác với ${i.label}`}
            data-testid={`inventory-more-${i.id}`}
            className="-mr-2 -mt-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <dl className={`mt-2 grid gap-2 ${states.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {states.map((s) => (
          <div key={s} className="rounded-lg bg-slate-50 px-2 py-1.5 text-center">
            <dt className="text-[11px] text-slate-500">{STATE_LABELS[s]}</dt>
            <dd className={`text-lg font-semibold tabular-nums ${(i.balances[s] ?? 0) > 0 ? STATE_TEXT[s] : 'text-slate-400'}`}>{qty(i.balances[s])}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Dialogs
 * ------------------------------------------------------------------ */

function RemoveDialog({ item, onClose, onDone }: { item: InventoryItem; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const remove = useMutation({
    mutationFn: () => inventoryApi.removeItem(item.id),
    onSuccess: async ({ removed }) => onDone(removed ? 'Đã xóa mặt hàng.' : 'Mặt hàng đã có lịch sử — đã chuyển sang “Ngừng sử dụng”.'),
  });
  return (
    <Modal
      open
      title={`Xóa ${item.label}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>
            Hủy
          </Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()} data-testid="inventory-remove-confirm">
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Xóa
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-700">Mặt hàng đã từng nhập, xuất hay kiểm kho sẽ chỉ chuyển sang “Ngừng sử dụng” — lịch sử được giữ.</p>
      {remove.isError ? (
        <div className="mt-3">
          <ErrorAlert>{toUserMessage(remove.error)}</ErrorAlert>
        </div>
      ) : null}
    </Modal>
  );
}

/**
 * "Thêm mặt hàng" — or "Sửa thông tin": the unit and the "sắp hết" level (the
 * code and a note under "Thêm thông tin"). The name and size are what the stock
 * IS, so an existing item keeps them.
 */
function ItemDialog({ warehouse, item, onClose, onDone }: { warehouse: Warehouse; item?: InventoryItem; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [name, setName] = useState(item?.name ?? '');
  const [variant, setVariant] = useState(item?.variant ?? '');
  const [code, setCode] = useState(item?.code ?? '');
  const [unit, setUnit] = useState(item?.unit ?? 'cái');
  const [threshold, setThreshold] = useState(item?.lowStockThreshold === null || item?.lowStockThreshold === undefined ? '' : String(item.lowStockThreshold));
  const [note, setNote] = useState(item?.note ?? '');
  const save = useMutation({
    mutationFn: () =>
      item
        ? inventoryApi.updateItem(item.id, { code: code.trim(), unit: unit.trim(), lowStockThreshold: threshold.trim() ? Number(threshold) : null, note: note.trim() })
        : inventoryApi.createItem({
            warehouse,
            name: name.trim(),
            variant: variant.trim() || undefined,
            code: code.trim() || undefined,
            unit: unit.trim(),
            lowStockThreshold: threshold.trim() ? Number(threshold) : null,
            note: note.trim() || undefined,
          }),
    onSuccess: ({ item: saved }) => onDone(item ? `Đã lưu ${saved.label}.` : `Đã thêm ${saved.label}.`),
  });
  const ready = name.trim().length > 0 && unit.trim().length > 0;
  return (
    <Modal
      open
      title={item ? `Sửa ${item.label}` : `Thêm mặt hàng — ${WAREHOUSE_LABELS[warehouse]}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Hủy
          </Button>
          <Button onClick={() => save.mutate()} disabled={!ready} loading={save.isPending} data-testid="inventory-item-save">
            Lưu
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Tên mặt hàng" value={name} disabled={Boolean(item)} onChange={(e) => setName(e.target.value)} data-testid="inventory-item-name" />
        <Input
          label="Cỡ / loại (nếu có)"
          value={variant}
          disabled={Boolean(item)}
          onChange={(e) => setVariant(e.target.value)}
          placeholder="VD: King"
          data-testid="inventory-item-variant"
        />
        <Input label="Đơn vị tính" value={unit} onChange={(e) => setUnit(e.target.value)} data-testid="inventory-item-unit" />
        <Input
          label="Báo sắp hết khi còn (nếu cần)"
          inputMode="numeric"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value.replace(/\D/g, ''))}
          data-testid="inventory-item-threshold"
        />
      </div>
      <details className="mt-3" open={Boolean(item?.code || item?.note)}>
        <summary className="cursor-pointer text-sm font-medium text-slate-600">Thêm thông tin (mã, ghi chú)</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <Input label="Mã mặt hàng" value={code} onChange={(e) => setCode(e.target.value)} data-testid="inventory-item-code" />
          <Input label="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} data-testid="inventory-item-note" />
        </div>
      </details>
      {save.isError ? (
        <div className="mt-3">
          <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert>
        </div>
      ) : null}
    </Modal>
  );
}

/** One new item as typed. */
interface NewItemRow {
  key: number;
  name: string;
  variant: string;
  unit: string;
  code: string;
  note: string;
}

const VARIANT_HINT: Record<Warehouse, string> = { LINEN: 'VD: King, Queen, Twin', AMENITY: 'VD: 30ml', EQUIPMENT: 'VD: loại lớn' };
const blankItem = (key: number): NewItemRow => ({ key, name: '', variant: '', unit: 'cái', code: '', note: '' });

/**
 * "THÊM MẶT HÀNG" — as many new items as needed, one card each, saved once:
 * all or none. A size (King / Queen / Twin) is its own item. The stock of each
 * starts at zero; the quantities come with "Nhập kho".
 */
function NewItemsDialog({ warehouse, onClose, onDone }: { warehouse: Warehouse; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [rows, setRows] = useState<NewItemRow[]>([blankItem(1)]);
  const set = (key: number, patch: Partial<NewItemRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const filled = rows.filter((r) => r.name.trim() || r.variant.trim() || r.code.trim() || r.note.trim());
  const ready = filled.length > 0 && filled.every((r) => r.name.trim() && r.unit.trim());
  const save = useMutation({
    mutationFn: () =>
      inventoryApi.createItems(
        warehouse,
        filled.map((r) => ({
          name: r.name.trim(),
          variant: r.variant.trim() || undefined,
          unit: r.unit.trim(),
          code: r.code.trim() || undefined,
          note: r.note.trim() || undefined,
        })),
      ),
    onSuccess: ({ items }) => onDone(items.length === 1 ? `Đã thêm ${items[0]!.label}.` : `Đã thêm ${items.length} mặt hàng.`),
  });
  return (
    <Modal
      open
      title={`Thêm mặt hàng — ${WAREHOUSE_LABELS[warehouse]}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Hủy
          </Button>
          <Button onClick={() => save.mutate()} disabled={!ready || save.isPending} loading={save.isPending} data-testid="inventory-items-save">
            Lưu {filled.length > 0 ? `${filled.length} mặt hàng` : ''}
          </Button>
        </>
      }
    >
      <ul className="space-y-3" data-testid="inventory-new-items">
        {rows.map((r, i) => (
          <li key={r.key} className="space-y-2 rounded-xl border border-line-subtle bg-white p-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-700">Mặt hàng {i + 1}</span>
              {rows.length > 1 ? (
                <button
                  type="button"
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-red-700"
                  aria-label={`Bỏ mặt hàng ${i + 1}`}
                  data-testid={`inventory-new-remove-${i}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input label="Tên mặt hàng" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} data-testid={`inventory-new-name-${i}`} />
              <Input
                label="Cỡ / loại (nếu có)"
                value={r.variant}
                onChange={(e) => set(r.key, { variant: e.target.value })}
                placeholder={VARIANT_HINT[warehouse]}
                data-testid={`inventory-new-variant-${i}`}
              />
              <Input label="Đơn vị tính" value={r.unit} onChange={(e) => set(r.key, { unit: e.target.value })} data-testid={`inventory-new-unit-${i}`} />
              <Input label="Mã (nếu có)" value={r.code} onChange={(e) => set(r.key, { code: e.target.value })} data-testid={`inventory-new-code-${i}`} />
            </div>
            <Input label="Ghi chú (nếu có)" value={r.note} onChange={(e) => set(r.key, { note: e.target.value })} data-testid={`inventory-new-note-${i}`} />
          </li>
        ))}
      </ul>
      <Button
        variant="secondary"
        className="mt-3 min-h-[2.75rem] w-full"
        onClick={() => setRows((rs) => [...rs, blankItem(Math.max(...rs.map((x) => x.key)) + 1)])}
        data-testid="inventory-new-add"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Thêm dòng
      </Button>
      {save.isError ? (
        <div className="mt-3">
          <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert>
        </div>
      ) : null}
    </Modal>
  );
}

interface Line {
  key: number;
  itemId: string;
  quantity: string;
  note: string;
}

/** Each item of the warehouse once; one already on another line is not offered again. */
function ItemSelect({ items, value, taken, onChange, testId }: { items: InventoryItem[]; value: string; taken: Set<string>; onChange: (id: string) => void; testId: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${CONTROL} w-full`} data-testid={testId} aria-label="Mặt hàng">
      <option value="">— Chọn mặt hàng —</option>
      {items
        .filter((i) => !i.archived && (i.id === value || !taken.has(i.id)))
        .map((i) => (
          <option key={i.id} value={i.id}>
            {i.label} ({i.unit})
          </option>
        ))}
    </select>
  );
}

const nowLocal = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 16);

/** "Nhập kho" — the date and time, then each item with its quantity (and a note if needed). One save. */
function ReceiptDialog({ warehouse, items, onClose, onDone }: { warehouse: Warehouse; items: InventoryItem[]; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [requestId] = useState(newRequestId);
  const [receivedAt, setReceivedAt] = useState(nowLocal);
  const [lines, setLines] = useState<Line[]>([{ key: 1, itemId: '', quantity: '', note: '' }]);
  const set = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const filled = lines.filter((l) => l.itemId);
  const taken = new Set(filled.map((l) => l.itemId));
  const problems = filled.filter((l) => !/^\d+$/.test(l.quantity) || Number(l.quantity) < 1);
  const ready = filled.length > 0 && problems.length === 0;
  const save = useMutation({
    mutationFn: () =>
      inventoryApi.createReceipt({
        warehouse,
        requestId,
        // The wall clock in Asia/Ho_Chi_Minh, as an instant.
        receivedAt: new Date(`${receivedAt}:00+07:00`).toISOString(),
        lines: filled.map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), note: l.note.trim() || undefined })),
      }),
    onSuccess: ({ receipt }) => onDone(`Đã nhập kho ${receipt.lines.length} mặt hàng.`),
  });
  return (
    <Modal
      open
      size="xl"
      title={`Nhập kho — ${WAREHOUSE_LABELS[warehouse]}`}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-sm text-slate-600" data-testid="receipt-count">
            {filled.length} mặt hàng
          </span>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Hủy
          </Button>
          <Button onClick={() => save.mutate()} disabled={!ready} loading={save.isPending} data-testid="receipt-save">
            Lưu phiếu nhập
          </Button>
        </>
      }
    >
      <Input label="Ngày giờ nhập hàng" type="datetime-local" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} data-testid="receipt-at" />
      <div className="mt-4 space-y-3" data-testid="receipt-lines">
        {lines.map((l, i) => {
          const item = items.find((x) => x.id === l.itemId);
          const bad = Boolean(l.itemId) && (!/^\d+$/.test(l.quantity) || Number(l.quantity) < 1);
          return (
            <div key={l.key} className="space-y-2 rounded-xl border border-line-subtle p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-700">Mặt hàng {i + 1}</span>
                <button
                  type="button"
                  onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [{ key: l.key + 1, itemId: '', quantity: '', note: '' }]))}
                  className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-red-700"
                  aria-label="Bỏ dòng này"
                  data-testid={`receipt-remove-${i}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <ItemSelect items={items} value={l.itemId} taken={taken} onChange={(id) => set(l.key, { itemId: id })} testId={`receipt-item-${i}`} />
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
                <input
                  inputMode="numeric"
                  value={l.quantity}
                  onChange={(e) => set(l.key, { quantity: e.target.value.replace(/\D/g, '') })}
                  placeholder={item ? `Số lượng (${item.unit})` : 'Số lượng'}
                  aria-label="Số lượng"
                  aria-invalid={bad ? true : undefined}
                  data-testid={`receipt-qty-${i}`}
                  className={`${CONTROL} w-full text-right tabular-nums ${bad ? 'border-red-400' : ''}`}
                />
                <input value={l.note} onChange={(e) => set(l.key, { note: e.target.value })} placeholder="Ghi chú (nếu có)" aria-label="Ghi chú" className={`${CONTROL} w-full`} />
              </div>
            </div>
          );
        })}
        <Button
          variant="ghost"
          onClick={() => setLines((ls) => [...ls, { key: Math.max(...ls.map((x) => x.key)) + 1, itemId: '', quantity: '', note: '' }])}
          data-testid="receipt-add-line"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Thêm mặt hàng
        </Button>
      </div>
      {problems.length > 0 ? <p className="mt-2 text-sm text-red-700">Nhập số lượng (từ 1) cho mọi mặt hàng đã chọn.</p> : null}
      {save.isError ? (
        <div className="mt-3">
          <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert>
        </div>
      ) : null}
    </Modal>
  );
}

/** "Xuất dùng", "Thu hồi" — the same pieces change state. */
function TransferDialog({ kind, items, onClose, onDone }: { kind: TransferKind; items: InventoryItem[]; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const rule = TRANSFER_LABELS[kind]!;
  const [requestId] = useState(newRequestId);
  const sources = items.filter((i) => !i.archived && (i.balances[rule.from] ?? 0) > 0);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const chosen = sources.filter((i) => Number(counts[i.id] || 0) > 0);
  const over = chosen.filter((i) => Number(counts[i.id]) > (i.balances[rule.from] ?? 0));
  const save = useMutation({
    mutationFn: () => inventoryApi.transfer({ kind, requestId, lines: chosen.map((i) => ({ itemId: i.id, quantity: Number(counts[i.id]) })) }),
    onSuccess: () => onDone(`Đã ghi “${rule.label}”: ${chosen.length} mặt hàng.`),
  });
  return (
    <Modal
      open
      title={rule.label}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Hủy
          </Button>
          <Button onClick={() => save.mutate()} disabled={chosen.length === 0 || over.length > 0} loading={save.isPending} data-testid="transfer-save">
            Lưu
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600">{rule.hint}</p>
      {sources.length === 0 ? (
        <p className="text-sm text-slate-600">Không có đồ nào “{STATE_LABELS[rule.from]}”.</p>
      ) : (
        <ul className="divide-y divide-line-subtle" data-testid="transfer-lines">
          {sources.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="min-w-0 text-sm">
                <span className="font-medium text-slate-900">{i.label}</span>
                <span className="block text-xs text-slate-500">
                  {STATE_LABELS[rule.from]}: {qty(i.balances[rule.from])} {i.unit}
                </span>
              </span>
              <input
                inputMode="numeric"
                value={counts[i.id] ?? ''}
                onChange={(e) => setCounts((c) => ({ ...c, [i.id]: e.target.value.replace(/\D/g, '') }))}
                aria-label={`Số lượng ${i.label}`}
                data-testid={`transfer-qty-${i.id}`}
                className={`${CONTROL} w-24 text-right tabular-nums ${over.includes(i) ? 'border-red-400' : ''}`}
              />
            </li>
          ))}
        </ul>
      )}
      {over.length > 0 ? <p className="mt-2 text-sm text-red-700">Số lượng vượt quá số đang có.</p> : null}
      {save.isError ? (
        <div className="mt-3">
          <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert>
        </div>
      ) : null}
    </Modal>
  );
}

/** "Báo hỏng / Không thể tái sử dụng" — out of the usable stock at once, the Admin told. */
function DamageDialog({ warehouse, items, item, onClose, onDone }: { warehouse: Warehouse; items: InventoryItem[]; item?: InventoryItem; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [requestId] = useState(newRequestId);
  const [itemId, setItemId] = useState(item?.id ?? '');
  const states = WAREHOUSE_STATES[warehouse].filter((s) => s !== 'DAMAGED');
  const [fromState, setFromState] = useState<StockState>('AVAILABLE');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [roomNumber, setRoomNumber] = useState('');
  // OPTIONAL SOURCES — this branch's recent work items and incidents, of the room typed.
  const [taskId, setTaskId] = useState('');
  const [issueId, setIssueId] = useState('');
  const room = roomNumber.trim();
  const sources = useQuery({ queryKey: [...INVENTORY_KEY, 'damage-sources', room], queryFn: () => inventoryApi.damageSources(room || undefined) });
  const chosen = items.find((i) => i.id === itemId);
  const have = chosen?.balances[fromState] ?? 0;
  const n = Number(quantity || 0);
  const ready = Boolean(chosen) && n >= 1 && n <= have && reason.trim().length >= 3;
  const save = useMutation({
    mutationFn: () =>
      inventoryApi.reportDamage({
        itemId,
        quantity: n,
        fromState,
        reason: reason.trim(),
        roomNumber: room || undefined,
        taskId: taskId || undefined,
        issueId: issueId || undefined,
        requestId,
      }),
    onSuccess: ({ report }) => onDone(`Đã báo hỏng ${report.quantity} ${report.unit} ${report.label} — đã gửi Admin.`),
  });
  return (
    <Modal
      open
      title="Báo hỏng / Không thể tái sử dụng"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Hủy
          </Button>
          <Button variant="danger" onClick={() => save.mutate()} disabled={!ready} loading={save.isPending} data-testid="damage-save">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            Gửi báo hỏng
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className={CAPTION}>Mặt hàng</span>
          <ItemSelect items={items} value={itemId} taken={new Set()} onChange={setItemId} testId="damage-item" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          {states.length > 1 ? (
            <label className="block">
              <span className={CAPTION}>Lấy từ</span>
              <select value={fromState} onChange={(e) => setFromState(e.target.value as StockState)} className={`${CONTROL} w-full`} data-testid="damage-from">
                {states.map((s) => (
                  <option key={s} value={s}>
                    {STATE_LABELS[s]}
                    {chosen ? ` (${qty(chosen.balances[s])})` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Input
            label="Số lượng hỏng"
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ''))}
            error={chosen && n > have ? `Chỉ còn ${have} ${chosen.unit}.` : undefined}
            data-testid="damage-quantity"
          />
        </div>
        <label className="block">
          <span className={CAPTION}>Lý do hỏng</span>
          <textarea
            rows={2}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="VD: rách, ố màu không giặt được…"
            data-testid="damage-reason"
            className={`${CONTROL} w-full`}
          />
        </label>
        <details className="rounded-xl border border-line-subtle px-3 py-2" data-testid="damage-links">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">Phòng, công việc, sự cố liên quan (nếu có)</summary>
          <div className="mt-2 space-y-3">
            <Input
              label="Phòng"
              value={roomNumber}
              onChange={(e) => {
                setRoomNumber(e.target.value);
                setTaskId('');
                setIssueId('');
              }}
              data-testid="damage-room"
            />
            <label className="block">
              <span className={CAPTION}>Công việc buồng phòng</span>
              <select value={taskId} onChange={(e) => setTaskId(e.target.value)} className={`${CONTROL} w-full`} data-testid="damage-task">
                <option value="">— Không liên kết —</option>
                {(sources.data?.tasks ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={CAPTION}>Sự cố kỹ thuật</span>
              <select value={issueId} onChange={(e) => setIssueId(e.target.value)} className={`${CONTROL} w-full`} data-testid="damage-issue">
                <option value="">— Không liên kết —</option>
                {(sources.data?.issues ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label} · {i.statusLabel}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
      </div>
      {save.isError ? (
        <div className="mt-3">
          <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert>
        </div>
      ) : null}
    </Modal>
  );
}

/**
 * "KHAI BÁO TỒN ĐẦU KỲ" — the first, physical count of items with no stock
 * history (0 is an answer too), saved as ONE counted, audited document.
 */
function OpeningDialog({ warehouse, items, onClose, onDone }: { warehouse: Warehouse; items: InventoryItem[]; onClose: () => void; onDone: (m: string) => Promise<void> }) {
  const [requestId] = useState(newRequestId);
  const states = WAREHOUSE_STATES[warehouse].filter((s) => s !== 'DAMAGED');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const key = (itemId: string, state: StockState) => `${itemId}:${state}`;
  const lines = items.flatMap((i) =>
    states
      .filter((s) => counts[key(i.id, s)] !== undefined && counts[key(i.id, s)] !== '')
      .map((s) => ({ itemId: i.id, state: s, systemQuantity: 0, countedQuantity: Number(counts[key(i.id, s)]) })),
  );
  const save = useMutation({
    mutationFn: () => inventoryApi.createCount({ warehouse, requestId, opening: true, lines }),
    onSuccess: ({ count }) => onDone(`Đã khai báo tồn đầu kỳ cho ${new Set(count.lines.map((l) => l.itemId)).size} mặt hàng.`),
  });
  return (
    <Modal
      open
      size="xl"
      title="Khai báo tồn đầu kỳ"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Hủy
          </Button>
          <Button onClick={() => save.mutate()} disabled={lines.length === 0} loading={save.isPending} data-testid="opening-save">
            Lưu
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600">Đếm thực tế rồi nhập số (0 nếu không có). Mỗi mặt hàng chỉ khai báo một lần.</p>
      <ul className="space-y-2" data-testid="opening-lines">
        {items.map((i) => (
          <li key={i.id} className="rounded-xl border border-line-subtle p-3">
            <p className="text-sm font-semibold text-slate-900">
              {i.label} <span className="font-normal text-slate-500">({i.unit})</span>
            </p>
            <div className={`mt-2 grid gap-2 ${states.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {states.map((s) => (
                <label key={s} className="block">
                  <span className="text-xs text-slate-500">{STATE_LABELS[s]}</span>
                  <input
                    inputMode="numeric"
                    value={counts[key(i.id, s)] ?? ''}
                    onChange={(e) => setCounts((c) => ({ ...c, [key(i.id, s)]: e.target.value.replace(/\D/g, '') }))}
                    aria-label={`${i.label} — ${STATE_LABELS[s]}`}
                    data-testid={`opening-${i.id}-${s}`}
                    className={`${CONTROL} w-full text-right tabular-nums`}
                  />
                </label>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {save.isError ? (
        <div className="mt-3">
          <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert>
        </div>
      ) : null}
    </Modal>
  );
}

/**
 * "GẮN VỚI FORM DỌN PHÒNG" — each field of the form and the ONE item it moves.
 * A field with no item moves nothing. A grouped replacement is tied only to an
 * item confirmed to BE that kit.
 */
function MappingDialog({ warehouse, items, onClose, onChanged }: { warehouse: Warehouse; items: InventoryItem[]; onClose: () => void; onChanged: (m: string) => Promise<void> }) {
  const mapping = useQuery({ queryKey: [...INVENTORY_KEY, 'mapping', warehouse], queryFn: () => inventoryApi.mapping({ warehouse }) });
  const queryClient = useQueryClient();
  const [kitOk, setKitOk] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const tie = useMutation({
    mutationFn: async ({ field, itemId }: { field: FormField; itemId: string }) => {
      // Moving a field to another item: untie the old one first (one item per field).
      if (field.item && field.item.id !== itemId) await inventoryApi.mapItem(field.item.id, { catalogKey: null });
      if (itemId) await inventoryApi.mapItem(itemId, { catalogKey: field.catalogKey, confirmKit: field.kit ? true : undefined });
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: INVENTORY_KEY });
    },
    onError: (e) => setError(toUserMessage(e)),
  });
  return (
    <Modal
      open
      size="xl"
      title="Gắn với form dọn phòng"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={() => void onChanged('Đã cập nhật việc gắn với form dọn phòng.')}>
          Xong
        </Button>
      }
    >
      <p className="mb-3 text-sm text-slate-600">Khi phòng “Hoàn thành”, mỗi ô trên form chỉ trừ kho qua mặt hàng được gắn. Ô chưa gắn thì không trừ kho.</p>
      {error ? (
        <div className="mb-3">
          <ErrorAlert>{error}</ErrorAlert>
        </div>
      ) : null}
      <QueryState isLoading={mapping.isLoading} isError={mapping.isError} error={mapping.error} onRetry={() => void mapping.refetch()}>
        <ul className="space-y-2" data-testid="mapping-fields">
          {(mapping.data?.fields ?? []).map((f) => {
            const choices = items.filter((i) => !i.archived && (!f.size || i.variant.trim().toLowerCase() === f.size.toLowerCase()));
            const needsKit = f.kit && !kitOk[f.catalogKey];
            return (
              <li key={f.catalogKey} className="rounded-xl border border-line-subtle p-3" data-testid={`mapping-${f.catalogKey}`}>
                <p className="text-sm font-semibold text-slate-900">{f.field}</p>
                <p className="text-xs text-slate-500">
                  {f.meaningLabel}
                  {f.kit ? ' · Một bộ gồm nhiều món' : ''}
                </p>
                <select
                  value={f.item?.id ?? ''}
                  disabled={tie.isPending || (needsKit && !f.item)}
                  onChange={(e) => tie.mutate({ field: f, itemId: e.target.value })}
                  aria-label={`Mặt hàng cho ${f.field}`}
                  data-testid={`mapping-select-${f.catalogKey}`}
                  className={`${CONTROL} mt-2 w-full`}
                >
                  <option value="">— Chưa gắn: không trừ kho —</option>
                  {choices.map((i) => (
                    <option key={i.id} value={i.id} disabled={needsKit && i.id !== f.item?.id}>
                      {i.label} ({i.unit})
                    </option>
                  ))}
                </select>
                {f.kit ? (
                  <label className="mt-2 flex items-start gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={Boolean(kitOk[f.catalogKey])}
                      onChange={(e) => setKitOk((k) => ({ ...k, [f.catalogKey]: e.target.checked }))}
                      className="mt-0.5 h-4 w-4 accent-brand-600"
                      data-testid={`mapping-kit-${f.catalogKey}`}
                    />
                    Mặt hàng được chọn là trọn bộ “{f.field.replace(/^✓ /, '')}” — mỗi ô ✓ trừ 1 bộ.
                  </label>
                ) : null}
              </li>
            );
          })}
        </ul>
      </QueryState>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

function ReceiptHistory({ warehouse, branchId, showBranch = false }: { warehouse?: Warehouse; branchId?: number; showBranch?: boolean }) {
  const receipts = useQuery({ queryKey: [...INVENTORY_KEY, 'receipts', warehouse ?? 'ALL', branchId ?? null], queryFn: () => inventoryApi.receipts({ warehouse, branchId }) });
  return (
    <DataTable
      title="Nhập kho gần đây"
      testId="inventory-receipts"
      columns={[
        { key: 'at', header: 'Nhập lúc', className: 'w-[1%] whitespace-nowrap', render: (r) => formatDateTime(r.receivedAt) },
        ...(showBranch ? [{ key: 'branch', header: 'Chi nhánh', render: (r: Receipt) => r.branch?.address ?? '—' }] : []),
        { key: 'lines', header: 'Mặt hàng', render: (r) => r.lines.map((l) => `${l.label} × ${qty(l.quantity)}`).join(', ') },
        { key: 'by', header: 'Người nhập', secondary: true, render: (r) => r.createdBy.name },
      ]}
      rows={receipts.data?.receipts ?? []}
      rowKey={(r) => r.id}
      isLoading={receipts.isLoading}
      isError={receipts.isError}
      error={receipts.error}
      onRetry={() => void receipts.refetch()}
      emptyTitle="Chưa nhập kho lần nào"
      emptyMessage="Các lần nhập kho sẽ hiện ở đây."
    />
  );
}

function MovementHistory({ warehouse, branchId, showBranch = false }: { warehouse?: Warehouse; branchId?: number; showBranch?: boolean }) {
  const moves = useQuery({ queryKey: [...INVENTORY_KEY, 'movements', warehouse ?? 'ALL', branchId ?? null], queryFn: () => inventoryApi.movements({ warehouse, branchId }) });
  return (
    <DataTable
      title="Phát sinh"
      testId="inventory-movements"
      columns={[
        { key: 'at', header: 'Lúc', className: 'w-[1%] whitespace-nowrap', render: (m) => formatDateTime(m.createdAt) },
        ...(showBranch ? [{ key: 'branch', header: 'Chi nhánh', secondary: true, render: (m: Movement) => m.branch.address }] : []),
        { key: 'item', header: 'Mặt hàng', render: (m) => `${m.label} · ${m.typeLabel}` },
        {
          key: 'delta',
          header: 'Thay đổi',
          align: 'right',
          className: 'w-[1%] whitespace-nowrap',
          render: (m) => (
            <span className={`tabular-nums ${m.delta > 0 ? 'text-green-700' : 'text-red-700'}`}>
              {m.delta > 0 ? '+' : ''}
              {qty(m.delta)} {m.stateLabel.toLowerCase()}
            </span>
          ),
        },
        {
          key: 'source',
          header: 'Ghi chú',
          secondary: true,
          render: (m) => [m.roomNumber ? `Phòng ${m.roomNumber}` : null, m.reason, m.actor.name].filter(Boolean).join(' · '),
        },
      ]}
      rows={moves.data?.movements ?? []}
      rowKey={(m) => m.id}
      isLoading={moves.isLoading}
      isError={moves.isError}
      error={moves.error}
      onRetry={() => void moves.refetch()}
      emptyTitle="Chưa có phát sinh"
      emptyMessage="Nhập kho, cấp cho phòng, thu đồ bẩn, kiểm kho và báo hỏng đều được ghi ở đây."
    />
  );
}

const DAMAGE_TONE: Record<DamageReport['status'], Tone> = { PENDING: 'amber', ACKNOWLEDGED: 'green', REJECTED: 'gray' };

function DamageList({
  warehouse,
  branchId,
  showBranch = false,
  onReview,
  filters = false,
}: {
  warehouse?: Warehouse;
  branchId?: number;
  showBranch?: boolean;
  onReview?: (r: DamageReport) => void;
  /** The Admin's filters: warehouse, status, item and period. */
  filters?: boolean;
}) {
  const [w, setW] = useState<Warehouse | ''>('');
  const [status, setStatus] = useState<DamageStatus | ''>('');
  const [itemId, setItemId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const chosenWarehouse = warehouse ?? (w || undefined);
  const params = { warehouse: chosenWarehouse, branchId, status: status || undefined, itemId: itemId || undefined, from: from || undefined, to: to || undefined };
  const reports = useQuery({ queryKey: [...INVENTORY_KEY, 'damage', params], queryFn: () => inventoryApi.damage(params) });
  const itemChoices = useItems(chosenWarehouse, branchId, filters, true);
  const columns: DataColumn<DamageReport>[] = [
    { key: 'at', header: 'Báo lúc', className: 'w-[1%] whitespace-nowrap', render: (r) => formatDateTime(r.reportedAt) },
    ...(showBranch ? [{ key: 'branch', header: 'Chi nhánh', secondary: true, render: (r: DamageReport) => r.branch.address }] : []),
    { key: 'item', header: 'Mặt hàng', render: (r) => `${r.label} × ${qty(r.quantity)}` },
    { key: 'reason', header: 'Lý do', secondary: true, render: (r) => [r.reason, r.roomNumber ? `Phòng ${r.roomNumber}` : null].filter(Boolean).join(' · ') },
    { key: 'status', header: 'Trạng thái', render: (r) => <Badge tone={DAMAGE_TONE[r.status]}>{r.statusLabel}</Badge> },
  ];
  return (
    <DataTable
      title="Báo hỏng"
      testId="inventory-damage"
      columns={columns}
      rows={reports.data?.reports ?? []}
      rowKey={(r) => r.id}
      isLoading={reports.isLoading}
      isError={reports.isError}
      error={reports.error}
      onRetry={() => void reports.refetch()}
      emptyTitle="Chưa có báo hỏng"
      emptyMessage="Đồ hỏng, không thể tái sử dụng được báo ở đây và gửi Admin xem xét."
      headerAction={
        filters ? (
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap" data-testid="damage-filters">
            <select value={w} onChange={(e) => setW(e.target.value as Warehouse | '')} className={CONTROL} aria-label="Kho" data-testid="damage-filter-warehouse">
              <option value="">Tất cả kho</option>
              {(Object.keys(WAREHOUSE_LABELS) as Warehouse[]).map((k) => (
                <option key={k} value={k}>
                  {WAREHOUSE_LABELS[k]}
                </option>
              ))}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value as DamageStatus | '')} className={CONTROL} aria-label="Trạng thái" data-testid="damage-filter-status">
              <option value="">Mọi trạng thái</option>
              <option value="PENDING">Chờ Admin xem</option>
              <option value="ACKNOWLEDGED">Đã xác nhận</option>
              <option value="REJECTED">Đã từ chối</option>
            </select>
            <select value={itemId} onChange={(e) => setItemId(e.target.value)} className={`${CONTROL} col-span-2`} aria-label="Mặt hàng" data-testid="damage-filter-item">
              <option value="">Mọi mặt hàng</option>
              {(itemChoices.data?.items ?? []).map((i) => (
                <option key={i.id} value={i.id}>
                  {showBranch ? `${i.label} — ${i.branch.address}` : i.label}
                </option>
              ))}
            </select>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={CONTROL} aria-label="Từ ngày" data-testid="damage-filter-from" />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={CONTROL} aria-label="Đến ngày" data-testid="damage-filter-to" />
          </div>
        ) : undefined
      }
      actions={
        onReview
          ? (r) => (
              <RowAction onClick={() => onReview(r)} testId={`damage-review-${r.id}`}>
                {r.status === 'PENDING' ? 'Xem xét' : 'Xem'}
              </RowAction>
            )
          : undefined
      }
    />
  );
}

/* ------------------------------------------------------------------ *
 * "Kiểm kho"
 * ------------------------------------------------------------------ */

interface CountLine {
  key: number;
  itemId: string;
  state: StockState;
  counted: string;
  reason: string;
}

const blankLine = (key: number): CountLine => ({ key, itemId: '', state: 'AVAILABLE', counted: '', reason: '' });

export function StockCountPage() {
  const scope = useInventoryScope(false);
  const queryClient = useQueryClient();
  const [warehouse, setWarehouse] = useState<Warehouse>('LINEN');
  const [requestId, setRequestId] = useState(newRequestId);
  const [lines, setLines] = useState<CountLine[]>([blankLine(1)]);
  const [toast, setToast] = useState<string | null>(null);
  const items = useItems(warehouse, scope.branchId, scope.ready);
  const all = items.data?.items ?? [];
  const states = WAREHOUSE_STATES[warehouse];
  const set = (key: number, patch: Partial<CountLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  // The Admin sees the book and the difference; the Quản lý buồng phòng counts without them (the server keeps both).
  const reconciles = scope.isAdmin;
  const rows = lines.map((l) => {
    const item = all.find((i) => i.id === l.itemId);
    const system = item?.balances[l.state] ?? 0;
    const counted = l.counted === '' ? null : Number(l.counted);
    const difference = !reconciles || counted === null ? null : counted - system;
    return { ...l, item, system, counted, difference, needsReason: difference !== null && difference !== 0 && l.reason.trim().length === 0 };
  });
  const filled = rows.filter((r) => r.item && r.counted !== null);
  const pairKeys = filled.map((r) => `${r.itemId}:${r.state}`);
  const duplicate = pairKeys.length !== new Set(pairKeys).size;
  const ready = filled.length > 0 && !duplicate && filled.every((r) => !r.needsReason);
  const reset = (next: Warehouse = warehouse) => {
    setWarehouse(next);
    setLines([blankLine(1)]);
    setRequestId(newRequestId());
  };
  const save = useMutation({
    mutationFn: () =>
      inventoryApi.createCount({
        branchId: scope.branchId,
        warehouse,
        requestId,
        lines: filled.map((r) => ({
          itemId: r.itemId,
          state: r.state,
          ...(reconciles ? { systemQuantity: r.system } : {}),
          countedQuantity: r.counted!,
          reason: r.reason.trim() || undefined,
        })),
      }),
    onSuccess: async ({ count }) => {
      const changed = count.lines.filter((l) => l.difference !== undefined && l.difference !== 0).length;
      await queryClient.invalidateQueries({ queryKey: INVENTORY_KEY });
      reset();
      setToast(
        !reconciles ? 'Đã lưu kiểm kho.' : changed > 0 ? `Đã lưu kiểm kho: ${changed} dòng chênh lệch đã được điều chỉnh.` : 'Đã lưu kiểm kho: số đếm khớp với sổ.',
      );
    },
  });
  return (
    <div>
      <HkHeader
        title="Kiểm kho"
        description={reconciles ? 'Đếm thực tế, so với số trên sổ. Có chênh lệch thì ghi lý do.' : 'Đếm thực tế từng mặt hàng rồi lưu. Dòng nào lệch với sổ, hệ thống sẽ yêu cầu ghi lý do.'}
        actions={scope.picker}
      />
      {!scope.ready ? (
        <EmptyState icon={<ClipboardCheck className="h-6 w-6" aria-hidden="true" />} title="Chọn chi nhánh" message="Chọn một chi nhánh để kiểm kho." />
      ) : (
        <div className="space-y-4" data-testid="count-form">
          <Segmented
            label="Kho"
            value={warehouse}
            onChange={(w) => reset(w)}
            options={(Object.keys(WAREHOUSE_LABELS) as Warehouse[]).map((w) => ({ value: w, label: WAREHOUSE_LABELS[w].replace('Kho ', '') }))}
            testId="count-warehouse"
          />
          <ul className="space-y-3">
            {rows.map((r, i) => (
              <li key={r.key} className="space-y-2 rounded-xl border border-line-subtle bg-white p-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-700">Mặt hàng {i + 1}</span>
                  {lines.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== r.key))}
                      className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-red-700"
                      aria-label="Bỏ dòng này"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                <ItemSelect items={all} value={r.itemId} taken={new Set()} onChange={(id) => set(r.key, { itemId: id })} testId={`count-item-${i}`} />
                {states.length > 1 ? (
                  <select value={r.state} onChange={(e) => set(r.key, { state: e.target.value as StockState })} className={`${CONTROL} w-full`} data-testid={`count-state-${i}`} aria-label="Trạng thái">
                    {states.map((s) => (
                      <option key={s} value={s}>
                        {STATE_LABELS[s]}
                      </option>
                    ))}
                  </select>
                ) : null}
                {!reconciles ? (
                  <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-end gap-2">
                    <label className="block text-center">
                      <span className="text-xs text-slate-500">Đếm được</span>
                      <input
                        inputMode="numeric"
                        value={r.counted ?? ''}
                        onChange={(e) => set(r.key, { counted: e.target.value.replace(/\D/g, '') })}
                        aria-label="Đếm thực tế"
                        data-testid={`count-counted-${i}`}
                        className={`${CONTROL} w-full text-center tabular-nums`}
                      />
                    </label>
                    <input
                      value={r.reason}
                      onChange={(e) => set(r.key, { reason: e.target.value })}
                      aria-label="Lý do nếu lệch"
                      placeholder="Lý do nếu lệch (nếu có)"
                      data-testid={`count-reason-${i}`}
                      className={`${CONTROL} w-full`}
                    />
                  </div>
                ) : (
                <div className="grid grid-cols-3 items-end gap-2 text-center">
                  <div>
                    <p className="text-xs text-slate-500">Trên sổ</p>
                    <p className="text-lg font-semibold tabular-nums text-slate-900" data-testid={`count-system-${i}`}>
                      {r.item ? qty(r.system) : '—'}
                    </p>
                  </div>
                  <label className="block">
                    <span className="text-xs text-slate-500">Đếm được</span>
                    <input
                      inputMode="numeric"
                      value={r.counted ?? ''}
                      onChange={(e) => set(r.key, { counted: e.target.value.replace(/\D/g, '') })}
                      aria-label="Đếm thực tế"
                      data-testid={`count-counted-${i}`}
                      className={`${CONTROL} w-full text-center tabular-nums`}
                    />
                  </label>
                  <div>
                    <p className="text-xs text-slate-500">Chênh lệch</p>
                    <p
                      className={`text-lg font-semibold tabular-nums ${r.difference ? (r.difference > 0 ? 'text-green-700' : 'text-red-700') : 'text-slate-400'}`}
                      data-testid={`count-diff-${i}`}
                    >
                      {r.difference === null ? '—' : `${r.difference > 0 ? '+' : ''}${qty(r.difference)}`}
                    </p>
                  </div>
                </div>
                )}
                {reconciles && r.difference ? (
                  <input
                    value={r.reason}
                    onChange={(e) => set(r.key, { reason: e.target.value })}
                    aria-label="Lý do chênh lệch"
                    aria-invalid={r.needsReason ? true : undefined}
                    placeholder="Lý do chênh lệch (bắt buộc)"
                    data-testid={`count-reason-${i}`}
                    className={`${CONTROL} w-full ${r.needsReason ? 'border-red-400' : ''}`}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {duplicate ? <p className="text-sm text-red-700">Mỗi mặt hàng (và trạng thái) chỉ đếm một dòng.</p> : null}
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button variant="secondary" className="min-h-[2.75rem]" onClick={() => setLines((ls) => [...ls, blankLine(Math.max(...ls.map((x) => x.key)) + 1)])} data-testid="count-add-line">
              <Plus className="h-4 w-4" aria-hidden="true" />
              Thêm mặt hàng
            </Button>
            <Button className="min-h-[2.75rem]" onClick={() => save.mutate()} disabled={!ready} loading={save.isPending} data-testid="count-save">
              Lưu kiểm kho
            </Button>
          </div>
          {save.isError ? <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert> : null}
          <details className="rounded-xl border border-line-subtle bg-white">
            <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-[15px] font-semibold text-slate-900">
              <History className="h-4 w-4 text-brand-600" aria-hidden="true" />
              Lịch sử kiểm kho
            </summary>
            <div className="border-t border-line-subtle p-3">
              <CountHistory branchId={scope.branchId} reconciles={reconciles} />
            </div>
          </details>
        </div>
      )}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function CountHistory({
  branchId,
  showBranch = false,
  onlyDifferences = false,
  reconciles = true,
}: {
  branchId?: number;
  showBranch?: boolean;
  onlyDifferences?: boolean;
  /** The Admin's view: the book and the difference. A manager's: what was counted. */
  reconciles?: boolean;
}) {
  const counts = useQuery({ queryKey: [...INVENTORY_KEY, 'counts', branchId ?? null, onlyDifferences], queryFn: () => inventoryApi.counts({ branchId, onlyDifferences }) });
  const lines = (counts.data?.counts ?? []).flatMap((c) => c.lines.filter((l) => !onlyDifferences || l.difference !== 0).map((l, i) => ({ ...l, count: c, key: `${c.id}-${i}` })));
  type Row = (typeof lines)[number];
  const columns: DataColumn<Row>[] = [
    { key: 'at', header: 'Kiểm lúc', className: 'w-[1%] whitespace-nowrap', render: (r) => formatDateTime(r.count.createdAt) },
    ...(showBranch ? [{ key: 'branch', header: 'Chi nhánh', secondary: true, render: (r: Row) => r.count.branch.address }] : []),
    { key: 'item', header: 'Mặt hàng', render: (r) => `${r.label} · ${r.stateLabel.toLowerCase()}` },
    reconciles
      ? {
          key: 'diff',
          header: 'Sổ → thực tế',
          align: 'right',
          className: 'w-[1%] whitespace-nowrap',
          render: (r: Row) => (
            <span className="tabular-nums">
              {qty(r.systemQuantity ?? 0)} → {qty(r.countedQuantity)}{' '}
              <span className={r.difference ? (r.difference > 0 ? 'text-green-700' : 'text-red-700') : 'text-slate-500'}>
                ({(r.difference ?? 0) > 0 ? `+${r.difference}` : r.difference})
              </span>
            </span>
          ),
        }
      : { key: 'counted', header: 'Đếm được', align: 'right', className: 'w-[1%] whitespace-nowrap tabular-nums', render: (r: Row) => qty(r.countedQuantity) },
    { key: 'reason', header: 'Lý do', secondary: true, render: (r) => [r.reason, r.count.createdBy.name].filter(Boolean).join(' · ') },
  ];
  return (
    <DataTable
      title={onlyDifferences ? 'Chênh lệch kiểm kho' : 'Lịch sử kiểm kho'}
      testId="count-history"
      columns={columns}
      rows={lines}
      rowKey={(r) => r.key}
      isLoading={counts.isLoading}
      isError={counts.isError}
      error={counts.error}
      onRetry={() => void counts.refetch()}
      emptyTitle="Chưa kiểm kho lần nào"
      emptyMessage="Mỗi lần kiểm kho được lưu ở đây."
    />
  );
}

/* ------------------------------------------------------------------ *
 * Admin — "Tồn kho & Báo hỏng"
 * ------------------------------------------------------------------ */

export function AdminInventoryPage() {
  const scope = useInventoryScope(true);
  const [params, setParams] = useSearchParams();
  const [warehouse, setWarehouse] = useState<Warehouse | 'ALL'>('ALL');
  const [tab, setTab] = useState<'stock' | 'damage' | 'counts' | 'movements'>(params.get('damage') ? 'damage' : 'stock');
  const [reviewing, setReviewing] = useState<DamageReport | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const items = useItems(warehouse === 'ALL' ? undefined : warehouse, scope.branchId);
  const pending = useQuery({ queryKey: [...INVENTORY_KEY, 'damage', 'pending', scope.branchId ?? null], queryFn: () => inventoryApi.damage({ branchId: scope.branchId, status: 'PENDING' }) });
  // A notification's link opens its report.
  const linked = params.get('damage');
  const linkedReport = useMemo(() => (linked ? pending.data?.reports.find((r) => r.id === linked) : undefined), [linked, pending.data]);
  const open = reviewing ?? linkedReport ?? null;
  const all = items.data?.items ?? [];
  const sum = (s: StockState) => all.reduce((n, i) => n + (i.balances[s] ?? 0), 0);
  const pendingCount = pending.data?.reports.length ?? 0;
  const columns: DataColumn<InventoryItem>[] = [
    {
      key: 'item',
      header: 'Mặt hàng',
      render: (i) => (
        <span>
          <span className="font-medium text-slate-900">{i.label}</span>
          <span className="block text-xs text-slate-500">
            {i.branch.address} · {WAREHOUSE_LABELS[i.warehouse].replace('Kho ', '')}
          </span>
        </span>
      ),
    },
    ...(['AVAILABLE', 'DIRTY', 'ISSUED', 'DAMAGED'] as StockState[]).map<DataColumn<InventoryItem>>((s) => ({
      key: s,
      header: STATE_LABELS[s],
      align: 'right',
      secondary: s === 'DIRTY' || s === 'ISSUED',
      className: 'w-[1%] whitespace-nowrap',
      render: (i) => (WAREHOUSE_STATES[i.warehouse].includes(s) ? qty(i.balances[s]) : <span className="text-slate-300">—</span>),
    })),
  ];
  const close = () => {
    setReviewing(null);
    if (linked)
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.delete('damage');
          return n;
        },
        { replace: true },
      );
  };
  return (
    <div>
      <HkHeader
        title="Tồn kho & Báo hỏng"
        description="Tồn kho buồng phòng của mọi chi nhánh và các báo hỏng cần xem xét."
        actions={
          <>
            {scope.picker}
            <ExportLink branchId={scope.branchId} warehouse={warehouse === 'ALL' ? undefined : warehouse} />
          </>
        }
      />
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="admin-inventory-cards">
          {(['AVAILABLE', 'DIRTY', 'ISSUED', 'DAMAGED'] as StockState[]).map((s) => (
            <div key={s} className="rounded-xl border border-line-subtle bg-white px-3 py-2.5 text-center">
              <p className="text-xs font-medium text-slate-600">{STATE_LABELS[s]}</p>
              <p className={`text-2xl font-semibold tabular-nums ${STATE_TEXT[s]}`}>{qty(sum(s))}</p>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setTab('damage')}
            className={`rounded-xl border px-3 py-2.5 text-center ${pendingCount > 0 ? 'border-red-300 bg-red-50' : 'border-line-subtle bg-white'}`}
            data-testid="admin-pending-damage"
          >
            <span className="block text-xs font-medium text-slate-600">Báo hỏng chờ xem</span>
            <span className={`block text-2xl font-semibold tabular-nums ${pendingCount > 0 ? 'text-red-700' : 'text-slate-400'}`}>{pendingCount}</span>
          </button>
        </div>
        <Segmented
          label="Xem"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'stock', label: 'Tồn kho' },
            { value: 'damage', label: 'Báo hỏng' },
            { value: 'counts', label: 'Kiểm kho' },
            { value: 'movements', label: 'Lịch sử' },
          ]}
          testId="admin-inventory-tabs"
        />
        {tab === 'stock' ? (
          <DataTable
            title="Tồn kho"
            testId="admin-inventory-items"
            columns={columns}
            rows={all}
            rowKey={(i) => i.id}
            isLoading={items.isLoading}
            isError={items.isError}
            error={items.error}
            onRetry={() => void items.refetch()}
            emptyTitle="Chưa có mặt hàng"
            emptyMessage="Các chi nhánh chưa thêm mặt hàng vào kho buồng phòng."
            headerAction={
              <select value={warehouse} onChange={(e) => setWarehouse(e.target.value as Warehouse | 'ALL')} className={CONTROL} aria-label="Kho" data-testid="admin-inventory-warehouse">
                <option value="ALL">Tất cả kho</option>
                {(Object.keys(WAREHOUSE_LABELS) as Warehouse[]).map((w) => (
                  <option key={w} value={w}>
                    {WAREHOUSE_LABELS[w]}
                  </option>
                ))}
              </select>
            }
          />
        ) : tab === 'damage' ? (
          <DamageList branchId={scope.branchId} showBranch onReview={setReviewing} filters />
        ) : tab === 'counts' ? (
          <CountHistory branchId={scope.branchId} showBranch onlyDifferences />
        ) : (
          <MovementHistory branchId={scope.branchId} showBranch />
        )}
      </div>
      {open ? (
        <ReviewDialog
          report={open}
          onClose={close}
          onDone={(m) => {
            close();
            setToast(m);
          }}
        />
      ) : null}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

/** The Admin's review — "Xác nhận" keeps the write-off; "Từ chối" returns the quantity, with a reason — or a reviewed report, read. */
function ReviewDialog({ report, onClose, onDone }: { report: DamageReport; onClose: () => void; onDone: (m: string) => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const pending = report.status === 'PENDING';
  const review = useMutation({
    mutationFn: (decision: 'ACKNOWLEDGE' | 'REJECT') => inventoryApi.reviewDamage(report.id, { decision, note: note.trim() || undefined }),
    onSuccess: async ({ report: r }) => {
      await queryClient.invalidateQueries({ queryKey: INVENTORY_KEY });
      onDone(r.status === 'REJECTED' ? 'Đã từ chối báo hỏng — số lượng đã hoàn lại kho.' : 'Đã xác nhận báo hỏng.');
    },
  });
  const row = (label: string, value: ReactNode) => (
    <div className="flex gap-3 border-b border-line-subtle py-2 last:border-0">
      <dt className="w-28 shrink-0 text-sm text-slate-500">{label}</dt>
      <dd className="min-w-0 text-sm text-slate-900">{value}</dd>
    </div>
  );
  return (
    <Modal
      open
      title={`Báo hỏng — ${report.label}`}
      onClose={onClose}
      footer={
        pending ? (
          <>
            <Button variant="secondary" onClick={() => review.mutate('REJECT')} disabled={review.isPending || note.trim().length === 0} data-testid="review-reject">
              Từ chối (hoàn kho)
            </Button>
            <Button onClick={() => review.mutate('ACKNOWLEDGE')} loading={review.isPending} data-testid="review-acknowledge">
              Xác nhận
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Đóng
          </Button>
        )
      }
    >
      <dl data-testid="review-detail">
        {row('Chi nhánh', report.branch.address)}
        {row('Số lượng', `${qty(report.quantity)} ${report.unit} · từ “${report.fromStateLabel}”`)}
        {row('Lý do', `${report.reason}${report.roomNumber ? ` · Phòng ${report.roomNumber}` : ''}`)}
        {row('Người báo', `${report.reportedBy.name} · ${formatDateTime(report.reportedAt)}`)}
        <div data-testid="review-sources">
          {row(
            'Liên quan',
            report.task || report.issue ? (
              <ul className="space-y-0.5">
                {report.task ? <li>Công việc buồng phòng: {report.task.label}</li> : null}
                {report.issue ? (
                  <li>
                    Sự cố kỹ thuật: {report.issue.label} · {report.issue.statusLabel}
                  </li>
                ) : null}
              </ul>
            ) : (
              <span className="text-slate-500">Không liên kết</span>
            ),
          )}
        </div>
      </dl>
      {pending ? (
        <label className="mt-3 block">
          <span className={CAPTION}>Ghi chú (bắt buộc khi từ chối)</span>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={`${CONTROL} w-full`} data-testid="review-note" />
        </label>
      ) : (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700" data-testid="review-outcome">
          {report.statusLabel}
          {report.reviewedBy ? ` · ${report.reviewedBy.name}` : ''}
          {report.reviewedAt ? ` · ${formatDateTime(report.reviewedAt)}` : ''}
          {report.reviewNote ? ` — ${report.reviewNote}` : ''}
        </p>
      )}
      {report.history.length > 0 ? (
        <details className="mt-3" data-testid="review-history" open={!pending}>
          <summary className="cursor-pointer text-sm font-medium text-slate-600">Lịch sử phát sinh</summary>
          <ul className="mt-1 space-y-0.5 text-sm text-slate-700">
            {report.history.map((h, i) => (
              <li key={i}>
                {formatDateTime(h.createdAt)} · {h.typeLabel}: {h.delta > 0 ? '+' : ''}
                {qty(h.delta)} {h.stateLabel.toLowerCase()} (còn {qty(h.balanceAfter)}) · {h.actorNameSnapshot}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {review.isError ? (
        <div className="mt-3">
          <ErrorAlert>{toUserMessage(review.error)}</ErrorAlert>
        </div>
      ) : null}
    </Modal>
  );
}
