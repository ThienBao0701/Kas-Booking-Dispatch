import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BedDouble, Building2, Plus, Tags } from 'lucide-react';
import {
  PLATFORM_LABEL,
  adminBranchesApi,
  type AdminBranch,
  type CreateBranchInput,
  type OtaPlatform,
} from '../api/adminBranches';
import { toUserMessage } from '../api/errors';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { ErrorAlert } from '../components/ErrorAlert';
import { Modal } from '../components/Modal';
import { PageHeader, QueryState } from '../components/PageState';
import { RoomClassManager } from '../components/RoomClassManager';
import { Toast } from '../components/Toast';

const inputClass =
  'w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

/** Local mirror of the server's suggestion, so the code appears while typing. */
function suggestCode(address: string): string {
  const tokens = address
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (tokens.length === 0) return '';
  // A house number may be a range ("40-42", "170-172-174"): the whole leading
  // numeric run is the number, and only its first part goes into the code.
  let lead = 0;
  while (lead < tokens.length && /^\d/.test(tokens[lead]!)) lead += 1;
  const idx = lead > 0 ? 0 : tokens.findIndex((t) => /^\d/.test(t));
  const houseNumber = idx >= 0 ? tokens[idx]! : null;
  const words = lead > 0 ? tokens.slice(lead) : tokens.filter((_, i) => i !== idx);
  return [...words, ...(houseNumber ? [houseNumber] : [])].join('_').slice(0, 60);
}

/**
 * Admin-only hotel & branch management: branch numbers, internal names,
 * addresses, breakfast, contact details, activation, and the ONE current hotel
 * name each branch is listed under on every supported platform.
 */
