/**
 * The operator's words for a charge status.
 *
 * Shared by the server (XLSX export) and mirrored on the client, following the
 * existing convention: a Prisma enum for the stored value, a Vietnamese label
 * map for anything a person reads.
 */
import type { ChargeStatus } from '@prisma/client';

export const CHARGE_STATUS_LABEL: Record<ChargeStatus, string> = {
  CHUA_XU_LY: 'Chưa xử lý',
  DA_BI_CHARGE: 'Đã bị charge',
  CHARGE_THAT_BAI: 'Charge thất bại',
};

/** Every status, in the order an operator thinks about them. */
export const CHARGE_STATUSES: readonly ChargeStatus[] = [
  'CHUA_XU_LY',
  'DA_BI_CHARGE',
  'CHARGE_THAT_BAI',
];
