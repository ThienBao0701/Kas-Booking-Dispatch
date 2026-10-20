import {
  BarChart3,
  ShieldAlert,
  ConciergeBell,
  MessageSquareText,
  Boxes,
  Brush,
  CalendarPlus,
  ClipboardList,
  Package,
  PackageCheck,
  Shirt,
  Sparkles,
  ThumbsUp,
  Wallet,
  BedDouble,
  BellRing,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  ClipboardPaste,
  NotebookPen,
  FileText,
  Hammer,
  History,
  Inbox,
  LayoutDashboard,
  RotateCcw,
  ScanSearch,
  Send,
  Users,
  Wrench,
  type LucideIcon,
  XCircle,
} from 'lucide-react';
import type { UserRole } from '../auth/types';
import { CATEGORY_FALLBACK_LABELS, GUEST_REQUEST_TITLE, HOTEL_DELIVERY_TITLE } from '../lib/reportCategories';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** A collapsible group: its children are the links; `to` only names it. */
  children?: NavItem[];
  /** A plain heading above this top-level link, starting a section (not a level). */
  section?: string;
}

/**
 * "BÁO CÁO VẤN ĐỀ" — ONE report, three departments, for the Admin and the two
 * reception managers alike (the server scopes every read):
 *
 *   Lễ tân  → Tổng and each category on its own (the same page, one category)
 *   Kỹ thuật → incidents by branch and room, with assignment and stages
 *   Buồng phòng → findings, collection and the housekeeping workdays
 */
/**
 * "HOÀN THÀNH VẤN ĐỀ" — the 12-hour archive in two views, by the verdict given
 * at "Hoàn thành": reports that were right, and reports that were wrong.
 */
const COMPLETED_GROUP: NavItem = {
  to: '/app/completed-issues',
  label: 'Hoàn thành vấn đề',
  icon: CheckCircle2,
  children: [
    { to: '/app/completed-issues?verdict=CORRECT', label: 'Vấn đề báo cáo đúng', icon: CheckCircle2 },
    { to: '/app/completed-issues?verdict=INCORRECT', label: 'Vấn đề báo cáo sai', icon: XCircle },
  ],
};

/**
 * BỘ PHẬN BUỒNG PHÒNG'S "BÁO CÁO VẤN ĐỀ" — its own journal, apart from
 * Reception's: three categories on one page (`?category=`; "Dịch vụ phòng,
 * KPI" is Reception's only), the private reports
 * upward ("VII"), and the room inspections and KPI. `kpi` is the role's own
 * KPI screen — a housekeeper's (its findings), or the branch's.
 */
function housekeepingReportGroup(kpi: NavItem): NavItem {
  return {
    to: '/app/hk/reports',
    label: 'Báo cáo vấn đề',
    icon: NotebookPen,
    children: [
      { to: '/app/hk/reports?category=GUEST_REQUEST', label: GUEST_REQUEST_TITLE, icon: MessageSquareText },
      { to: '/app/hk/reports?category=FACILITY_ISSUE', label: CATEGORY_FALLBACK_LABELS.FACILITY_ISSUE, icon: Wrench },
      { to: '/app/hk/reports?category=HOTEL_DELIVERY', label: HOTEL_DELIVERY_TITLE, icon: PackageCheck },
      { to: '/app/reports/confidential', label: 'Báo cáo các vấn đề và tình hình quan trọng', icon: ShieldAlert },
      kpi,
    ],
  };
}

/** "HOÀN THÀNH VẤN ĐỀ" of Bộ phận buồng phòng — its own records, by verdict. */
const HOUSEKEEPING_COMPLETED_GROUP: NavItem = {
  to: '/app/hk/completed',
  label: 'Hoàn thành vấn đề',
  icon: CheckCircle2,
  children: [
    { to: '/app/hk/completed?verdict=CORRECT', label: 'Vấn đề báo cáo đúng', icon: CheckCircle2 },
    { to: '/app/hk/completed?verdict=INCORRECT', label: 'Vấn đề báo cáo sai', icon: XCircle },
  ],
};

