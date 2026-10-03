import {
  BarChart3,
  ConciergeBell,
  MessageSquareText,
  PackageCheck,
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
      ],
    },
    { to: '/app/reports/technical', label: 'Kỹ thuật', icon: Hammer },
    { to: '/app/reports/housekeeping', label: 'Buồng phòng', icon: BedDouble },
  ],
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
  REPORT_GROUP,
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
  { to: '/app/inspections', label: 'Buồng phòng', icon: ClipboardCheck },
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
  if (role === 'TECHNICAL_MANAGER') return TECHNICAL_MANAGER_NAV;
  if (role === 'HOUSEKEEPING') return HOUSEKEEPING_NAV;
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
  const all = [
    ...ADMIN_NAV,
    ...RECEPTIONIST_NAV,
    ...BOOKING_DEPARTMENT_NAV,
    ...TECHNICAL_NAV,
    ...TECHNICAL_MANAGER_NAV,
    ...HOUSEKEEPING_NAV,
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
