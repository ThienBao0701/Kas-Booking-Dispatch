import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { adminUsersApi, type CreateUserInput, type ManagedUser, requiresBranch } from '../api/adminUsers';
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

const inputClass =
  'w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

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
              />
            );
          })}
        </div>
      </QueryState>

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
const DEPARTMENTS: UserRole[] = ['RECEPTIONIST', 'TECHNICAL', 'BOOKING_DEPARTMENT', 'ADMIN'];

/** Sections shown even when empty — the departments every property has. */
const ALWAYS_SHOWN: UserRole[] = ['RECEPTIONIST', 'TECHNICAL', 'ADMIN'];

const DEPARTMENT_TITLE: Record<UserRole, string> = {
  RECEPTIONIST: 'Lễ tân',
  TECHNICAL: 'Kỹ thuật',
  BOOKING_DEPARTMENT: 'Bộ phận đặt phòng',
  ADMIN: 'Admin / Quản trị',
};

function DepartmentTable({
  role,
  users,
  togglingId,
  onToggle,
}: {
  role: UserRole;
  users: ManagedUser[];
  togglingId: number | null;
  onToggle: (id: number, active: boolean) => void;
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
      render: (u) => u.branch?.address ?? <span className="text-slate-400">Tất cả chi nhánh</span>,
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
          <Button
            variant={u.active ? 'secondary' : 'primary'}
            onClick={() => onToggle(u.id, u.active)}
            loading={togglingId === u.id}
          >
            {u.active ? 'Khoá' : 'Mở khoá'}
          </Button>
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
  const needsBranch = requiresBranch(form.role);

  const create = useMutation({
    // A global department sends no branch at all — the server refuses one, and
    // sending 0 would be a validation error rather than "none".
    mutationFn: () => adminUsersApi.create(needsBranch ? form : { ...form, branchId: undefined }),
    onSuccess: () => {
      setForm(EMPTY);
      onCreated();
    },
  });

  const valid =
    form.username.trim() &&
    form.fullName.trim() &&
    form.temporaryPassword.length >= 8 &&
    (!needsBranch || (form.branchId ?? 0) > 0);

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
          </select>
        </label>
        {/*
          A branch belongs to a receptionist alone. A global department works
          across every branch, so offering the field would imply a scope the
          account does not have.
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
        ) : (
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
            Tài khoản bộ phận làm việc trên tất cả chi nhánh, không thuộc chi nhánh nào.
          </p>
        )}
      </div>
    </Modal>
  );
}
