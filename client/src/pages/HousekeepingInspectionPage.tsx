/**
 * "KIỂM TRA PHÒNG" — Bộ phận buồng phòng records what a room looked like.
 *
 * THE FLOW: who cleaned it, which room, then the conditions found — one
 * checkbox per condition, with a description where it needs one — and Lưu. One
 * inspection can find several things; each becomes its own issue, which
 * Reception then settles on its own. Nothing here asks for a branch: the
 * inspection is stamped with the account's hotel by the server.
 *
 * WHAT THIS ROLE SEES AFTERWARDS is its own inspections and THAT each issue was
 * settled or waived — not the amount or the reason, which are the front desk's.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, RefreshCw } from 'lucide-react';
import {
  ROOM_ISSUES_KEY,
  ROOM_ISSUE_TYPES,
  housekeepingApi,
  type RoomIssueType,
} from '../api/housekeeping';
import { toUserMessage } from '../api/errors';
import { Button } from '../components/Button';
import { ErrorAlert } from '../components/ErrorAlert';
import { Input } from '../components/Input';
import { PageHeader } from '../components/PageState';
import { RoomIssueTable } from '../components/RoomIssueViews';
import { Toast } from '../components/Toast';
import { usePersistentState } from '../hooks/usePersistentState';

type Checked = Partial<Record<RoomIssueType, string>>;

export function HousekeepingInspectionPage() {
  const queryClient = useQueryClient();
  const [roomNumber, setRoomNumber] = useState('');
  // The same person usually cleans a whole floor: remembered between rooms, and
  // between visits, but never sent anywhere except with the inspection itself.
  const [staffName, setStaffName] = usePersistentState('kas.housekeeping.staffName', '');
  const [checked, setChecked] = useState<Checked>({});
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const history = useQuery({
    queryKey: [...ROOM_ISSUES_KEY, 'mine'],
    queryFn: () => housekeepingApi.issues(),
    refetchInterval: 30_000,
  });

  const selected = ROOM_ISSUE_TYPES.filter((t) => checked[t.code] !== undefined);
  // "Vấn đề khác" says nothing on its own: it needs its description.
  const otherMissing = checked.OTHER !== undefined && checked.OTHER.trim().length === 0;
  const ready =
    roomNumber.trim().length > 0 && staffName.trim().length > 0 && selected.length > 0 && !otherMissing;

  const save = useMutation({
    mutationFn: () =>
      housekeepingApi.createInspection({
        roomNumber: roomNumber.trim(),
        staffName: staffName.trim(),
        issues: selected.map((t) => ({ type: t.code, note: checked[t.code]?.trim() || undefined })),
      }),
    onSuccess: async ({ inspection }) => {
      setError(null);
      setRoomNumber('');
      setChecked({});
      setToast(`Đã lưu kiểm tra phòng ${inspection.roomNumber} (${inspection.issues.length} vấn đề).`);
      await queryClient.invalidateQueries({ queryKey: ROOM_ISSUES_KEY });
    },
    onError: (e) => setError(toUserMessage(e)),
  });

  function toggle(type: RoomIssueType, on: boolean) {
    setChecked((prev) => {
      const next = { ...prev };
      if (on) next[type] = '';
      else delete next[type];
      return next;
    });
  }

  return (
    <div>
      <PageHeader
        title="Kiểm tra phòng"
        description="Ghi nhận tình trạng sử dụng phòng. Mỗi tình trạng được lưu thành một vấn đề riêng để lễ tân xử lý thu tiền."
        actions={
          <Button variant="secondary" onClick={() => void history.refetch()} aria-label="Làm mới">
            <RefreshCw className={`h-4 w-4 ${history.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            Làm mới
          </Button>
        }
      />

      <form
        data-testid="inspection-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) save.mutate();
        }}
        className="mb-6 space-y-4 rounded-2xl border border-slate-300 bg-white p-4 shadow-sm"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Người dọn phòng"
            value={staffName}
            onChange={(e) => setStaffName(e.target.value)}
            maxLength={100}
            data-testid="inspection-staff"
          />
          <Input
            label="Số phòng"
            value={roomNumber}
            onChange={(e) => setRoomNumber(e.target.value)}
            maxLength={50}
            placeholder="Ví dụ: 302"
            data-testid="inspection-room"
          />
        </div>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-700">Tình trạng phòng</legend>
          <ul className="space-y-2">
            {ROOM_ISSUE_TYPES.map((t) => {
              const on = checked[t.code] !== undefined;
              return (
                <li key={t.code} className={`rounded-xl border px-3 py-2.5 ${on ? 'border-brand-600 bg-brand-50/40' : 'border-slate-200'}`}>
                  <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium text-slate-800">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => toggle(t.code, e.target.checked)}
                      data-testid={`inspection-type-${t.code}`}
                      className="h-4 w-4 accent-brand-600"
                    />
                    {t.label}
                  </label>
                  {on ? (
                    <input
                      value={checked[t.code] ?? ''}
                      onChange={(e) => setChecked((prev) => ({ ...prev, [t.code]: e.target.value }))}
                      maxLength={2000}
                      placeholder={t.code === 'OTHER' ? 'Mô tả vấn đề (bắt buộc)' : 'Mô tả thêm (không bắt buộc)'}
                      aria-label={`Mô tả — ${t.label}`}
                      data-testid={`inspection-note-${t.code}`}
                      className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </fieldset>

        {error ? <ErrorAlert>{error}</ErrorAlert> : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={!ready} loading={save.isPending} data-testid="inspection-save">
            <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
            Lưu kiểm tra
          </Button>
        </div>
      </form>

      <RoomIssueTable
        mode="housekeeping"
        title="Lịch sử kiểm tra của tôi"
        issues={history.data?.issues ?? []}
        isLoading={history.isLoading}
        isError={history.isError}
        error={history.error}
        onRetry={() => void history.refetch()}
        emptyTitle="Chưa có kiểm tra nào"
        emptyMessage="Các phòng bạn kiểm tra sẽ hiện ở đây."
      />
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