/** The branch's room inspections and KPI — the manager's (and the Admin's) reporting entry. */
const HOUSEKEEPING_KPI_GROUP: NavItem = {
  to: '/app/hk/kpi#reports',
  label: 'Kiểm tra phòng & KPI buồng phòng',
  icon: ClipboardCheck,
  children: [
    { to: '/app/hk/kpi', label: 'KPI buồng phòng', icon: Wallet },
    { to: '/app/hk/report', label: 'Lịch sử kiểm tra & dọn phòng', icon: FileText },
  ],
};

/**
 * "CÔNG VIỆC CÁ NHÂN" — the manager's own work, in four pages: its own rooms to
 * clean, the stock count, giving out today's work, and preparing tomorrow's.
 */
const PERSONAL_WORK: NavItem = {
  to: '/app/hk#personal',
  label: 'Công việc cá nhân',
  icon: BedDouble,
  children: [
    { to: '/app/hk/clean', label: 'Dọn phòng', icon: Brush },
    { to: '/app/hk/stock-count', label: 'Kiểm kho', icon: ClipboardList },
    { to: '/app/hk/rooms', label: 'Phân công ca, việc làm', icon: BedDouble },
    { to: '/app/hk/tomorrow', label: 'Phân công việc ngày hôm sau', icon: CalendarPlus },
  ],
};

/**
 * "QUẢN LÝ BUỒNG PHÒNG" — the screens over one branch's housekeeping. Work is
 * given out in "Phân công ca, việc làm", so there is no separate "Phân công
 * công việc" entry. Every screen keeps its title here. The three warehouses
 * ("Kho …") keep the branch's stock.
 */
const HOUSEKEEPING_MANAGER_SCREENS: NavItem[] = [
  { to: '/app/hk/overview', label: 'Công việc chung', icon: LayoutDashboard },
  PERSONAL_WORK,
  { to: '/app/hk/staff', label: 'Theo dõi nhân viên', icon: Users },
  { to: '/app/hk/kpi', label: 'KPI', icon: Wallet },
  { to: '/app/hk/report', label: 'Báo cáo', icon: FileText },
  { to: '/app/hk/store/linens', label: 'Kho Linens', icon: Shirt },
  { to: '/app/hk/store/amenities', label: 'Kho Amenities', icon: Package },
  { to: '/app/hk/store/equipment', label: 'Kho đồ dùng, thiết bị', icon: Boxes },
];

/**
 * Off the menu, not removed: "Theo dõi nhân viên" and "Báo cáo" are hidden from
 * the "Quản lý buồng phòng" menu (the manager's and the Admin's group alike).
 * Their pages, routes, permissions and data are unchanged — their addresses,
 * and the links to them inside the screens, still open them.
 */
const HIDDEN_FROM_MENU = new Set(['/app/hk/staff', '/app/hk/report', '/app/hk/kpi']);

/** The "Quản lý buồng phòng" menu: Công việc chung, Công việc cá nhân, then the three stores (KPI: under "Báo cáo vấn đề"). */
const HOUSEKEEPING_MANAGER_ITEMS: NavItem[] = HOUSEKEEPING_MANAGER_SCREENS.filter((item) => !HIDDEN_FROM_MENU.has(item.to));

/**
 * For the Admin, the same menu as one group (every branch) — without "Dọn
 * phòng" (the Admin works no shift and cleans no room), and with "Tồn kho &
 * Báo hỏng", every branch's stock and the damage reports to review.
 */
const HOUSEKEEPING_MANAGER_GROUP: NavItem = {
  to: '/app/hk',
  label: 'Quản lý buồng phòng',
  icon: BedDouble,
  children: [
    ...HOUSEKEEPING_MANAGER_ITEMS.map((item) =>
      item === PERSONAL_WORK ? { ...item, children: item.children!.filter((c) => c.to !== '/app/hk/clean') } : item,
    ),
    // Every branch's housekeeping stock and the damage reports to review — the Admin's own.
    { to: '/app/inventory', label: 'Tồn kho & Báo hỏng', icon: Boxes },
  ],
};

/** "VII" — its full name, as the category is called everywhere. */
const CONFIDENTIAL_TITLE = 'Báo cáo các vấn đề và tình hình quan trọng';

