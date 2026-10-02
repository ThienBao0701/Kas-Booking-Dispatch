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
 *
 * THE WORKDAY. The account has no permanent branch: "Vào ca" picks the branch
 * and the cleaner, "Đổi chi nhánh" starts a new segment elsewhere, "Kết thúc
 * ca" closes the day and shows its summary. The server stamps every inspection
 * with the shift's branch and refuses one off shift.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  BedDouble,
  ClipboardCheck,
  ClipboardList,
  DoorOpen,
  LogIn,
  LogOut,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import {
  HOUSEKEEPING_SHIFT_KEY,
  ROOM_ISSUES_KEY,
  ROOM_ISSUE_TYPES,
  housekeepingApi,
  type RoomIssueType,
  type WorkShift,
} from '../api/housekeeping';
import { branchesApi } from '../api/bookings';
import { branchLabel } from '../auth/types';
import { Modal } from '../components/Modal';
import { QueryState } from '../components/PageState';
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
import { formatDateTime, hcmToday } from '../lib/format';
import { daysBefore } from '../lib/shiftGroups';

type Checked = Partial<Record<RoomIssueType, string>>;

const FIELD =
  'mt-1 min-h-[2.75rem] w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

export function HousekeepingInspectionPage() {
  const shift = useQuery({ queryKey: HOUSEKEEPING_SHIFT_KEY, queryFn: () => housekeepingApi.shift() });
  const [ended, setEnded] = useState<WorkShift | null>(null);
  const current = shift.data?.shift?.current ?? null;
  return (
    <QueryState isLoading={shift.isLoading} isError={shift.isError} error={shift.error} onRetry={() => void shift.refetch()}>
      {current && shift.data?.shift ? (
        <InspectionWorkspace shift={shift.data.shift} onEnded={setEnded} />
      ) : (
        <StartShift />
      )}
      {ended ? <ShiftSummaryModal shift={ended} onClose={() => setEnded(null)} /> : null}
    </QueryState>
  );
}

/** After any shift change: the shift, the header's branch and the history follow. */
function useShiftChanged() {
  const queryClient = useQueryClient();
  const { refreshUser } = useAuth();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: HOUSEKEEPING_SHIFT_KEY });
    await queryClient.invalidateQueries({ queryKey: ROOM_ISSUES_KEY });
    await refreshUser();
  };
}

/** The branch list for "Vào ca" / "Đổi chi nhánh" — every active branch. */
function BranchSelect({ value, onChange, exclude }: { value: number | ''; onChange: (v: number | '') => void; exclude?: number }) {
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list() });
  return (
    <label className="block text-sm font-medium text-slate-700">
      Chi nhánh
      <select
        className={FIELD}
        value={value}
        aria-label="Chi nhánh"
        data-testid="shift-branch"
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      >
        <option value="">— Chọn chi nhánh —</option>
        {(branches.data?.branches ?? [])
          .filter((b) => b.id !== exclude)
          .map((b) => (
            <option key={b.id} value={b.id}>
              {branchLabel(b)}
            </option>
          ))}
      </select>
    </label>
  );
}

