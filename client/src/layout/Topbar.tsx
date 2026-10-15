import { useLocation } from 'react-router-dom';
import { Building2, CalendarDays, Menu } from 'lucide-react';
import { AccountMenu } from './AccountMenu';
import { NotificationBell } from './NotificationBell';
import { InstallButton } from '../pwa/InstallButton';
import { titleForPath } from './navigation';
import { ShiftIndicator } from '../components/ShiftGate';
import { useAuth } from '../auth/AuthProvider';
import { formatDate, hcmToday } from '../lib/format';

/**
 * The Quản lý buồng phòng's context, on every one of its screens: the hotel the
 * Admin assigned it (by its address — never a branch number), and today's
 * business date. (A screen's own date picker may
 * look at another day; its context strip says which.)
 */
function HousekeepingContext() {
  const { user } = useAuth();
  if (user?.role !== 'HOUSEKEEPING_MANAGER') return null;
  return (
    <div className="mr-2 hidden items-center gap-4 xl:flex" data-testid="topbar-hk-context">
      <span className="flex items-center gap-2">
        <Building2 className="h-[18px] w-[18px] text-slate-500" aria-hidden="true" />
        <span className="leading-tight">
          <span className="block text-xs font-semibold text-slate-900">Quản lý buồng phòng</span>
          <span className="block text-xs text-slate-500">{user.branch?.address ?? '—'}</span>
        </span>
      </span>
      <span className="flex items-center gap-2 rounded-lg border border-line-subtle px-2.5 py-1.5 text-sm text-slate-700">
        <CalendarDays className="h-4 w-4 text-slate-500" aria-hidden="true" />
        <span className="sr-only">Hôm nay:</span>
        <span className="tabular-nums">{formatDate(hcmToday())}</span>
      </span>
    </div>
  );
}

export function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const location = useLocation();
  const title = titleForPath(location.pathname);

  return (
    <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Mở menu điều hướng"
          className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 lg:hidden"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
        <h1 className="truncate text-base font-semibold text-slate-800">{title}</h1>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        <HousekeepingContext />
        {/* Which shift is running, and whose. Renders nothing for other roles. */}
        <ShiftIndicator />
        {/*
          One component, one mount point, both roles. Admin and Reception share
          this bar, so the install affordance is on every authenticated screen
          without a second implementation or a per-role variant.
        */}
        <InstallButton variant="inline" className="mr-1 hidden whitespace-nowrap sm:inline-flex" />
        <NotificationBell />
        <AccountMenu />
      </div>
    </header>
  );
}