/** The Admin's "Buồng phòng" under "Báo cáo vấn đề": the department's own journal, its findings' collection, its inspections and KPI. */
const ADMIN_HOUSEKEEPING_REPORTS: NavItem = {
  to: '/app/reports#housekeeping',
  label: 'Buồng phòng',
  icon: BedDouble,
  children: [
    { to: '/app/hk/reports', label: 'Báo cáo vấn đề buồng phòng', icon: NotebookPen },
    { to: '/app/reports/housekeeping', label: 'Phát hiện & thu tiền', icon: Wallet },
    ...HOUSEKEEPING_KPI_GROUP.children!,
    { to: '/app/hk/completed', label: 'Hoàn thành vấn đề buồng phòng', icon: CheckCircle2 },
  ],
};

const REPORT_GROUP: NavItem = {
  to: '/app/reports',
  label: 'Báo cáo vấn đề',
  icon: NotebookPen,
  children: [
    {
      to: '/app/reports#reception',
      label: 'Lễ tân',
      icon: ConciergeBell,
      children: [
        { to: '/app/reports', label: 'Tổng', icon: LayoutDashboard },
        { to: '/app/reports?category=PAYMENT', label: CATEGORY_FALLBACK_LABELS.PAYMENT, icon: Wallet },
        { to: '/app/reports?category=GUEST_REQUEST', label: GUEST_REQUEST_TITLE, icon: MessageSquareText },
        { to: '/app/reports?category=FACILITY_ISSUE', label: CATEGORY_FALLBACK_LABELS.FACILITY_ISSUE, icon: Wrench },
        { to: '/app/reports?category=CUSTOMER_COMPLAINT', label: CATEGORY_FALLBACK_LABELS.CUSTOMER_COMPLAINT, icon: ThumbsUp },
        { to: '/app/reports?category=ROOM_SERVICE', label: CATEGORY_FALLBACK_LABELS.ROOM_SERVICE, icon: Sparkles },
        { to: '/app/reports?category=HOTEL_DELIVERY', label: HOTEL_DELIVERY_TITLE, icon: PackageCheck },
        // VII — private reports upward: the managers' and the Admin's inbox.
        { to: '/app/reports/confidential', label: CONFIDENTIAL_TITLE, icon: ShieldAlert },
      ],
    },
    { to: '/app/reports/technical', label: 'Kỹ thuật', icon: Hammer },
    { to: '/app/reports/housekeeping', label: 'Buồng phòng', icon: BedDouble },
  ],
};

/** The Admin's: the same, with Bộ phận buồng phòng's own reporting under "Buồng phòng". */
const ADMIN_REPORT_GROUP: NavItem = {
  ...REPORT_GROUP,
  children: REPORT_GROUP.children!.map((c) => (c.to === '/app/reports/housekeeping' ? ADMIN_HOUSEKEEPING_REPORTS : c)),
};

/** Admin operates the whole dispatch centre and reviews creation proofs. */
export const ADMIN_NAV: NavItem[] = [
  { to: '/app/dashboard', label: 'Tổng quan', icon: LayoutDashboard },
  { to: '/app/dispatch', label: 'Nhập đơn', icon: ClipboardPaste },
  { to: '/app/waiting', label: 'Chờ chi nhánh tạo', icon: Inbox },
  { to: '/app/pending-review', label: 'Chờ kiểm tra', icon: ScanSearch },
  { to: '/app/rejected', label: 'Cần tạo lại', icon: RotateCcw },
  { to: '/app/history', label: 'Lịch sử', icon: History },
  // "Sự cố khách sạn" and "Bàn giao ca" are gone: incidents live under
  // "Báo cáo vấn đề" -> "Sự cố cơ sở vật chất đang xử lý"; handover has no screen.
  // "Đã xác nhận đúng" is gone too (its address redirects to "Lịch sử"), and
  // "Chat box" is the bubble in the corner of every page, not a menu entry.
  ADMIN_REPORT_GROUP,
  HOUSEKEEPING_MANAGER_GROUP,
  // The 12-hour completion archive, every branch.
  COMPLETED_GROUP,
  { to: '/app/resend-orders', label: 'Gửi lại đơn', icon: Send },
  { to: '/app/charge-documents', label: 'Chứng từ', icon: FileText },
  { to: '/app/reminders', label: 'Nhắc nhở', icon: BellRing },
  { to: '/app/branches', label: 'Khách sạn & chi nhánh', icon: Building2 },
  { to: '/app/settings', label: 'Quản lý tài khoản', icon: Users },
];

