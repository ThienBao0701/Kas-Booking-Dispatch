import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, UserPlus } from 'lucide-react';
import {
  adminOverrideApi,
  adminUsersApi,
  type AdminOverrideStatus,
  type CreateUserInput,
  type ManagedUser,
  requiresBranch,
  requiresBranchSet,
  requiresSingleBranchChoice,
} from '../api/adminUsers';
import { branchesApi } from '../api/bookings';
import { branchLabel, type Branch, type UserRole } from '../auth/types';
import { toUserMessage } from '../api/errors';
import { Button } from '../components/Button';
import { DataTable, type DataColumn } from '../components/DataTable';
import { ErrorAlert } from '../components/ErrorAlert';
import { Modal } from '../components/Modal';
import { PageHeader, QueryState } from '../components/PageState';
import { DevToolsPanel } from '../components/DevToolsPanel';
import { formatDateTime } from '../lib/format';
import { CopyButton } from '../components/CopyButton';

const inputClass =
  'w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  /** "Sửa": the account whose name / branches are being changed. */
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  /** "Xóa": the account about to be deleted, after a typed confirmation. */
  const [deleting, setDeleting] = useState<ManagedUser | null>(null);
  /** "Đặt lại mật khẩu": the account getting a new temporary password. */
  const [resetting, setResetting] = useState<ManagedUser | null>(null);

  // Admins included, so the "Admin / Quản trị" section lists them (read-only).
  // Under the ['admin-users'] prefix, so the invalidation below refreshes it.
  const users = useQuery({
    queryKey: ['admin-users', 'with-admins'],
    queryFn: () => adminUsersApi.list({ includeAdmins: true }),
  });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list(), staleTime: 5 * 60_000 });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin-users'] });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      active ? adminUsersApi.disable(id) : adminUsersApi.enable(id),
    onSuccess: () => void invalidate(),
  });

  return (
    <div>
      <PageHeader
        title="Quản lý tài khoản"
        description="Tạo và quản lý tài khoản lễ tân và các bộ phận."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            Thêm bộ phận
          </Button>
        }
      />

      <QueryState isLoading={users.isLoading} isError={users.isError} error={users.error}>
        {/*
          ONE SECTION PER DEPARTMENT. Reception and technical accounts in one
          table meant reading a role on every row to know whose account it was;
          the departments are the roles the system already has, in the order an
          Admin manages them most. Lễ tân, Kỹ thuật and Admin are always there,
          with their counts, so an empty one says so rather than disappearing.
        */}
        <div className="space-y-4">
          {DEPARTMENTS.map((role) => {
            const members = (users.data?.users ?? []).filter((u) => u.role === role);
            // Lễ tân, Kỹ thuật and Admin always; any other department only
            // once it has accounts.
            if (members.length === 0 && !ALWAYS_SHOWN.includes(role)) return null;
            return (
              <DepartmentTable
                key={role}
                role={role}
                users={members}
                togglingId={toggle.isPending ? (toggle.variables?.id ?? null) : null}
                onToggle={(id, active) => toggle.mutate({ id, active })}
                onEdit={setEditing}
                onDelete={setDeleting}
                onResetPassword={setResetting}
              />
            );
          })}
        </div>
      </QueryState>

      {editing ? (
        <EditUserModal
          user={editing}
          branches={branches.data?.branches ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void invalidate();
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteUserModal
          user={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            void invalidate();
          }}
        />
      ) : null}

      {resetting ? (
        <ResetPasswordModal
          user={resetting}
          onClose={() => {
            setResetting(null);
            void invalidate();
          }}
        />
      ) : null}

      <AdminOverridePanel />

      {/* Development-only demo data tools (hidden unless the server enables them). */}
      <DevToolsPanel />

      <CreateUserModal
        open={createOpen}
        branches={branches.data?.branches ?? []}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void invalidate();
        }}
      />
    </div>
  );
}

/**
 * The departments, in the order an Admin manages them. These are the system's
 * own roles — nothing here invents a department that has no accounts behind it.
 */
const DEPARTMENTS: UserRole[] = [
  'RECEPTIONIST',
  'RECEPTION_MANAGER',
  'RECEPTION_GENERAL_MANAGER',
  'HOUSEKEEPING_MANAGER',
  'HOUSEKEEPING',
  'TECHNICAL',
  'TECHNICAL_MANAGER',
  'BOOKING_DEPARTMENT',
  'ADMIN',
];