export function BranchesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AdminBranch | null>(null);
  const [managingAliases, setManagingAliases] = useState<AdminBranch | null>(null);
  const [managingRooms, setManagingRooms] = useState<AdminBranch | null>(null);
  const [confirming, setConfirming] = useState<AdminBranch | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const branches = useQuery({ queryKey: ['admin-branches'], queryFn: () => adminBranchesApi.list() });
  const rows = useMemo(() => branches.data?.branches ?? [], [branches.data]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin-branches'] });
    await queryClient.invalidateQueries({ queryKey: ['branches'] });
  };

  // Keep the open dialogs pointed at fresh data after every mutation.
  useEffect(() => {
    const sync = (b: AdminBranch | null) => (b ? (rows.find((r) => r.id === b.id) ?? b) : null);
    setEditing((prev) => sync(prev));
    setManagingAliases((prev) => sync(prev));
    setConfirming((prev) => sync(prev));
  }, [rows]);

  return (
    <div>
      <PageHeader
        title="Quản lý khách sạn & chi nhánh"
        description="Số chi nhánh, tên nội bộ, địa chỉ, ăn sáng và tên khách sạn trên Booking.com / Agoda."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Thêm khách sạn / chi nhánh
          </Button>
        }
      />

      <QueryState isLoading={branches.isLoading} isError={branches.isError} error={branches.error}>
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Danh sách khách sạn và chi nhánh</caption>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th scope="col" className="px-4 py-3">Số CN</th>
                  <th scope="col" className="px-4 py-3">Tên nội bộ</th>
                  <th scope="col" className="px-4 py-3">Địa chỉ</th>
                  <th scope="col" className="px-4 py-3">Mã chi nhánh</th>
                  <th scope="col" className="px-4 py-3">Tên trên nền tảng</th>
                  <th scope="col" className="px-4 py-3">Ăn sáng</th>
                  <th scope="col" className="px-4 py-3">Lễ tân</th>
                  <th scope="col" className="px-4 py-3">Trạng thái</th>
                  <th scope="col" className="px-4 py-3 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id} className="border-b border-slate-100 align-top last:border-b-0">
                    <td className="px-4 py-3 font-semibold text-slate-800">{b.branchNumber}</td>
                    <td className="px-4 py-3 text-slate-800">{b.hotelName}</td>
                    <td className="px-4 py-3 text-slate-600">{b.address}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">{b.code}</td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      <IdentitySummary branchId={b.id} />
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {b.breakfastIncluded ? 'Có ăn sáng' : 'Không ăn sáng'}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{b.activeReceptionistCount}</td>
                    <td className="px-4 py-3">
                      {b.active ? (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Đang hoạt động</span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">Đã vô hiệu hóa</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="secondary" onClick={() => setEditing(b)}>Chỉnh sửa</Button>
                        <Button variant="secondary" onClick={() => setManagingAliases(b)}>
                          <Tags className="h-4 w-4" aria-hidden="true" />
                          Quản lý tên trên nền tảng
                        </Button>
                        <Button variant="secondary" onClick={() => setManagingRooms(b)}>
                          <BedDouble className="h-4 w-4" aria-hidden="true" />
                          Hạng phòng
                        </Button>
                        <Button
                          variant={b.active ? 'danger' : 'primary'}
                          onClick={() => setConfirming(b)}
                        >
                          {b.active ? 'Vô hiệu hóa' : 'Kích hoạt lại'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-400">
                      Chưa có chi nhánh nào.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      </QueryState>

      <BranchFormModal
        open={createOpen}
        branch={null}
        onClose={() => setCreateOpen(false)}
        onSaved={async (message) => {
          setCreateOpen(false);
          await invalidate();
          setToast(message);
        }}
      />
      <BranchFormModal
        open={editing !== null}
        branch={editing}
        onClose={() => setEditing(null)}
        onSaved={async (message) => {
          setEditing(null);
          await invalidate();
          setToast(message);
        }}
      />
      <IdentityModal
        branch={managingAliases}
        onClose={() => setManagingAliases(null)}
        onChanged={invalidate}
      />
      {managingRooms ? (
        <RoomClassManager
          branchId={managingRooms.id}
          branchLabel={`Chi nhánh ${managingRooms.branchNumber} — ${managingRooms.address}`}
          onClose={() => setManagingRooms(null)}
        />
      ) : null}
      <ActivationModal
        branch={confirming}
        onClose={() => setConfirming(null)}
        onDone={async (message) => {
          setConfirming(null);
          await invalidate();
          setToast(message);
        }}
      />

      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

/**
 * The branch table's platform column: ONLY current names.
 *
 * Superseded names are never shown here — no strikethrough, no disabled rows.
 * The full history lives behind "Lịch sử tên" in the identity modal, so the
 * live list answers exactly one question: what is this branch called right now?
 */
function IdentitySummary({ branchId }: { branchId: number }) {
  const query = useQuery({
    queryKey: ['branch-identities', branchId],
    queryFn: () => adminBranchesApi.identities(branchId),
    staleTime: 30_000,
  });

  if (query.isLoading) return <span className="text-slate-400">Đang tải…</span>;
  if (query.isError) return <span className="text-slate-400">Không tải được tên nền tảng</span>;

  const configured = (query.data?.identities ?? []).filter((i) => i.name !== null);
  if (configured.length === 0) {
    return <span className="italic text-slate-400">Chưa thiết lập</span>;
  }
  return (
    <ul className="space-y-0.5">
      {configured.map((i) => (
        <li key={i.platform}>
          <span className="font-medium text-slate-500">{PLATFORM_LABEL[i.platform]}:</span> {i.name}
          {i.needsConfirmation ? (
            <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
              cần xác nhận
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Add / edit branch                                                   */
/* ------------------------------------------------------------------ */

const EMPTY_FORM: CreateBranchInput = {
  branchNumber: 0,
  hotelName: '',
  address: '',
  code: '',
  breakfastIncluded: false,
  active: true,
  phone: '',
  email: '',
  contactName: '',
  note: '',
};

function BranchFormModal({
  open,
  branch,
  onClose,
  onSaved,
}: {
  open: boolean;
  branch: AdminBranch | null;
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
}) {
  const isEdit = branch !== null;
  const [form, setForm] = useState<CreateBranchInput>(EMPTY_FORM);
  const [codeTouched, setCodeTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCodeTouched(isEdit);
    setForm(
      branch
        ? {
            branchNumber: branch.branchNumber,
            hotelName: branch.hotelName,
            address: branch.address,
            code: branch.code,
            breakfastIncluded: branch.breakfastIncluded,
            active: branch.active,
            phone: branch.phone ?? '',
            email: branch.email ?? '',
            contactName: branch.contactName ?? '',
            note: branch.note ?? '',
          }
        : EMPTY_FORM,
    );
  }, [open, branch, isEdit]);

  const save = useMutation({
    mutationFn: async () => {
      const contact = {
        phone: form.phone || null,
        email: form.email || null,
        contactName: form.contactName || null,
        note: form.note || null,
      };
      if (branch) {
        return adminBranchesApi.update(branch.id, {
          branchNumber: form.branchNumber,
          hotelName: form.hotelName,
          address: form.address,
          breakfastIncluded: form.breakfastIncluded,
          ...contact,
        });
      }
      return adminBranchesApi.create({
        ...form,
        ...contact,
        code: form.code.trim().toUpperCase(),
      });
    },
    onSuccess: () => void onSaved(branch ? 'Đã cập nhật chi nhánh.' : 'Đã tạo chi nhánh mới.'),
  });

  const codeError =
    !isEdit && form.code.length > 0 && !/^[A-Z0-9_]+$/.test(form.code.trim().toUpperCase())
      ? 'Mã chi nhánh chỉ được gồm chữ IN HOA, số và dấu gạch dưới.'
      : null;

  const valid =
    form.branchNumber > 0 &&
    form.hotelName.trim().length > 0 &&
    form.address.trim().length > 0 &&
    (isEdit || (form.code.trim().length >= 3 && !codeError));

  return (
    <Modal
      open={open}
      title={isEdit ? 'Chỉnh sửa chi nhánh' : 'Thêm khách sạn / chi nhánh'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Huỷ</Button>
          <Button onClick={() => save.mutate()} disabled={!valid} loading={save.isPending}>
            {isEdit ? 'Lưu thay đổi' : 'Tạo chi nhánh'}
          </Button>
        </>
      }
    >
      {save.isError ? <div className="mb-3"><ErrorAlert>{toUserMessage(save.error)}</ErrorAlert></div> : null}

      <div className="space-y-3">
        <label className="block text-sm font-medium text-slate-600">
          Số chi nhánh
          <input
            type="number"
            min={1}
            className={`${inputClass} mt-1`}
            value={form.branchNumber || ''}
            onChange={(e) => setForm({ ...form, branchNumber: Number(e.target.value) || 0 })}
          />
        </label>

        <label className="block text-sm font-medium text-slate-600">
          Tên nội bộ
          <input
            className={`${inputClass} mt-1`}
            value={form.hotelName}
            onChange={(e) => setForm({ ...form, hotelName: e.target.value })}
          />
        </label>

        <label className="block text-sm font-medium text-slate-600">
          Địa chỉ
          <input
            className={`${inputClass} mt-1`}
            value={form.address}
            onChange={(e) => {
              const address = e.target.value;
              setForm((prev) => ({
                ...prev,
                address,
                code: codeTouched ? prev.code : suggestCode(address),
              }));
            }}
          />
        </label>

        <label className="block text-sm font-medium text-slate-600">
          Mã chi nhánh (stable code)
          <input
            className={`${inputClass} mt-1 font-mono ${isEdit ? 'bg-slate-100 text-slate-500' : ''}`}
            value={form.code}
            readOnly={isEdit}
            disabled={isEdit}
            onChange={(e) => {
              setCodeTouched(true);
              setForm({ ...form, code: e.target.value.toUpperCase() });
            }}
          />
          <span className="mt-1 block text-xs font-normal text-slate-500">
            {isEdit
              ? 'Mã chi nhánh không thể thay đổi sau khi tạo.'
              : 'Gợi ý tự động từ địa chỉ. Có thể sửa trước khi tạo, sau đó sẽ cố định.'}
          </span>
          {codeError ? <span className="mt-1 block text-xs font-medium text-red-600">{codeError}</span> : null}
        </label>

        <fieldset className="rounded-xl border border-slate-200 px-3 py-2">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Ăn sáng</legend>
          <div className="flex gap-4 py-1 text-sm text-slate-700">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="breakfast"
                checked={form.breakfastIncluded}
                onChange={() => setForm({ ...form, breakfastIncluded: true })}
              />
              Có ăn sáng
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="breakfast"
                checked={!form.breakfastIncluded}
                onChange={() => setForm({ ...form, breakfastIncluded: false })}
              />
              Không ăn sáng
            </label>
          </div>
        </fieldset>

        <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />
          Đang hoạt động
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-600">
            Số điện thoại (tuỳ chọn)
            <input className={`${inputClass} mt-1`} value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </label>
          <label className="block text-sm font-medium text-slate-600">
            Email (tuỳ chọn)
            <input className={`${inputClass} mt-1`} value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="block text-sm font-medium text-slate-600">
            Người phụ trách (tuỳ chọn)
            <input className={`${inputClass} mt-1`} value={form.contactName ?? ''} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
          </label>
          <label className="block text-sm font-medium text-slate-600">
            Ghi chú nội bộ (tuỳ chọn)
            <input className={`${inputClass} mt-1`} value={form.note ?? ''} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
        </div>

        {!isEdit ? (
          <div className="rounded-xl border border-slate-200 p-3 text-sm text-slate-600">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tên khách sạn trên nền tảng</p>
            <p className="mt-1 text-xs text-slate-500">
              Sau khi tạo chi nhánh, dùng “Quản lý tên trên nền tảng” để đặt tên hiện tại cho
              từng nền tảng (Booking.com, Agoda, CTrip, Tripadvisor, Traveloka).
            </p>
          </div>
        ) : null}

        {!isEdit && form.branchNumber > 0 && form.address.trim().length > 0 ? (
          <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-3 text-sm" aria-live="polite">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
              Xem trước
            </p>
            <p className="mt-1 font-medium text-slate-800">Chi nhánh {form.branchNumber}</p>
            <p className="text-slate-700">{form.address}</p>
            <p className="font-mono text-xs text-slate-500">{form.code.trim().toUpperCase()}</p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Platform names                                                      */
/* ------------------------------------------------------------------ */

function IdentityModal({
  branch,
  onClose,
  onChanged,
}: {
  branch: AdminBranch | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<{ platform: OtaPlatform; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<OtaPlatform | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const identities = useQuery({
    queryKey: ['branch-identities', branch?.id],
    queryFn: () => adminBranchesApi.identities(branch!.id),
    enabled: !!branch,
  });

  // Audit history is a SEPARATE query behind a toggle, never merged into the
  // current-name list: the live list must only ever answer "what is this branch
  // called right now?".
  const history = useQuery({
    queryKey: ['branch-identity-history', branch?.id],
    queryFn: () => adminBranchesApi.identityHistory(branch!.id),
    enabled: !!branch && showHistory,
  });

  const refresh = async () => {
    await identities.refetch();
    await onChanged();
  };

  const save = useMutation({
    mutationFn: (vars: { platform: OtaPlatform; name: string }) =>
      adminBranchesApi.setIdentity(branch!.id, vars.platform, vars.name),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (platform: OtaPlatform) => adminBranchesApi.deleteIdentity(branch!.id, platform),
    onSuccess: async () => {
      setConfirmDelete(null);
      await refresh();
    },
  });

  const confirm = useMutation({
    mutationFn: (platform: OtaPlatform) => adminBranchesApi.confirmIdentity(branch!.id, platform),
    onSuccess: refresh,
  });

  if (!branch) return null;

  const rows = identities.data?.identities ?? [];
  const mutationError = save.error ?? remove.error ?? confirm.error;

  return (
    <Modal
      open
      title={`Tên hiện tại theo nền tảng — ${branch.address}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? 'Ẩn lịch sử tên' : 'Lịch sử tên'}
          </Button>
          <Button variant="secondary" onClick={onClose}>Đóng</Button>
        </>
      }
    >
      {mutationError ? (
        <div className="mb-3"><ErrorAlert>{toUserMessage(mutationError)}</ErrorAlert></div>
      ) : null}

      <p className="text-xs text-slate-500">
        Mỗi nền tảng chỉ có MỘT tên hiện tại. Sửa tên sẽ thay thế tên cũ và có hiệu lực ngay
        với các đơn nhập sau đó. Đơn đã gửi vẫn giữ nguyên chi nhánh đã lưu.
      </p>

      <ul className="mt-3 space-y-2" aria-label="Tên khách sạn theo nền tảng">
        {rows.map((row) => (
          <li key={row.platform} className="rounded-xl border border-slate-200 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  {PLATFORM_LABEL[row.platform]}
                </p>
                {editing?.platform === row.platform ? (
                  <input
                    className={`${inputClass} mt-1`}
                    aria-label={`Tên trên ${PLATFORM_LABEL[row.platform]}`}
                    value={editing.value}
                    onChange={(e) => setEditing({ platform: row.platform, value: e.target.value })}
                  />
                ) : row.name ? (
                  <p className="text-sm text-slate-800">{row.name}</p>
                ) : (
                  <p className="text-sm italic text-slate-400">Chưa thiết lập</p>
                )}
                {row.needsConfirmation && editing?.platform !== row.platform ? (
                  <p className="mt-1 text-xs text-amber-700">
                    Tên này được chuyển tự động từ cấu hình cũ — vui lòng kiểm tra và xác nhận.
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                {editing?.platform === row.platform ? (
                  <>
                    <Button variant="secondary" onClick={() => setEditing(null)}>Huỷ</Button>
                    <Button
                      onClick={() => save.mutate({ platform: row.platform, name: editing.value.trim() })}
                      disabled={editing.value.trim().length === 0}
                      loading={save.isPending}
                    >
                      Lưu
                    </Button>
                  </>
                ) : (
                  <>
                    {row.needsConfirmation ? (
                      <Button onClick={() => confirm.mutate(row.platform)} loading={confirm.isPending}>
                        Xác nhận
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      onClick={() => setEditing({ platform: row.platform, value: row.name ?? '' })}
                    >
                      {row.name ? 'Sửa' : 'Thêm'}
                    </Button>
                    {row.name ? (
                      <Button variant="danger" onClick={() => setConfirmDelete(row.platform)}>
                        Xoá
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            </div>

            {confirmDelete === row.platform ? (
              <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                <p className="text-sm text-red-700">
                  Xoá tên này? Đơn nhập sau đó sẽ không còn tự nhận diện chi nhánh từ tên trên
                  {' '}{PLATFORM_LABEL[row.platform]}. Lịch sử tên vẫn được giữ lại.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button variant="secondary" onClick={() => setConfirmDelete(null)}>Huỷ</Button>
                  <Button variant="danger" onClick={() => remove.mutate(row.platform)} loading={remove.isPending}>
                    Xoá tên
                  </Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {showHistory ? (
        <div className="mt-4 rounded-xl border border-slate-200 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Lịch sử tên</p>
          {history.isLoading ? <p className="mt-2 text-sm text-slate-400">Đang tải…</p> : null}
          <ul className="mt-2 space-y-1 text-sm text-slate-600">
            {(history.data?.history ?? []).map((h) => (
              <li key={h.id}>
                <span className="font-medium text-slate-500">{PLATFORM_LABEL[h.platform]}</span>{' '}
                {h.oldValue ? <span className="text-slate-400">{h.oldValue}</span> : null}
                {h.oldValue && h.newValue ? ' → ' : null}
                {h.newValue ?? null}
                <span className="ml-1 text-xs text-slate-400">
                  ({h.action}{h.actor ? ` · ${h.actor.fullName}` : ''})
                </span>
              </li>
            ))}
            {history.data && history.data.history.length === 0 ? (
              <li className="text-slate-400">Chưa có thay đổi nào.</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Activate / deactivate                                               */
/* ------------------------------------------------------------------ */

function ActivationModal({
  branch,
  onClose,
  onDone,
}: {
  branch: AdminBranch | null;
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
}) {
  const deactivating = branch?.active === true;

  const receptionists = useQuery({
    queryKey: ['admin-branch-receptionists', branch?.id],
    queryFn: () => adminBranchesApi.receptionists(branch!.id),
    enabled: branch !== null && deactivating,
  });

  const run = useMutation({
    mutationFn: () => (deactivating ? adminBranchesApi.deactivate(branch!.id) : adminBranchesApi.activate(branch!.id)),
    onSuccess: () =>
      void onDone(deactivating ? 'Đã vô hiệu hóa chi nhánh.' : 'Đã kích hoạt lại chi nhánh.'),
  });

  if (!branch) return null;
  const assigned = receptionists.data?.receptionists ?? [];

  return (
    <Modal
      open
      title={deactivating ? 'Vô hiệu hóa chi nhánh' : 'Kích hoạt lại chi nhánh'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Huỷ</Button>
          <Button variant={deactivating ? 'danger' : 'primary'} onClick={() => run.mutate()} loading={run.isPending}>
            {deactivating ? 'Vô hiệu hóa' : 'Kích hoạt lại'}
          </Button>
        </>
      }
    >
      {run.isError ? <div className="mb-3"><ErrorAlert>{toUserMessage(run.error)}</ErrorAlert></div> : null}

      <p className="text-sm text-slate-600">
        Chi nhánh {branch.branchNumber} — {branch.address}
      </p>

      {deactivating ? (
        <>
          <p className="mt-2 text-sm text-slate-600">
            Chi nhánh sẽ ngừng nhận đơn tự động và không thể chọn cho lễ tân mới. Dữ liệu cũ vẫn được giữ nguyên và Admin vẫn xem được.
          </p>
          {assigned.length > 0 ? (
            <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
              <p className="font-medium">
                Có {assigned.length} tài khoản lễ tân đang thuộc chi nhánh này.
              </p>
              <ul className="mt-1 list-inside list-disc text-xs">
                {assigned.map((u) => (
                  <li key={u.id}>{u.fullName} ({u.username})</li>
                ))}
              </ul>
              <p className="mt-1 text-xs">
                Hệ thống sẽ không tự chuyển các tài khoản này. Sau khi vô hiệu hóa, hãy khoá tài khoản hoặc chuyển sang chi nhánh khác trong mục Quản lý tài khoản.
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-sm text-slate-600">
          Chi nhánh sẽ nhận lại đơn tự động theo các tên khách sạn đang bật.
        </p>
      )}
    </Modal>
  );
}
