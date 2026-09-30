/**
 * "ADMIN TẠO" — a record a supervisor (Admin, Quản lý lễ tân, Tổng quản lý lễ
 * tân) entered for the branch, as opposed to the desk's own. The words come from
 * the server (`sourceLabel`); the tag says them — never colour alone — wherever a
 * record's origin is shown: Reception's tables and detail, and the Admin's.
 */
export function SourceTag({ label }: { label: string | null | undefined }) {
  if (!label) return null;
  return (
    <span
      data-testid="source-tag"
      className="ml-1.5 inline-flex whitespace-nowrap rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700"
    >
      {label}
    </span>
  );
}