/** Sections shown even when empty — the departments every property has. */
const ALWAYS_SHOWN: UserRole[] = ['RECEPTIONIST', 'TECHNICAL', 'ADMIN'];

const DEPARTMENT_TITLE: Record<UserRole, string> = {
  RECEPTIONIST: 'Lễ tân',
  RECEPTION_MANAGER: 'Quản lý lễ tân',
  RECEPTION_GENERAL_MANAGER: 'Tổng quản lý lễ tân',
  HOUSEKEEPING: 'Buồng phòng',
  HOUSEKEEPING_MANAGER: 'Quản lý buồng phòng',
  TECHNICAL: 'Kỹ thuật',
  TECHNICAL_MANAGER: 'Quản lý kỹ thuật',
  BOOKING_DEPARTMENT: 'Bộ phận đặt phòng',
  ADMIN: 'Admin / Quản trị',
};

/** "CN 1, 2, 3" — a Quản lý lễ tân's branches, compact. */
function managedLabel(u: ManagedUser): string {
  const branches = u.managedBranches ?? [];
  if (branches.length === 0) return 'Chưa gán chi nhánh';
  return branches.map((b) => (b.branchNumber ? `CN ${b.branchNumber}` : b.address)).join(', ');
}

/**
 * THE BRANCH CHECKBOXES of a Quản lý lễ tân — one per active branch, from the
 * branch table (never a hard-coded eight). Used to create the account and to
 * change its branches later.
 */
function BranchChecklist({
  branches,
  value,
  onChange,
  single = false,
  title = 'Chi nhánh quản lý',
}: {
  branches: Branch[];
  value: number[];
  onChange: (next: number[]) => void;
  /** Quản lý / Bộ phận buồng phòng: ticking a branch replaces the one ticked before. */
  single?: boolean;
  title?: string;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-slate-600">
        {title}{single ? <span className="font-normal text-slate-500"> (chọn đúng một chi nhánh)</span> : null}
      </legend>
      <div className="mt-1 grid gap-1.5 sm:grid-cols-2" data-testid="manager-branches">
        {branches.map((b) => {
          const checked = value.includes(b.id);
          return (
            <label
              key={b.id}
              className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                checked ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-line bg-white text-slate-700'
              }`}
            >
              <input
                type="checkbox"
                className="h-4 w-4 accent-brand-600"
                checked={checked}
                onChange={() =>
                  onChange(checked ? value.filter((id) => id !== b.id) : single ? [b.id] : [...value, b.id])
                }
                data-testid={`manager-branch-${b.id}`}
              />
              {branchLabel(b)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * "SỬA" — what the role carries, and nothing it does not: a receptionist's
 * branch; a Quản lý / Bộ phận buồng phòng's one ticked branch; a Quản lý lễ
 * tân's / Quản lý kỹ thuật's ticked branches; nothing for the global roles
 * (Tổng quản lý lễ tân reads every branch). Scope moves on the next request;
 * records already made stay as they are.
 */
function EditUserModal({
  user,
  branches,
  onClose,
  onSaved,
}: {
  user: ManagedUser;
  branches: Branch[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(user.fullName);
  const [branchId, setBranchId] = useState<number>(user.branch?.id ?? 0);
  const [branchSet, setBranchSet] = useState<number[]>((user.managedBranches ?? []).map((b) => b.id));
  const needsBranch = user.role === 'RECEPTIONIST';
  const needsBranchSet = requiresBranchSet(user.role);
  // Quản lý buồng phòng: one branch, in the checkbox list.
  const single = requiresSingleBranchChoice(user.role);
  const save = useMutation({
    mutationFn: () =>
      adminUsersApi.update(user.id, {
        ...(fullName.trim() !== user.fullName ? { fullName: fullName.trim() } : {}),
        ...((needsBranch || single) && branchId !== user.branch?.id ? { branchId } : {}),
        ...(needsBranchSet ? { branchIds: branchSet } : {}),
      }),
    onSuccess: onSaved,
  });
  const valid =
    fullName.trim().length > 0 && (!(needsBranch || single) || branchId > 0) && (!needsBranchSet || branchSet.length > 0);
  return (
    <Modal
      open
      title={`Sửa tài khoản — ${user.username}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Hủy</Button>
          <Button onClick={() => save.mutate()} disabled={!valid} loading={save.isPending} data-testid="edit-user-save">
            Lưu
          </Button>
        </>
      }
    >
      {save.isError ? <div className="mb-3"><ErrorAlert>{toUserMessage(save.error)}</ErrorAlert></div> : null}
      <div className="space-y-3">
        <label className="block text-sm font-medium text-slate-600">
          Họ tên
          <input className={`${inputClass} mt-1`} value={fullName} onChange={(e) => setFullName(e.target.value)} data-testid="edit-user-name" />
        </label>
        {needsBranch ? (
          <label className="block text-sm font-medium text-slate-600">
            Chi nhánh
            <select aria-label="Chi nhánh" className={`${inputClass} mt-1`} value={branchId || ''} onChange={(e) => setBranchId(Number(e.target.value))}>
              <option value="">— Chọn chi nhánh —</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{branchLabel(b)}</option>
              ))}
            </select>
          </label>
        ) : single ? (
          <BranchChecklist
            branches={branches}
            value={branchId ? [branchId] : []}
            onChange={(ids) => setBranchId(ids[0] ?? 0)}
            single
            title={user.role === 'HOUSEKEEPING' ? 'Chi nhánh' : undefined}
          />
        ) : needsBranchSet ? (
          <BranchChecklist branches={branches} value={branchSet} onChange={setBranchSet} />
        ) : (
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">{scopeNote(user.role)}</p>
        )}
        <p className="text-xs text-slate-500">
          Quyền truy cập đổi theo ngay lần tải trang kế tiếp. Các bản ghi đã tạo không thay đổi.
        </p>
      </div>
    </Modal>
  );
}

