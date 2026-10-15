/**
 * "NHẬP BÙ" IN WORDS — the one wording every export uses, so the XLSX, the PDFs
 * and the screen name the same two people the same way:
 *
 *   NHẬP BÙ · Người nhập bù: Nguyễn A (Quản lý lễ tân) · Nhập bù cho: Trần B
 *   Nhập lúc 08/10/2026 09:15 · Nội dung bổ sung: Lễ tân quên ghi khoản thu P302
 *
 * "Người nhập bù" is the authenticated account that entered it (stamped by the
 * server); "Nhập bù cho" is the receptionist of the original shift, who stays
 * the record's creator. A stamp with no name — never expected, but never
 * guessed either — reads "Không có dữ liệu lịch sử".
 */
import { hcmDateTime } from '../report/format';

export const NO_HISTORY = 'Không có dữ liệu lịch sử';

export interface LateEntryStamp {
  enteredBy: { name: string | null };
  enteredByRoleLabel: string | null;
  reason: string | null;
  enteredAt: string;
}

export function lateEntryLines(late: LateEntryStamp, forName: string | null): string[] {
  const by = late.enteredBy.name?.trim() || NO_HISTORY;
  const role = late.enteredByRoleLabel ? ` (${late.enteredByRoleLabel})` : '';
  const target = forName?.trim() || NO_HISTORY;
  const lines = [`NHẬP BÙ · Người nhập bù: ${by}${role} · Nhập bù cho: ${target}`];
  const when = `Nhập lúc ${hcmDateTime(new Date(late.enteredAt))}`;
  lines.push(late.reason ? `${when} · Nội dung bổ sung: ${late.reason}` : when);
  return lines;
}
