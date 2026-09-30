/**
 * "BUỒNG PHÒNG" — Bộ phận buồng phòng's inspection workspace.
 *
 * TWO HALVES, ONE SCREEN. On the left, recording: who cleaned it, which room —
 * CHOSEN from the branch's room catalog, never typed — then the conditions found
 * (one checkbox each, a description where it needs one) and Lưu. On the right,
 * what this person has recorded: a few facts for the period (inspections,
 * findings, rooms with findings, the most frequent condition), filters by day,
 * room and condition, and the history itself.
 *
 * NOTHING ABOUT MONEY. Whether Reception collected, how much and how, belongs to
 * the front desk; the server sends this role none of it, and nothing here asks.
 * Nothing here asks for a branch either: the server stamps the account's hotel.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BedDouble, ClipboardCheck, ClipboardList, DoorOpen, RefreshCw, TriangleAlert } from 'lucide-react';
import {
  ROOM_ISSUES_KEY,
  ROOM_ISSUE_TYPES,
  housekeepingApi,
  type RoomIssueType,
} from '../api/housekeeping';
import { toUserMessage } from '../api/errors';
import { useAuth } from '../auth/AuthProvider';
import { Button } from '../components/Button';
import { ErrorAlert } from '../components/ErrorAlert';
import { Input } from '../components/Input';
import { PageHeader } from '../components/PageState';
import { RoomIssueTable } from '../components/RoomIssueViews';
import { Toast } from '../components/Toast';
import { StatCard } from '../components/StatCard';
import { DateRangeField, type DateRangeValue } from '../components/DateRangeField';
import { PeriodQuickPicks } from '../components/PeriodQuickPicks';
import { usePersistentState } from '../hooks/usePersistentState';
import { useBranchRooms } from '../hooks/useBranchRooms';
import { hcmToday } from '../lib/format';
import { daysBefore } from '../lib/shiftGroups';

type Checked = Partial<Record<RoomIssueType, string>>;

const FIELD =
  'mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

export function HousekeepingInspectionPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { rooms } = useBranchRooms(user?.branch?.id ?? null);
  const today = hcmToday();

  const [roomNumber, setRoomNumber] = useState('');
  // The same person usually cleans a whole floor: remembered between rooms, and
  // between visits, but never sent anywhere except with the inspection itself.
  const [staffName, setStaffName] = usePersistentState('kas.housekeeping.staffName', '');
  const [checked, setChecked] = useState<Checked>({});
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // The history's filters: the last seven days by default, "Hôm nay" one tap away.
  const [range, setRange] = useState<DateRangeValue>({ from: daysBefore(today, 6), to: today });
  const [roomFilter, setRoomFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<RoomIssueType | ''>('');
  const rangeValid = range.from !== '' && range.to !== '' && range.from <= range.to;
  const filter = {
    from: rangeValid ? range.from : undefined,
    to: rangeValid ? range.to : undefined,
    roomNumber: roomFilter || undefined,
    type: typeFilter || undefined,
  };

  const history = useQuery({
    queryKey: [...ROOM_ISSUES_KEY, 'mine', filter],
    queryFn: () => housekeepingApi.issues(filter),
    enabled: rangeValid,
    refetchInterval: 30_000,
  });
  const facts = history.data?.inspectionSummary;

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
        title="Buồng phòng"
        description="Ghi nhận tình trạng phòng sau khi dọn. Mỗi tình trạng được lưu thành một vấn đề riêng để lễ tân xử lý."
        actions={
          <Button variant="secondary" onClick={() => void history.refetch()} aria-label="Làm mới">
            <RefreshCw className={`h-4 w-4 ${history.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />
            Làm mới
          </Button>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        {/* ---------------- Recording ---------------- */}
        <form
          data-testid="inspection-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) save.mutate();
          }}
          className="h-fit space-y-4 rounded-2xl border-section border-line bg-white p-4 shadow-sm"
        >
          <h2 className="text-sm font-semibold text-slate-900">Kiểm tra phòng</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <Input
              label="Người dọn phòng"
              value={staffName}
              onChange={(e) => setStaffName(e.target.value)}
              maxLength={100}
              data-testid="inspection-staff"
            />
            {rooms && rooms.length > 0 ? (
              <label className="block text-sm font-medium text-slate-700">
                Số phòng
                <select
                  className={FIELD}
                  value={roomNumber}
                  aria-label="Số phòng"
                  onChange={(e) => setRoomNumber(e.target.value)}
                  data-testid="inspection-room"
                >
                  <option value="">— Chọn phòng —</option>
                  {rooms.map((room) => (
                    <option key={room} value={room}>
                      {room}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <Input
                label="Số phòng"
                value={roomNumber}
                onChange={(e) => setRoomNumber(e.target.value)}
                maxLength={50}
                placeholder="Ví dụ: 302"
                data-testid="inspection-room"
              />
            )}
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-slate-700">Tình trạng phòng</legend>
            <ul className="grid gap-2">
              {ROOM_ISSUE_TYPES.map((t) => {
                const on = checked[t.code] !== undefined;
                return (
                  <li
                    key={t.code}
                    className={`rounded-xl border px-3 py-2 ${on ? 'border-brand-600 bg-brand-50/40' : 'border-line'}`}
                  >
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
                        className="mt-2 w-full rounded-lg border border-line-strong px-3 py-2 text-sm hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
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

        {/* ---------------- What I recorded ---------------- */}
        <div className="min-w-0 space-y-4">
          <section
            aria-label="Lọc lịch sử kiểm tra"
            data-testid="inspection-filters"
            className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border-section border-line bg-white px-4 py-3 shadow-sm"
          >
            <div className="min-w-[17rem] max-w-full">
              <DateRangeField legend="Ngày kiểm tra" value={range} onChange={setRange} max={today} testId="inspection-range" />
            </div>
            <PeriodQuickPicks value={range} onChange={setRange} today={today} testId="inspection-range" />
            <label className="block min-w-[8rem] text-xs font-medium text-slate-500">
              Phòng
              <select
                className={FIELD}
                value={roomFilter}
                aria-label="Lọc theo phòng"
                data-testid="inspection-filter-room"
                onChange={(e) => setRoomFilter(e.target.value)}
              >
                <option value="">Tất cả phòng</option>
                {(rooms ?? []).map((room) => (
                  <option key={room} value={room}>
                    {room}
                  </option>
                ))}
              </select>
            </label>
            <label className="block min-w-[12rem] text-xs font-medium text-slate-500">
              Tình trạng
              <select
                className={FIELD}
                value={typeFilter}
                aria-label="Lọc theo tình trạng"
                data-testid="inspection-filter-type"
                onChange={(e) => setTypeFilter(e.target.value as RoomIssueType | '')}
              >
                <option value="">Tất cả tình trạng</option>
                {ROOM_ISSUE_TYPES.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          </section>

          {!rangeValid ? (
            <p className="rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
              Hãy chọn đủ ngày bắt đầu và ngày kết thúc.
            </p>
          ) : (
            <>
              {/* Counted by the server over every matching finding — facts, not a score. */}
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="inspection-facts">
                <StatCard label="Lượt kiểm tra" value={facts?.inspections ?? 0} icon={ClipboardList} />
                <StatCard label="Vấn đề ghi nhận" value={facts?.issues ?? 0} icon={TriangleAlert} tone="amber" />
                <StatCard label="Phòng có vấn đề" value={facts?.rooms ?? 0} icon={DoorOpen} />
                <StatCard
                  label={facts?.byType[0] ? `Nhiều nhất: ${facts.byType[0].label}` : 'Nhiều nhất: —'}
                  value={facts?.byType[0]?.count ?? 0}
                  icon={BedDouble}
                />
              </div>

              <RoomIssueTable
                mode="housekeeping"
                title="Lịch sử kiểm tra của tôi"
                issues={history.data?.issues ?? []}
                isLoading={history.isLoading}
                isError={history.isError}
                error={history.error}
                onRetry={() => void history.refetch()}
                emptyTitle="Chưa có kiểm tra nào trong khoảng này"
                emptyMessage="Các phòng bạn kiểm tra sẽ hiện ở đây. Đổi khoảng ngày hoặc bỏ bộ lọc để xem thêm."
              />
            </>
          )}
        </div>
      </div>
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
