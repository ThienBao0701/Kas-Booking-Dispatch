import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, type Location } from 'react-router-dom';
import { Building2, ChevronDown } from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { useIssueSummary } from '../hooks/useIssueSummary';
import { useNavBadges } from '../hooks/useNavBadges';
import { useOpenReportCounts } from '../hooks/useOpenReportCounts';
import { navForRole, type NavItem } from './navigation';

/**
 * Is this link the page on screen? A link that names a CATEGORY
 * ("/app/reports?category=PAYMENT") is active only on that category; "Tổng"
 * ("/app/reports") only with none; any other link by its path, as before.
 */
function linkActive(to: string, location: Location): boolean {
  const [path, search = ''] = to.split('?');
  if (search) {
    const want = new URLSearchParams(search);
    const have = new URLSearchParams(location.search);
    return location.pathname === path && [...want.entries()].every(([k, v]) => have.get(k) === v);
  }
  if (path === '/app/reports') return location.pathname === path && !new URLSearchParams(location.search).get('category');
  return location.pathname === path || (path !== '/app/dashboard' && location.pathname.startsWith(`${path}/`));
}

function containsActive(item: NavItem, location: Location): boolean {
  return (item.children ?? []).some((c) => (c.children ? containsActive(c, location) : linkActive(c.to, location)));
}

/** A link's own count, if it has one. */
type BadgeOf = (item: NavItem) => number | undefined;

/** Some link inside the group has something waiting. */
function anyBadge(item: NavItem, badgeOf: BadgeOf | undefined): boolean {
  return (item.children ?? []).some((c) => (c.children ? anyBadge(c, badgeOf) : (badgeOf?.(c) ?? 0) > 0));
}