/**
 * Bộ phận đặt phòng works on charge documents and nothing else.
 *
 * A short menu on purpose: this role is global (no branch), so every other
 * screen either belongs to a branch it does not have or is admin-only.
 *
 * CHAT BOX IS DELIBERATELY ABSENT. Chat box is reception↔Admin correspondence;
 * no requirement gives this role a part in it, and adding the menu item "because
 * it seems useful" would grant an access nobody asked for. The API refuses the
 * role outright, so this list and that gate agree.
 */
export const BOOKING_DEPARTMENT_NAV: NavItem[] = [
  { to: '/app/charge-documents', label: 'Chứng từ', icon: FileText },
];

/**
 * Receptionist creates externally, uploads proof, then tracks the verdict.
 *
 * SIX ENTRIES CAME OUT, AND NO SCREEN OR RECORD WENT WITH THEM. ("Chat box" is the
 * seventh, and it went the same way: its pages are still routes, and the chat
 * itself is the bubble on every page.)
 *
 * "Chờ Admin kiểm tra", "Cần tạo lại", "Đã xác nhận đúng" and "Lịch sử" are no
 * longer on reception's menu; their routes still exist, so a notification or
 * booking link that points there still opens. "Báo cáo sự cố" is a category of
 * "Báo cáo vấn đề" now (same form, same incident system), and "Bàn giao ca" has
 * no screen — its history and API are untouched.
 */
export const RECEPTIONIST_NAV: NavItem[] = [
  { to: '/app/new', label: 'Đơn mới', icon: Inbox },
  { to: '/app/reports', label: 'Báo cáo vấn đề', icon: NotebookPen },
  // Requests, facility incidents, service-quality reports and deliveries
  // completed 12 hours or more after they were received — the same records, by
  // query.
  COMPLETED_GROUP,
  // Collection on what Bộ phận buồng phòng found — its own screen, apart from
  // the payment ledger inside "Báo cáo vấn đề". "Chat box" is the bubble in the
  // corner of every page, not a menu entry.
  // "Buồng phòng": the collection screen's name at the desk (its address is kept).
  { to: '/app/room-collections', label: 'Buồng phòng', icon: BedDouble },
  { to: '/app/reminders', label: 'Nhắc nhở', icon: BellRing },
];

/**
 * "Quản lý lễ tân" and "Tổng quản lý lễ tân" — RECEPTION'S OWN MENU, for the
 * manager's branches (all eight for the general manager), scoped by the server.
 * Every Reception entry is here except "Nhắc nhở", which is a private inbox of
 * reminders addressed to one receptionist account each. The chat is the bubble.
 */
export const RECEPTION_MANAGER_NAV: NavItem[] = [
  { to: '/app/new', label: 'Đơn mới', icon: Inbox },
  REPORT_GROUP,
  COMPLETED_GROUP,
];

/**
 * Bộ phận kỹ thuật works the incident queues and nothing else.
 *
 * The items are WORKFLOW STATES, not saved filters: an incident is in exactly
 * one of them, and it moves between them only by somebody acting on it. No
 * booking screen appears here — this role has no branch and no part in dispatch.
 */
export const TECHNICAL_NAV: NavItem[] = [
  // Only incidents ASSIGNED to this technician — the server enforces it.
  { to: '/app/technical/new', label: 'Được giao', icon: Wrench },
  { to: '/app/technical/rework', label: 'Cần sửa lại', icon: RotateCcw },
  { to: '/app/technical/in-progress', label: 'Đang sửa', icon: Hammer },
  { to: '/app/technical/completed', label: 'Đã hoàn thành', icon: CheckCircle2 },
  // Everything this technician was ever given, tried or finished.
  { to: '/app/technical/history', label: 'Lịch sử', icon: History },
  { to: '/app/technical/statistics', label: 'Thống kê', icon: BarChart3 },
  // "Giao nhận hàng hóa" is not on this menu any more; its data is untouched.
];

