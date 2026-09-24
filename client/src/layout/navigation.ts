import {
  BellRing,
  Building2,
  CheckCircle2,
  ClipboardPaste,
  NotebookPen,
  FileText,
  Hammer,
  History,
  Inbox,
  LayoutDashboard,
  MessagesSquare,
  RotateCcw,
  ScanSearch,
  Send,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { UserRole } from '../auth/types';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/** Admin operates the whole dispatch centre and reviews creation proofs. */
export const ADMIN_NAV: NavItem[] = [
  { to: '/app/dashboard', label: 'Tổng quan', icon: LayoutDashboard },
  { to: '/app/dispatch', label: 'Nhập đơn', icon: ClipboardPaste },
  { to: '/app/waiting', label: 'Chờ chi nhánh tạo', icon: Inbox },
  { to: '/app/pending-review', label: 'Chờ kiểm tra', icon: ScanSearch },
  { to: '/app/rejected', label: 'Cần tạo lại', icon: RotateCcw },
  { to: '/app/completed', label: 'Đã xác nhận đúng', icon: CheckCircle2 },
  { to: '/app/history', label: 'Lịch sử', icon: History },
  // "Sự cố khách sạn" and "Bàn giao ca" are gone: incidents live under
  // "Báo cáo vấn đề" -> "Sự cố vật chất đang xử lý"; handover has no screen.
  { to: '/app/reports', label: 'Báo cáo vấn đề', icon: NotebookPen },
  { to: '/app/resend-orders', label: 'Gửi lại đơn', icon: Send },
  { to: '/app/charge-documents', label: 'Chứng từ', icon: FileText },
  { to: '/app/chat', label: 'Chat box', icon: MessagesSquare },
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
 * FIVE ENTRIES CAME OUT, AND NO SCREEN OR RECORD WENT WITH THEM.
 *
 * "Cần tạo lại", "Đã xác nhận đúng" and "Lịch sử" are no longer on reception's
 * menu; their routes still exist, so a notification or booking link that
 * points there still opens. "Báo cáo sự cố" is a category of "Báo cáo vấn đề"
 * now (same form, same incident system), and "Bàn giao ca" has no screen — its
 * history and API are untouched.
 */
export const RECEPTIONIST_NAV: NavItem[] = [
  { to: '/app/new', label: 'Đơn mới', icon: Inbox },
  { to: '/app/pending-review', label: 'Chờ Admin kiểm tra', icon: ScanSearch },
  { to: '/app/reports', label: 'Báo cáo vấn đề', icon: NotebookPen },
  { to: '/app/chat', label: 'Chat box', icon: MessagesSquare },
  { to: '/app/reminders', label: 'Nhắc nhở', icon: BellRing },
];

/**
 * Bộ phận kỹ thuật works three queues and nothing else.
 *
 * The three items are WORKFLOW STATES, not saved filters: an incident is in
 * exactly one of them, and it moves between them only by a technician acting on
 * it. No booking screen appears here — this role has no branch and no part in
 * dispatch.
 */
export const TECHNICAL_NAV: NavItem[] = [
  { to: '/app/technical/new', label: 'Sự cố khách sạn', icon: Wrench },
  { to: '/app/technical/in-progress', label: 'Đang sửa', icon: Hammer },
  { to: '/app/technical/completed', label: 'Đã hoàn thành', icon: CheckCircle2 },
];

export function navForRole(role: UserRole | undefined): NavItem[] {
  if (role === 'ADMIN') return ADMIN_NAV;
  if (role === 'BOOKING_DEPARTMENT') return BOOKING_DEPARTMENT_NAV;
  if (role === 'TECHNICAL') return TECHNICAL_NAV;
  // Receptionist, and anything unrecognised: never the Chứng từ menu.
  return RECEPTIONIST_NAV;
}

/** Human title for the current route, used as the topbar heading. */
export function titleForPath(pathname: string): string {
  if (pathname.startsWith('/app/booking/')) return 'Chi tiết đơn';
  if (pathname.startsWith('/app/charge-documents/')) return 'Chi tiết chứng từ';
  if (pathname.startsWith('/app/chat/')) return 'Chat box';
  if (pathname.startsWith('/app/reminders')) return 'Nhắc nhở';
  if (pathname.startsWith('/app/resend-orders')) return 'Gửi lại đơn';
  const all = [...ADMIN_NAV, ...RECEPTIONIST_NAV, ...BOOKING_DEPARTMENT_NAV, ...TECHNICAL_NAV];
  const match = all
    .slice()
    .sort((a, b) => b.to.length - a.to.length)
    .find((item) => pathname.startsWith(item.to));
  return match?.label ?? 'Kas — Điều phối đặt phòng';
}
