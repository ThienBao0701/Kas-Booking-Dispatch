/**
 * "ADMIN TẠO" — a record a supervisor (Admin, Quản lý lễ tân, Tổng quản lý lễ
 * tân) entered for the branch, as opposed to the desk's own. The words come from
 * the server (`sourceLabel`, from the stored creator role); the tag says them —
 * never colour alone — beside the record's NAME (guest, item, place) in every
 * table, summary and detail, so it is on screen wherever the record is: not in a
 * secondary column that folds away on a phone. The desk's own records carry none.
 */
import { UserCog } from 'lucide-react';

export function SourceTag({ label }: { label: string | null | undefined }) {
  if (!label) return null;
  return (
    <span
      data-testid="source-tag"
      className="ml-1.5 inline-flex items-center gap-1 whitespace-nowrap rounded border border-indigo-300 bg-indigo-50 px-1.5 py-0.5 align-middle text-[11px] font-semibold text-indigo-800"
    >
      <UserCog className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}