/** What a role without a branch field works on — said, not left blank. */
function scopeNote(role: UserRole): string {
  if (role === 'RECEPTION_GENERAL_MANAGER') return 'Tổng quản lý lễ tân xem và quản lý hoạt động lễ tân của tất cả chi nhánh.';
  return 'Tài khoản bộ phận làm việc trên tất cả chi nhánh, không thuộc chi nhánh nào.';
}

/**
 * "XÓA" — permanent, Admin only, after typing the username. The account can no
 * longer sign in and leaves the list; everything it recorded stays, under the
 * names written on each record. The server refuses while it still holds live
 * work (an open shift, an incident in hand, a booking claim) and says which.
 */
function DeleteUserModal({ user, onClose, onDeleted }: { user: ManagedUser; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState('');
  const remove = useMutation({ mutationFn: () => adminUsersApi.remove(user.id), onSuccess: onDeleted });
  return (
    <Modal
      open
      title="Xóa tài khoản"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Hủy</Button>
          <Button
            onClick={() => remove.mutate()}
            disabled={typed.trim() !== user.username}
            loading={remove.isPending}
            className="!bg-rose-600 hover:!bg-rose-700"
            data-testid="delete-user-confirm"
          >
            Xóa vĩnh viễn
          </Button>
        </>
      }
    >
      {remove.isError ? <div className="mb-3"><ErrorAlert>{toUserMessage(remove.error)}</ErrorAlert></div> : null}
      <div className="space-y-3 text-sm text-slate-700">
        <p>
          Xóa vĩnh viễn tài khoản <span className="font-semibold">{user.fullName}</span> (
          <span className="font-mono">{user.username}</span>)? Tài khoản sẽ không đăng nhập được nữa. Lịch sử và các bản ghi
          đã tạo vẫn được giữ nguyên.
        </p>
        <label className="block font-medium text-slate-600">
          Nhập tên đăng nhập để xác nhận
          <input className={`${inputClass} mt-1`} value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="delete-user-typed" />
        </label>
      </div>
    </Modal>
  );
}

