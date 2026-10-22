/** Small display helpers of the housekeeping manager's screens. */

const WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

/** "Thứ Năm" for "2026-10-15" — the calendar day, whatever the browser's zone. */
export function weekdayOf(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return '';
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
}

/**
 * A hotel as housekeeping names it. The Quản lý buồng phòng and the Bộ phận buồng
 * phòng read it by its ADDRESS only ("05 Trương Định"); the Admin, who reads every
 * branch at once, also by its number ("Chi nhánh 1 — 05 Trương Định"). Display
 * only — every scope and permission still uses the branch's id on the server.
 */
export function hotelName(branch: { address: string; branchNumber?: number | null }, withNumber: boolean): string {
  return withNumber && branch.branchNumber ? `Chi nhánh ${branch.branchNumber} — ${branch.address}` : branch.address;
}

/** "BP" for "Bùi Phương" — the first and last word. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : '';
  return (first + last).toLocaleUpperCase('vi');
}

