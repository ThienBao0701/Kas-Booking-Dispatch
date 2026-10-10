import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, KeyRound, LogOut, Users } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { ROLE_LABEL } from '../auth/types';

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  const last = parts[parts.length - 1] ?? '';
  const first = parts[0] ?? '';
  return `${first.charAt(0)}${parts.length > 1 ? last.charAt(0) : ''}`.toUpperCase() || '?';
}

export function AccountMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  if (!user) return null;

  const roleLabel = ROLE_LABEL[user.role];

  const onLogout = async () => {
    setOpen(false);
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Mở menu tài khoản"
        className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
      >
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
          {initials(user.fullName)}
        </div>
        <div className="hidden text-left sm:block">
          <p className="text-sm font-medium text-slate-800">{user.fullName}</p>
          <p className="text-xs text-slate-500">
            {roleLabel}
            {user.branch ? ` · ${user.branch.hotelName}` : ''}
          </p>
        </div>
        <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden="true" />
      </button>

      {open ? (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            role="menu"
            className="absolute right-0 z-20 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
          >
            <div className="px-3 py-2">
              <p className="text-sm font-medium text-slate-800">{user.fullName}</p>
              <p className="text-xs text-slate-500">@{user.username}</p>
              <p className="mt-1 text-xs text-slate-500">{roleLabel}</p>
              {user.branch ? (
                <p className="text-xs text-slate-500">Chi nhánh: {user.branch.hotelName}</p>
              ) : null}
            </div>
            <div className="my-1 h-px bg-slate-100" />
            {user.role === 'ADMIN' ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  navigate('/app/settings');
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
              >
                <Users className="h-4 w-4" aria-hidden="true" />
                Quản lý tài khoản
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate('/change-password', { state: { from: location.pathname } });
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
            >
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              Đổi mật khẩu
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={onLogout}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Đăng xuất
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