function DepartmentTable({
  role,
  users,
  togglingId,
  onToggle,
  onEdit,
  onDelete,
  onResetPassword,
}: {
  role: UserRole;
  users: ManagedUser[];
  togglingId: number | null;
  onToggle: (id: number, active: boolean) => void;
  onEdit: (user: ManagedUser) => void;
  onDelete: (user: ManagedUser) => void;
  onResetPassword: (user: ManagedUser) => void;
}) {
  const columns: DataColumn<ManagedUser>[] = [
    // Fixed shares, so the columns line up from one department's table to the next.
    { key: 'username', header: 'Tài khoản', className: 'w-[18%] whitespace-nowrap font-mono text-slate-800', render: (u) => u.username },
    { key: 'name', header: 'Họ tên', className: 'w-[24%] text-slate-800', render: (u) => u.fullName },
    {
      key: 'branch',
      header: 'Chi nhánh',
      secondary: true,
      className: 'w-[22%] whitespace-nowrap text-slate-600',
      // Technical, booking and admin accounts are global: no branch is the fact.
      // A Quản lý lễ tân / kỹ thuật lists its branches; a Buồng phòng account
      // without its one branch is flagged — it cannot work until it has one.
      render: (u) =>
        requiresBranchSet(u.role) ? (
          managedLabel(u)
        ) : u.role === 'HOUSEKEEPING' && !u.branch ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800" data-testid={`needs-branch-${u.id}`}>
            Cần gán chi nhánh
          </span>
        ) : (
          u.branch?.address ?? <span className="text-slate-400">Tất cả chi nhánh</span>
        ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      className: 'w-[14%] whitespace-nowrap',
      render: (u) =>
        u.active ? (
          <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700">Hoạt động</span>
        ) : (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-500">Đã khoá</span>
        ),
    },
    /*
      THE CREDENTIAL'S STATE — never the credential. A password is stored only
      as a hash; nobody, the Admin included, can read one back. A temporary one
      is shown once, at "Đặt lại mật khẩu", and must be changed at first login.
    */
    {
      key: 'password',
      header: 'Mật khẩu',
      secondary: true,
      className: 'whitespace-nowrap',
      render: (u) =>
        u.mustChangePassword ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">Mật khẩu tạm — chờ đổi</span>
        ) : (
          <span className="text-xs text-slate-600">Đã đặt mật khẩu</span>
        ),
    },
    {
      key: 'lastLogin',
      header: 'Đăng nhập gần nhất',
      secondary: true,
      className: 'whitespace-nowrap text-slate-500',
      render: (u) => (u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Chưa đăng nhập'),
    },
  ];

  return (
    <DataTable
      testId={`department-${role}`}
      title={DEPARTMENT_TITLE[role]}
      badge={users.length}
      columns={columns}
      rows={users}
      rowKey={(u) => String(u.id)}
      rowClassName={(u) => (u.active ? '' : 'text-slate-400')}
      emptyTitle={`Chưa có tài khoản ${DEPARTMENT_TITLE[role].toLowerCase()}`}
      emptyMessage=""
      // An admin is bootstrapped, not managed here — the server refuses to lock
      // one — so its row says "Chỉ xem" rather than offering a dead button.
      actions={(u) =>
        role === 'ADMIN' ? (
          <span className="text-xs text-slate-400">Chỉ xem</span>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onEdit(u)} data-testid={`edit-user-${u.id}`}>
              Sửa
            </Button>
            <Button variant="secondary" onClick={() => onResetPassword(u)} data-testid={`reset-password-${u.id}`}>
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              Đặt lại mật khẩu
            </Button>
            <Button
              variant={u.active ? 'secondary' : 'primary'}
              onClick={() => onToggle(u.id, u.active)}
              loading={togglingId === u.id}
            >
              {u.active ? 'Khoá' : 'Mở khoá'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => onDelete(u)}
              className="!border-rose-300 !text-rose-700 hover:!bg-rose-50"
              data-testid={`delete-user-${u.id}`}
            >
              Xóa
            </Button>
          </div>
        )
      }
    />
  );
}

