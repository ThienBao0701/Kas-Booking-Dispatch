/**
 * "NGƯỜI NHẬP VẤN ĐỀ" AND "NGƯỜI HOÀN THÀNH" — one pair of columns for every
 * completed-issue table (Request, Facility, Service Quality), from the accounts
 * the server recorded: the creator, and whoever pressed "Hoàn thành". Never a
 * typed name. A record from before a completer was kept says "Hệ thống" — no
 * person is invented for it.
 */
import type { DataColumn } from '../components/DataTable';

export const NO_ACTOR = 'Hệ thống';

export function actorColumns<T>(entered: (row: T) => string | null | undefined, completed: (row: T) => string | null | undefined): DataColumn<T>[] {
  return [
    {
      key: 'entered-by',
      header: 'Người nhập vấn đề',
      className: 'whitespace-nowrap text-slate-700',
      render: (row) => entered(row) || NO_ACTOR,
    },
    {
      key: 'completed-by',
      header: 'Người hoàn thành',
      className: 'whitespace-nowrap text-slate-700',
      render: (row) => completed(row) || NO_ACTOR,
    },
  ];
}