/**
 * Bộ phận buồng phòng: record a room's condition. One entry — the deliveries
 * category is Reception's and the Admin's, not this department's (its records
 * and screens are untouched). The server confines the role to its routes.
 */
export const HOUSEKEEPING_NAV: NavItem[] = [
  // The rooms given to this account today — "Kiểm phòng" and "Dọn phòng".
  { to: '/app/inspections', label: 'Buồng phòng', icon: ClipboardCheck },
  // Its own reports — and its own findings and the money collected against them, nobody else's.
  housekeepingReportGroup({ to: '/app/my-kpi', label: 'Kiểm tra phòng & KPI', icon: Wallet }),
  HOUSEKEEPING_COMPLETED_GROUP,
];

/** Quản lý buồng phòng: its one branch's housekeeping, then its reports. */
export const HOUSEKEEPING_MANAGER_NAV: NavItem[] = [
  ...HOUSEKEEPING_MANAGER_ITEMS,
  housekeepingReportGroup(HOUSEKEEPING_KPI_GROUP),
  HOUSEKEEPING_COMPLETED_GROUP,
];

/**
 * Quản lý kỹ thuật: the incidents of its ticked branches — who holds each one,
 * where it stands, what was done — and "Giao kỹ thuật". The temporary
 * "Nghiệm thu" entry is gone; the inspection code stays dormant on the server.
 */
export const TECHNICAL_MANAGER_NAV: NavItem[] = [
  { to: '/app/reports/technical', label: 'Quản lý sự cố kỹ thuật', icon: Wrench },
];

export function navForRole(role: UserRole | undefined): NavItem[] {
  if (role === 'ADMIN') return ADMIN_NAV;
  if (role === 'BOOKING_DEPARTMENT') return BOOKING_DEPARTMENT_NAV;
  if (role === 'TECHNICAL') return TECHNICAL_NAV;
  // Quản lý kỹ thuật and Tổng quản lý kỹ thuật share the incident workspace;
  // the server scopes each to its own ticked branches.
  if (role === 'TECHNICAL_MANAGER' || role === 'TECHNICAL_GENERAL_MANAGER') return TECHNICAL_MANAGER_NAV;
  if (role === 'HOUSEKEEPING') return HOUSEKEEPING_NAV;
  if (role === 'HOUSEKEEPING_MANAGER') return HOUSEKEEPING_MANAGER_NAV;
  if (role === 'RECEPTION_MANAGER' || role === 'RECEPTION_GENERAL_MANAGER') return RECEPTION_MANAGER_NAV;
  // Receptionist, and anything unrecognised: never the Chứng từ menu.
  return RECEPTIONIST_NAV;
}

/** Human title for the current route, used as the topbar heading. */
export function titleForPath(pathname: string): string {
  if (pathname.startsWith('/app/booking/')) return 'Chi tiết đơn';
  if (pathname.startsWith('/app/charge-documents/')) return 'Chi tiết chứng từ';
  if (pathname.startsWith('/app/chat')) return 'Chat box';
  if (pathname.startsWith('/app/reminders')) return 'Nhắc nhở';
  if (pathname.startsWith('/app/resend-orders')) return 'Gửi lại đơn';
  if (pathname.startsWith('/app/inspections/room/')) return 'Phòng';
  const all = [
    ...ADMIN_NAV,
    ...RECEPTIONIST_NAV,
    ...BOOKING_DEPARTMENT_NAV,
    ...TECHNICAL_NAV,
    ...TECHNICAL_MANAGER_NAV,
    ...HOUSEKEEPING_NAV,
    ...HOUSEKEEPING_MANAGER_NAV,
    // Screens kept off the menu still have their title.
    ...HOUSEKEEPING_MANAGER_SCREENS,
    ...RECEPTION_MANAGER_NAV,
  ];
  const flat = (items: NavItem[]): NavItem[] => items.flatMap((i) => [i, ...flat(i.children ?? [])]);
  const match = flat(all)
    .filter((item) => !item.to.includes('?') && !item.to.includes('#'))
    .slice()
    .sort((a, b) => b.to.length - a.to.length)
    .find((item) => pathname.startsWith(item.to));
  return match?.label ?? 'Kas — Điều phối đặt phòng';
}