function CreateUserModal({
  open,
  branches,
  onClose,
  onCreated,
}: {
  open: boolean;
  branches: Branch[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const EMPTY: CreateUserInput = {
    username: '',
    fullName: '',
    temporaryPassword: '',
    role: 'RECEPTIONIST',
    branchId: 0,
  };
  const [form, setForm] = useState<CreateUserInput>(EMPTY);
  // Derived from the shared list, not from a negative test against one role.
  // A receptionist's branch is a select; a Quản lý buồng phòng's the one-branch checklist.
  const single = requiresSingleBranchChoice(form.role);
  const needsBranch = requiresBranch(form.role) && !single;
  const needsBranchSet = requiresBranchSet(form.role);
  const [branchSet, setBranchSet] = useState<number[]>([]);

  const create = useMutation({
    // A global department sends no branch at all — the server refuses one, and
    // sending 0 would be a validation error rather than "none". A Quản lý lễ tân
    // sends its checked branches instead.
    mutationFn: () =>
      adminUsersApi.create({
        ...form,
        branchId: needsBranch || single ? form.branchId : undefined,
        branchIds: needsBranchSet ? branchSet : undefined,
      }),
    onSuccess: () => {
      setForm(EMPTY);
      setBranchSet([]);
      onCreated();
    },
  });

  const valid =
    form.username.trim() &&
    form.fullName.trim() &&
    form.temporaryPassword.length >= 8 &&
    (!(needsBranch || single) || (form.branchId ?? 0) > 0) &&
    (!needsBranchSet || branchSet.length > 0);

  return (
    <Modal
      open={open}
      title="Thêm tài khoản"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Huỷ</Button>
          <Button onClick={() => create.mutate()} disabled={!valid} loading={create.isPending}>Tạo</Button>
        </>
      }
    >
      {create.isError ? <div className="mb-3"><ErrorAlert>{toUserMessage(create.error)}</ErrorAlert></div> : null}
      <div className="space-y-3">
        <label className="block text-sm font-medium text-slate-600">
          Tên đăng nhập
          <input className={`${inputClass} mt-1`} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </label>
        <label className="block text-sm font-medium text-slate-600">
          Họ tên
          <input className={`${inputClass} mt-1`} value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        </label>
        <label className="block text-sm font-medium text-slate-600">
          Mật khẩu tạm (tối thiểu 8 ký tự, có chữ và số)
          <input className={`${inputClass} mt-1`} value={form.temporaryPassword} onChange={(e) => setForm({ ...form, temporaryPassword: e.target.value })} />
        </label>
        <label className="block text-sm font-medium text-slate-600">
          Vai trò
          <select
            aria-label="Vai trò"
            className={`${inputClass} mt-1`}
            value={form.role ?? 'RECEPTIONIST'}
            onChange={(e) =>
              setForm({ ...form, role: e.target.value as CreateUserInput['role'], branchId: 0 })
            }
          >
            <option value="RECEPTIONIST">Lễ tân</option>
            <option value="BOOKING_DEPARTMENT">Bộ phận đặt phòng</option>
            <option value="TECHNICAL">Bộ phận kỹ thuật</option>
            <option value="TECHNICAL_MANAGER">Quản lý kỹ thuật</option>
            <option value="HOUSEKEEPING">Bộ phận buồng phòng</option>
            <option value="HOUSEKEEPING_MANAGER">Quản lý buồng phòng</option>
            <option value="RECEPTION_MANAGER">Quản lý lễ tân</option>
            <option value="RECEPTION_GENERAL_MANAGER">Tổng quản lý lễ tân</option>
          </select>
        </label>
        {/*
          A receptionist has one branch; Quản lý / Bộ phận buồng phòng tick exactly
          one; a global department works across every branch, so offering the
          field would imply a scope it does not have.
        */}
        {needsBranch ? (
          <label className="block text-sm font-medium text-slate-600">
            Chi nhánh
            <select aria-label="Chi nhánh" className={`${inputClass} mt-1`} value={form.branchId || ''} onChange={(e) => setForm({ ...form, branchId: Number(e.target.value) })}>
              <option value="">— Chọn chi nhánh —</option>
              {branches.map((b) => (
                // Only ACTIVE branches reach here: /api/branches filters them out.
                <option key={b.id} value={b.id}>{branchLabel(b)}</option>
              ))}
            </select>
          </label>
        ) : single ? (
          <BranchChecklist
            branches={branches}
            value={form.branchId ? [form.branchId] : []}
            onChange={(ids) => setForm({ ...form, branchId: ids[0] ?? 0 })}
            single
            title={form.role === 'HOUSEKEEPING' ? 'Chi nhánh' : undefined}
          />
        ) : needsBranchSet ? (
          <BranchChecklist branches={branches} value={branchSet} onChange={setBranchSet} />
        ) : (
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">{scopeNote(form.role ?? 'RECEPTIONIST')}</p>
        )}
      </div>
    </Modal>
  );
}

/* --------------------------- Đặt lại mật khẩu --------------------------- */

/** The server's own rule: 8–72 characters, at least one letter and one digit. */
function passwordProblem(value: string): string | null {
  if (value.length < 8) return 'Mật khẩu phải có ít nhất 8 ký tự.';
  if (value.length > 72) return 'Mật khẩu không được vượt quá 72 ký tự.';
  if (!/[A-Za-z]/.test(value)) return 'Mật khẩu phải chứa ít nhất một chữ cái.';
  if (!/[0-9]/.test(value)) return 'Mật khẩu phải chứa ít nhất một chữ số.';
  return null;
}

/**
 * A strong temporary password, made in THIS browser from the platform's
 * cryptographic random source: 12 characters, upper and lower case and digits,
 * none of the look-alikes (0/O, 1/l/I) a person reads aloud wrongly.
 */
function generateTemporaryPassword(length = 12): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;
  const pick = (set: string) => {
    const n = new Uint32Array(1);
    crypto.getRandomValues(n);
    return set[n[0]! % set.length]!;
  };
  const chars = [pick(upper), pick(lower), pick(digits)];
  while (chars.length < length) chars.push(pick(all));
  // Shuffle, so the guaranteed kinds are not always in front.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const n = new Uint32Array(1);
    crypto.getRandomValues(n);
    const j = n[0]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

/**
 * "ĐẶT LẠI MẬT KHẨU" — a NEW temporary password, typed or generated here, set by
 * the server as a hash and shown ONCE in this dialog, with "Sao chép mật khẩu".
 * Once closed it is gone: no screen or endpoint can show it, or the old one,
 * again. The account must change it at its next login.
 */
function ResetPasswordModal({ user, onClose }: { user: ManagedUser; onClose: () => void }) {
  const [password, setPassword] = useState(() => generateTemporaryPassword());
  const [done, setDone] = useState<string | null>(null);
  const reset = useMutation({
    mutationFn: (value: string) => adminUsersApi.resetPassword(user.id, value),
    onSuccess: (_res, value) => setDone(value),
  });
  const problem = passwordProblem(password);

  if (done) {
    return (
      <Modal
        open
        title="Mật khẩu mới"
        onClose={onClose}
        footer={
          <Button onClick={onClose} data-testid="reset-password-close">
            Đóng
          </Button>
        }
      >
        <div className="space-y-3" data-testid="reset-password-result">
          <p className="text-sm text-slate-600">
            Mật khẩu tạm của <span className="font-semibold text-slate-900">{user.fullName}</span> (
            <span className="font-mono">{user.username}</span>):
          </p>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line-strong bg-slate-50 px-3 py-2.5">
            <code className="flex-1 select-all break-all font-mono text-lg font-semibold tracking-wide text-slate-900" data-testid="reset-password-value">
              {done}
            </code>
            <CopyButton value={done} label="Sao chép mật khẩu" text="Sao chép mật khẩu" />
          </div>
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Mật khẩu chỉ hiển thị một lần. Sau khi đóng, không ai xem lại được. Người dùng phải đổi mật khẩu khi đăng nhập.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      title="Đặt lại mật khẩu"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            onClick={() => reset.mutate(password)}
            disabled={problem !== null}
            loading={reset.isPending}
            data-testid="reset-password-confirm"
          >
            Đặt lại mật khẩu
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Tài khoản <span className="font-mono font-medium text-slate-900">{user.username}</span> — {user.fullName}. Mật khẩu
          hiện tại sẽ không dùng được nữa và mọi phiên đăng nhập của tài khoản này kết thúc.
        </p>
        <label className="block text-sm font-medium text-slate-700">
          <span className="mb-1.5 block">Mật khẩu tạm mới</span>
          <span className="flex gap-2">
            <input
              className={`${inputClass} font-mono`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              data-testid="reset-password-input"
            />
            <Button variant="secondary" onClick={() => setPassword(generateTemporaryPassword())} data-testid="reset-password-generate">
              Tạo mật khẩu mạnh
            </Button>
          </span>
        </label>
        {problem ? <p className="text-xs text-red-600">{problem}</p> : null}
        {reset.isError ? <ErrorAlert>{toUserMessage(reset.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/* ------------------------- Mật khẩu ghi đè Admin ------------------------- */

/**
 * "MẬT KHẨU GHI ĐÈ ADMIN" — one password that signs in as any non-Admin account
 * (its username + this password), audited on the server. Set, changed or turned
 * off here; it is never shown, only whether one is set. This page is Admin-only.
 */
function AdminOverridePanel() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const status = useQuery({ queryKey: ['admin-override'], queryFn: () => adminOverrideApi.status() });
  const clear = useMutation({
    mutationFn: () => adminOverrideApi.clear(),
    onSuccess: (data) => {
      queryClient.setQueryData(['admin-override'], data);
      setConfirmingClear(false);
    },
  });
  const s = status.data;

  return (
    <section
      data-testid="admin-override-panel"
      className="mt-4 rounded-xl border-section border-line bg-white px-4 py-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
        <div className="mr-auto min-w-0">
          <h2 className="text-[15px] font-semibold text-slate-900">Mật khẩu ghi đè Admin</h2>
          <p className="mt-0.5 text-sm text-slate-600">
            Đăng nhập vào tài khoản không phải Admin bằng tên đăng nhập của tài khoản và mật khẩu này. Mỗi lần dùng đều được
            ghi lại. Mật khẩu không bao giờ được hiển thị.
          </p>
          <p className="mt-1 text-sm" data-testid="admin-override-status">
            {status.isLoading ? (
              <span className="text-slate-500">Đang tải…</span>
            ) : s?.configured ? (
              <span className="font-medium text-emerald-700">
                Đang bật{s.updatedAt ? ` · cập nhật ${formatDateTime(s.updatedAt)}` : ''}
                {s.setByName ? ` bởi ${s.setByName}` : ''}
              </span>
            ) : (
              <span className="font-medium text-slate-500">Chưa đặt</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)} data-testid="admin-override-set">
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            {s?.configured ? 'Đổi mật khẩu' : 'Đặt mật khẩu'}
          </Button>
          {s?.configured ? (
            <Button variant="secondary" onClick={() => setConfirmingClear(true)} data-testid="admin-override-clear">
              Tắt
            </Button>
          ) : null}
        </div>
      </div>
      {status.isError ? <ErrorAlert>{toUserMessage(status.error)}</ErrorAlert> : null}

      {editing ? (
        <AdminOverrideModal
          onClose={() => setEditing(false)}
          onSaved={(data) => {
            queryClient.setQueryData(['admin-override'], data);
            setEditing(false);
          }}
        />
      ) : null}
      {confirmingClear ? (
        <Modal
          open
          title="Tắt mật khẩu ghi đè"
          onClose={() => setConfirmingClear(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmingClear(false)}>
                Hủy
              </Button>
              <Button onClick={() => clear.mutate()} loading={clear.isPending} data-testid="admin-override-clear-confirm">
                Tắt
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-600">
            Mật khẩu ghi đè sẽ không dùng được nữa và mọi phiên đăng nhập bằng mật khẩu này kết thúc.
          </p>
          {clear.isError ? <ErrorAlert>{toUserMessage(clear.error)}</ErrorAlert> : null}
        </Modal>
      ) : null}
    </section>
  );
}

function AdminOverrideModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (status: AdminOverrideStatus) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const save = useMutation({ mutationFn: () => adminOverrideApi.set(password, confirm), onSuccess: onSaved });
  const problem = password ? passwordProblem(password) : null;
  const mismatch = confirm.length > 0 && confirm !== password;

  return (
    <Modal
      open
      title="Mật khẩu ghi đè Admin"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!password || problem !== null || confirm !== password}
            loading={save.isPending}
            data-testid="admin-override-save"
          >
            Lưu
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Mật khẩu cũ (nếu có) sẽ không dùng được nữa và mọi phiên đăng nhập bằng mật khẩu cũ kết thúc.
        </p>
        <label className="block text-sm font-medium text-slate-700">
          <span className="mb-1.5 block">Mật khẩu mới</span>
          <input
            type="password"
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            data-testid="admin-override-password"
          />
        </label>
        {problem ? <p className="text-xs text-red-600">{problem}</p> : null}
        <label className="block text-sm font-medium text-slate-700">
          <span className="mb-1.5 block">Xác nhận mật khẩu mới</span>
          <input
            type="password"
            className={inputClass}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            data-testid="admin-override-confirm"
          />
        </label>
        {mismatch ? <p className="text-xs text-red-600">Mật khẩu xác nhận không khớp.</p> : null}
        {save.isError ? <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}