/** "VÀO CA" — where today's work is, and who cleans. */
function StartShift() {
  const changed = useShiftChanged();
  const [branchId, setBranchId] = useState<number | ''>('');
  const [staffName, setStaffName] = usePersistentState('kas.housekeeping.staffName', '');
  const start = useMutation({
    mutationFn: () => housekeepingApi.startShift({ branchId: Number(branchId), staffName: staffName.trim() }),
    onSuccess: changed,
  });
  return (
    <div>
      <PageHeader title="Buồng phòng" description="Chọn chi nhánh làm việc và người dọn buồng để bắt đầu ca." />
      <form
        data-testid="shift-start"
        onSubmit={(e) => {
          e.preventDefault();
          start.mutate();
        }}
        className="max-w-md space-y-4 rounded-2xl border-section border-line bg-white p-4 shadow-sm"
      >
        <BranchSelect value={branchId} onChange={setBranchId} />
        <Input
          label="Tên người dọn buồng"
          value={staffName}
          onChange={(e) => setStaffName(e.target.value)}
          maxLength={100}
          data-testid="shift-staff"
        />
        {start.isError ? <ErrorAlert>{toUserMessage(start.error)}</ErrorAlert> : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={branchId === '' || !staffName.trim()} loading={start.isPending} data-testid="shift-start-submit">
            <LogIn className="h-4 w-4" aria-hidden="true" />
            Vào ca
          </Button>
        </div>
      </form>
    </div>
  );
}

/** One line per branch of the day: where, who, when, and what was found. */
function SegmentList({ shift }: { shift: WorkShift }) {
  return (
    <ul className="space-y-1.5" data-testid="shift-segments">
      {shift.segments.map((seg) => (
        <li key={seg.id} className="rounded-lg border border-line px-3 py-2 text-sm text-slate-700">
          <p className="font-medium text-slate-900">
            {branchLabel(seg.branch)} · {seg.staffName}
          </p>
          <p className="text-xs text-slate-600">
            {formatDateTime(seg.startedAt)} – {seg.endedAt ? formatDateTime(seg.endedAt) : 'đang làm'} · {seg.rooms} phòng ·{' '}
            {seg.inspections} lượt kiểm tra · {seg.issues} vấn đề
          </p>
          {seg.byType.length > 0 ? (
            <p className="text-xs text-slate-500">{seg.byType.map((t) => `${t.label}: ${t.count}`).join(' · ')}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** "KẾT THÚC CA" — the day's summary, branch by branch. */
function ShiftSummaryModal({ shift, onClose }: { shift: WorkShift; onClose: () => void }) {
  return (
    <Modal
      open
      title="Tổng kết ca"
      onClose={onClose}
      footer={
        <Button onClick={onClose} data-testid="shift-summary-close">
          Đóng
        </Button>
      }
    >
      <div className="space-y-3 text-sm" data-testid="shift-summary">
        <p className="text-slate-700">
          {formatDateTime(shift.startedAt)} – {shift.endedAt ? formatDateTime(shift.endedAt) : '—'} · {shift.segments.length} chi nhánh ·{' '}
          {shift.totals.rooms} phòng · {shift.totals.inspections} lượt kiểm tra · {shift.totals.issues} vấn đề
        </p>
        {shift.totals.byType.length > 0 ? (
          <p className="text-slate-600">{shift.totals.byType.map((t) => `${t.label}: ${t.count}`).join(' · ')}</p>
        ) : null}
        <SegmentList shift={shift} />
      </div>
    </Modal>
  );
}

/** "ĐỔI CHI NHÁNH" — a new segment elsewhere; the cleaner may change with it. */
function SwitchBranchModal({ shift, onClose }: { shift: WorkShift; onClose: () => void }) {
  const changed = useShiftChanged();
  const [branchId, setBranchId] = useState<number | ''>('');
  const [staffName, setStaffName] = useState(shift.current?.staffName ?? '');
  const move = useMutation({
    mutationFn: () => housekeepingApi.switchBranch({ branchId: Number(branchId), staffName: staffName.trim() || undefined }),
    onSuccess: async () => {
      await changed();
      onClose();
    },
  });
  return (
    <Modal
      open
      title="Đổi chi nhánh"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button onClick={() => move.mutate()} disabled={branchId === ''} loading={move.isPending} data-testid="shift-switch-confirm">
            Đổi chi nhánh
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <BranchSelect value={branchId} onChange={setBranchId} exclude={shift.current?.branch.id} />
        <Input label="Tên người dọn buồng" value={staffName} onChange={(e) => setStaffName(e.target.value)} maxLength={100} />
        {move.isError ? <ErrorAlert>{toUserMessage(move.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

function InspectionWorkspace({ shift, onEnded }: { shift: WorkShift; onEnded: (shift: WorkShift) => void }) {
  const queryClient = useQueryClient();
  const changed = useShiftChanged();
  const current = shift.current!;
  const { rooms } = useBranchRooms(current.branch.id);
  const today = hcmToday();
  const [switching, setSwitching] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const end = useMutation({
    mutationFn: () => housekeepingApi.endShift(),
    onSuccess: async ({ shift: day }) => {
      setConfirmEnd(false);
      onEnded(day);
      await changed();
    },
  });

  const [roomNumber, setRoomNumber] = useState('');
  // Optional: the shift's cleaner is recorded when this is left empty.
  const [staffName, setStaffName] = useState('');
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
  const ready = roomNumber.trim().length > 0 && selected.length > 0 && !otherMissing;

  const save = useMutation({
    mutationFn: () =>
      housekeepingApi.createInspection({
        roomNumber: roomNumber.trim(),
        staffName: staffName.trim() || undefined,
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

      {/* WHERE TODAY'S WORK IS — always in view, with the two shift actions. */}
      <section
        data-testid="shift-current"
        className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3"
      >
        <div className="text-sm">
          <p className="font-semibold text-brand-800">Đang làm tại: {branchLabel(current.branch)}</p>
          <p className="text-slate-700">
            Người dọn buồng: {current.staffName} · từ {formatDateTime(current.startedAt)} · {current.inspections} lượt kiểm tra
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setSwitching(true)} data-testid="shift-switch">
            <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
            Đổi chi nhánh
          </Button>
          <Button variant="secondary" onClick={() => setConfirmEnd(true)} data-testid="shift-end">
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Kết thúc ca
          </Button>
        </div>
      </section>
      {shift.segments.length > 1 ? (
        <details className="mb-4 rounded-xl border border-line bg-white px-4 py-2 text-sm">
          <summary className="cursor-pointer font-medium text-slate-800">Các chi nhánh trong ca ({shift.segments.length})</summary>
          <div className="mt-2">
            <SegmentList shift={shift} />
          </div>
        </details>
      ) : null}
      {switching ? <SwitchBranchModal shift={shift} onClose={() => setSwitching(false)} /> : null}
      {confirmEnd ? (
        <Modal
          open
          title="Kết thúc ca"
          onClose={() => setConfirmEnd(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmEnd(false)}>
                Hủy
              </Button>
              <Button onClick={() => end.mutate()} loading={end.isPending} data-testid="shift-end-confirm">
                Kết thúc ca
              </Button>
            </>
          }
        >
          <p className="text-sm text-slate-700">Kết thúc ca làm việc hôm nay? Sau khi kết thúc, cần “Vào ca” lại để ghi nhận kiểm tra.</p>
          {end.isError ? <ErrorAlert>{toUserMessage(end.error)}</ErrorAlert> : null}
        </Modal>
      ) : null}

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
              label="Người dọn phòng (nếu khác)"
              value={staffName}
              onChange={(e) => setStaffName(e.target.value)}
              maxLength={100}
              placeholder={current.staffName}
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