/** The compact count beside a link: its own figure, never its group's. */
function CountBadge({ count, testId, label }: { count: number; testId: string; label: string }) {
  return (
    <span
      data-testid={testId}
      aria-label={label}
      className="ml-1 inline-flex min-w-[1.25rem] shrink-0 items-center justify-center self-center rounded-full bg-red-600 px-1.5 py-0.5 text-[11px] font-bold leading-none text-white"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * A COLLAPSIBLE GROUP ("Báo cáo vấn đề" → "Lễ tân" → …). Open while the page on
 * screen is inside it, so the reader always sees where they are; a click
 * folds or unfolds it. Its children are ordinary links, one level indented.
 */
function SidebarGroup({
  item,
  onNavigate,
  depth,
  badge,
  badgeLabel,
  badgeOf,
}: {
  item: NavItem;
  onNavigate?: () => void;
  depth: number;
  badge?: number;
  badgeLabel?: string;
  /** Each link's own count: the group shows only a dot that something inside waits. */
  badgeOf?: BadgeOf;
}) {
  const location = useLocation();
  const inside = containsActive(item, location);
  const [open, setOpen] = useState(inside);
  useEffect(() => {
    if (inside) setOpen(true);
  }, [inside]);
  const Icon = item.icon;
  const showBadge = typeof badge === 'number' && badge > 0;
  const waiting = !showBadge && anyBadge(item, badgeOf);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid={`nav-group-${item.label}`}
        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
          inside ? 'text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
        }`}
      >
        <Icon className={`${depth > 0 ? 'h-4 w-4' : 'h-5 w-5'} flex-shrink-0`} aria-hidden="true" />
        <span className="flex-1">{item.label}</span>
        {showBadge ? (
          <span
            data-testid="nav-badge-reports"
            className="inline-flex min-w-[1.4rem] items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-bold leading-none text-white"
            aria-label={badgeLabel}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        ) : waiting ? (
          <span data-testid={`nav-dot-${item.label}`} aria-label="Có mục cần xử lý" className="h-2 w-2 shrink-0 rounded-full bg-red-600" />
        ) : null}
        <ChevronDown className={`h-4 w-4 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open ? (
        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-line pl-2">
          {(item.children ?? []).map((child) =>
            child.children ? (
              <SidebarGroup key={child.to} item={child} onNavigate={onNavigate} depth={depth + 1} badgeOf={badgeOf} />
            ) : (
              <SidebarChildLink key={child.to} item={child} onNavigate={onNavigate} badge={badgeOf?.(child)} />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/** "Sẽ phát triển" beside a screen not built yet. */
function NavStatus({ item }: { item: NavItem }) {
  if (!item.status) return null;
  return (
    <span data-testid={`nav-status-${item.to}`} className="ml-1 shrink-0 self-center whitespace-nowrap rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
      {item.status}
    </span>
  );
}

/** A link inside a group — smaller, and active by `linkActive`. */
function SidebarChildLink({ item, onNavigate, badge }: { item: NavItem; onNavigate?: () => void; badge?: number }) {
  const location = useLocation();
  const active = linkActive(item.to, location);
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={`flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] leading-snug transition-colors ${
        active ? 'bg-brand-50 font-semibold text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <span className="flex-1">{item.label}</span>
      <NavStatus item={item} />
      {badge ? <CountBadge count={badge} testId={`nav-count-${item.to}`} label={`${item.label}: ${badge} mục cần xử lý`} /> : null}
    </Link>
  );
}

function SidebarLink({
  item,
  onNavigate,
  badge,
  badgeLabel,
}: {
  item: NavItem;
  onNavigate?: () => void;
  badge?: number;
  /** Accessible wording for the count; menus that have their own phrase pass it. */
  badgeLabel?: string;
}) {
  const Icon = item.icon;
  const showBadge = typeof badge === 'number' && badge > 0;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/app/dashboard'}
      onClick={onNavigate}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
          isActive
            ? 'bg-brand-50 text-brand-700'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
        }`
      }
    >
      <Icon className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
      <span className="flex-1">{item.label}</span>
      <NavStatus item={item} />
      {showBadge ? (
        <span
          data-testid={`nav-badge-${item.to.replace('/app/', '')}`}
          className="inline-flex min-w-[1.4rem] items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-bold leading-none text-white"
          aria-label={badgeLabel ?? `${item.label}: ${badge} mục cần xử lý`}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </NavLink>
  );
}

/** Every link's address in a menu, groups opened. */
function flatLinks(items: NavItem[]): string[] {
  return items.flatMap((i) => (i.children ? flatLinks(i.children) : [i.to]));
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth();
  const nav = navForRole(user?.role);
  // Unresolved-issue badge on the "Sự cố khách sạn" / "Báo cáo sự cố" menu item.
  // Bộ phận buồng phòng has no incident screen, and the server would refuse it.
  const summary = useIssueSummary(!!user && user.role !== 'HOUSEKEEPING');
  const unresolved = summary.data?.summary.totalUnresolved ?? 0;

  /*
    OPERATIONAL COUNTS PER MENU ITEM, replacing reliance on the single global
    notification total. One number in a bell said only "something happened";
    these say WHICH queue has work in it, which is the question a receptionist
    starting a shift is actually asking.

    Every value comes from the server on each poll. Nothing below adds, subtracts
    or remembers a count, so the badges cannot drift from the lists they label.
  */
  const badges = useNavBadges(!!user);
  const counts = badges.data?.counts;
  // The reports still open, by category — for the menus that list the categories.
  const role = user?.role;
  const open = useOpenReportCounts(
    role === 'ADMIN' || role === 'RECEPTION_MANAGER' || role === 'RECEPTION_GENERAL_MANAGER' || role === 'HOUSEKEEPING' || role === 'HOUSEKEEPING_MANAGER',
  ).data?.counts;
  const incidents = summary.data?.summary;

  /*
    THE UNRESOLVED-INCIDENT BADGE FOLLOWS INCIDENT REPORTING.

    Neither reception nor the Admin has a standalone incident entry any more —
    reporting and watching incidents is "Báo cáo vấn đề" → "Sự cố vật chất
    đang xử lý". The count moves with it rather than disappearing, so anyone
    opening the app still sees "2 sự cố chưa xử lý" without opening anything.
  */
  const incidentHost = '/app/reports';

  /*
    EACH REPORT CATEGORY ITS OWN COUNT, each record under ONE entry of the menu.
    Where the menu also has Bộ phận buồng phòng's own entries (the Admin's),
    Reception's entries count Reception's records and Housekeeping's count
    Housekeeping's; where it has not (the reception managers'), Reception's
    entries count both, as their pages list both.
  */
  const all = flatLinks(nav);
  const splitHousekeeping = all.includes('/app/hk/reports?category=GUEST_REQUEST');
  function reportBadgeOf(item: NavItem): number | undefined {
    switch (item.to) {
      case '/app/reports?category=GUEST_REQUEST':
        return open ? open.guestRequest.reception + (splitHousekeeping ? 0 : open.guestRequest.housekeeping) : undefined;
      case '/app/hk/reports?category=GUEST_REQUEST':
        return open?.guestRequest.housekeeping;
      case '/app/reports?category=CUSTOMER_COMPLAINT':
        return open?.complaint;
      case '/app/reports?category=FACILITY_ISSUE':
        return incidents ? (splitHousekeeping ? incidents.byDepartment?.reception : incidents.totalUnresolved) : undefined;
      case '/app/hk/reports?category=FACILITY_ISSUE':
        // The Admin: Housekeeping's reports; a Quản lý buồng phòng: its branch's board, every one.
        return incidents ? (role === 'ADMIN' ? incidents.byDepartment?.housekeeping : incidents.totalUnresolved) : undefined;
      default:
        return undefined;
    }
  }

  function badgeFor(item: NavItem): number | undefined {
    // A group with its categories counts them one by one; the single link (the desk's) keeps its total.
    if (item.to === incidentHost) return item.children ? undefined : unresolved;
    if (!counts) return undefined;
    switch (item.to) {
      // Reception's "Đơn mới" and Admin's "Chờ chi nhánh tạo" are the same
      // dispatched-not-yet-created queue seen from two sides.
      case '/app/new':
      case '/app/waiting':
        return counts.new;
      case '/app/pending-review':
        return counts.pendingReview;
      case '/app/rejected':
        return counts.rejected;
      case '/app/resend-orders':
        return counts.resendOrders;
      case '/app/reminders':
        return counts.reminders;
      default:
        return undefined;
    }
  }

  return (
    <aside className="flex h-full w-64 flex-col border-r border-slate-200 bg-white">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white">
          <Building2 className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-slate-900">Kas</p>
          <p className="text-xs text-slate-500">{user?.role === 'HOUSEKEEPING_MANAGER' ? 'Quản lý buồng phòng' : 'Điều phối đặt phòng'}</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2" aria-label="Điều hướng chính">
        {nav.map((item, i) => [
          // A section heading (the Quản lý buồng phòng's menu): a label, never a level.
          item.section ? (
            <p
              key={`section-${item.section}`}
              className={`px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400 ${i === 0 ? 'pt-1' : 'pt-4'}`}
            >
              {item.section}
            </p>
          ) : null,
          item.children ? (
            <SidebarGroup
              key={item.to}
              item={item}
              onNavigate={onNavigate}
              depth={0}
              badge={badgeFor(item)}
              badgeOf={reportBadgeOf}
            />
          ) : (
            <SidebarLink
              key={item.to}
              item={item}
              onNavigate={onNavigate}
              badge={badgeFor(item)}
              {...(item.to === incidentHost
                ? // Kept verbatim: this badge predates the others and its wording
                  // is more specific than the generic phrasing would be.
                  { badgeLabel: `${unresolved} sự cố chưa xử lý` }
                : {})}
            />
          ),
        ])}
      </nav>

      {/* Bộ phận buồng phòng names its hotel at "Vào ca"; the shift strip shows it then. */}
      {user?.branch && user.role !== 'HOUSEKEEPING' ? (
        <div className="border-t border-slate-200 px-5 py-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Chi nhánh</p>
          <p className="mt-1 text-sm font-medium text-slate-700">{user.branch.hotelName}</p>
          <p className="text-xs text-slate-500">{user.branch.address}</p>
        </div>
      ) : null}
    </aside>
  );
}
