import type { UserRole } from '@prisma/client';

/**
 * Every role's display name — one table for history and audit screens that
 * must say WHO acted in what capacity ("Quản lý lễ tân", "Lễ tân").
 */
export const ROLE_DISPLAY_LABELS: Record<UserRole, string> = {
  ADMIN: 'Admin',
  RECEPTIONIST: 'Lễ tân',
  BOOKING_DEPARTMENT: 'Bộ phận đặt phòng',
  TECHNICAL: 'Kỹ thuật',
  HOUSEKEEPING: 'Buồng phòng',
  TECHNICAL_MANAGER: 'Quản lý kỹ thuật',
  RECEPTION_MANAGER: 'Quản lý lễ tân',
  RECEPTION_GENERAL_MANAGER: 'Tổng quản lý lễ tân',
  HOUSEKEEPING_MANAGER: 'Quản lý buồng phòng',
  TECHNICAL_GENERAL_MANAGER: 'Tổng quản lý kỹ thuật',
};

export function roleLabel(role: UserRole | null | undefined): string | null {
  return role ? ROLE_DISPLAY_LABELS[role] : null;
}
