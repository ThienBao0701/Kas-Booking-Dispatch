import { useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { AccountMenu } from './AccountMenu';
import { NotificationBell } from './NotificationBell';
import { InstallButton } from '../pwa/InstallButton';
import { titleForPath } from './navigation';
import { ShiftIndicator } from '../components/ShiftGate';

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
