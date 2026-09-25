/**
 * INCIDENT REPORTING — the one issue form, and the incident views.
 *
 * "Sự cố vật chất đang xử lý" in "Báo cáo vấn đề" is now the only place a hotel
 * incident is reported or monitored, for reception and for the Admin alike. The
 * standalone "Báo cáo sự cố" / "Sự cố khách sạn" screen these came from is gone;
 * its FORM, its range summary and its PDF export live here, unchanged, and still
 * create and read the same `HotelIssue` rows through the same `/api/issues` the
 * technical department works from. There is no second incident system.
 */
import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ImageUp, X } from 'lucide-react';
import {
  AREA_FIELDS,
  ISSUE_AREAS,
  ISSUE_AREA_SUBTYPES,
  ISSUE_CATEGORIES,
  REPAIR_OUTCOME_LABEL,
  issuesApi,
  requiresLocationDetail,
  type Issue,
  type IssueAreaCategory,
  type IssueAreaSubtype,
  type IssueCategory,
  issueCategoryLabel,
} from '../api/issues';
import { toUserMessage } from '../api/errors';
import { Button } from './Button';
import { Modal } from './Modal';
import { ErrorAlert } from './ErrorAlert';
import { DateRangeField, type DateRangeValue } from './DateRangeField';
import { DataTable, type DataColumn } from './DataTable';
import type { SectionFrame } from './ReportSection';
import { IssueStatusBadge, IssueTimeline } from './IssueViews';
import { reportsApi } from '../api/reports';
import { formatDateTime, hcmToday } from '../lib/format';

const ACCEPTED = 'image/png,image/jpeg,image/webp';
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * The report form, which CHANGES WITH THE AREA.
 *
 * "Sự cố" is asked first, and it decides what else is asked: a room number for a
 * room, a floor for a hallway or a staircase, a fixture for the lobby. Fields
 * that do not apply are not rendered at all rather than disabled — a greyed-out
 * "Số phòng" on a rooftop report is a question the receptionist still has to
 * read and dismiss.
 *
 * `AREA_FIELDS` is the same table the server validates against, so what the form
 * asks for and what the API accepts cannot disagree. The server is still the
 * authority: it re-checks every rule, and refuses a request that skipped the
 * form entirely.
 */
export function NewIssueModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (issue: Issue) => void;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [areaCategory, setAreaCategory] = useState<IssueAreaCategory>('ROOM');
  const [category, setCategory] = useState<IssueCategory>('AIR_CONDITIONER');
  const [areaSubtype, setAreaSubtype] = useState<IssueAreaSubtype | ''>('');
  const [roomNumber, setRoomNumber] = useState('');
  const [floorNumber, setFloorNumber] = useState('');
  const [locationDetail, setLocationDetail] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const fields = AREA_FIELDS[areaCategory];
  const detailRequired = requiresLocationDetail(areaCategory, areaSubtype);

  const create = useMutation({
    mutationFn: () =>
      issuesApi.create({
        areaCategory,
        description,
        category: fields.category ? category : undefined,
        roomNumber: fields.roomNumber ? roomNumber : undefined,
        floorNumber: fields.floorNumber ? floorNumber : undefined,
        areaSubtype: fields.areaSubtype && areaSubtype ? areaSubtype : undefined,
        locationDetail: locationDetail || undefined,
        photo: file ?? undefined,
      }),
    onSuccess: ({ issue }) => {
      void queryClient.invalidateQueries({ queryKey: ['issues'] });
      clearFile();
      onClose();
      onCreated(issue);
    },
  });

  function clearFile() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  function onPick(picked: File | undefined) {
    setLocalError(null);
    if (!picked) return;
    if (!ACCEPTED.split(',').includes(picked.type)) {
      setLocalError('Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP.');
      return;
    }
    if (picked.size > MAX_BYTES) {
      setLocalError('Ảnh vượt quá 10 MB.');
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(picked);
    setPreviewUrl(URL.createObjectURL(picked));
  }

  /**
   * The description is ALWAYS required, and trimmed before it counts — "   " is
   * not a description. The other requirements follow the area.
   */
  const ready =
    description.trim().length > 0 &&
    (!fields.roomNumber || roomNumber.trim().length > 0) &&
    (!fields.floorNumber || floorNumber.trim().length > 0) &&
    (!fields.areaSubtype || areaSubtype !== '') &&
    (!detailRequired || locationDetail.trim().length > 0);

  const inputClass =
    'w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

  return (
    <Modal
      open
      title="Báo cáo sự cố mới"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!ready}>
            Gửi báo cáo
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-sm font-medium text-slate-600">
          Sự cố
          <select
            className={`${inputClass} mt-1`}
            value={areaCategory}
            aria-label="Sự cố"
            onChange={(e) => {
              setAreaCategory(e.target.value as IssueAreaCategory);
              // Clear what the new area does not ask for, so a value typed under
              // a previous choice cannot be submitted invisibly.
              setAreaSubtype('');
              setRoomNumber('');
              setFloorNumber('');
              setLocationDetail('');
            }}
          >
            {ISSUE_AREAS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>

        {fields.roomNumber ? (
          <label className="block text-sm font-medium text-slate-600">
            Số phòng
            <input
              className={`${inputClass} mt-1`}
              value={roomNumber}
              onChange={(e) => setRoomNumber(e.target.value)}
              placeholder="Ví dụ: 301"
              maxLength={50}
            />
          </label>
        ) : null}

        {fields.floorNumber ? (
          <label className="block text-sm font-medium text-slate-600">
            Số tầng
            <input
              className={`${inputClass} mt-1`}
              value={floorNumber}
              onChange={(e) => setFloorNumber(e.target.value)}
              placeholder="Ví dụ: 3"
              maxLength={50}
            />
          </label>
        ) : null}

        {fields.areaSubtype ? (
          <label className="block text-sm font-medium text-slate-600">
            Loại sự cố
            <select
              className={`${inputClass} mt-1`}
              value={areaSubtype}
              aria-label="Loại sự cố"
              onChange={(e) => setAreaSubtype(e.target.value as IssueAreaSubtype | '')}
            >
              <option value="">— Chọn —</option>
              {ISSUE_AREA_SUBTYPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {fields.category ? (
          <label className="block text-sm font-medium text-slate-600">
            Loại sự cố
            <select
              className={`${inputClass} mt-1`}
              value={category}
              aria-label="Loại sự cố"
              onChange={(e) => setCategory(e.target.value as IssueCategory)}
            >
              {ISSUE_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {/*
          Shown for every area, but only REQUIRED where the area alone cannot say
          where to go: "Các Khu Vực Còn Lại", and "Khác" in the lobby.
        */}
        <label className="block text-sm font-medium text-slate-600">
          Vị trí cụ thể{' '}
          {detailRequired ? null : <span className="font-normal text-slate-400">(không bắt buộc)</span>}
          <input
            className={`${inputClass} mt-1`}
            value={locationDetail}
            onChange={(e) => setLocationDetail(e.target.value)}
            placeholder="Ví dụ: hồ bơi tầng thượng, kho tầng hầm…"
            maxLength={500}
          />
        </label>

        <label className="block text-sm font-medium text-slate-600">
          Mô tả sự cố
          <textarea
            className={`${inputClass} mt-1`}
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            placeholder="Mô tả sự cố…"
          />
        </label>

        <div>
          <span className="mb-1 block text-sm font-medium text-slate-600">Ảnh (không bắt buộc)</span>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED}
            className="sr-only"
            onChange={(e) => onPick(e.target.files?.[0] ?? undefined)}
          />
          {previewUrl ? (
            <div className="flex items-start gap-3">
              <img
                src={previewUrl}
                alt="Ảnh sẽ gửi"
                className="h-24 w-24 rounded-xl border border-slate-200 object-cover"
              />
              <button
                type="button"
                onClick={clearFile}
                className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" /> Chọn ảnh khác
              </button>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => inputRef.current?.click()}>
              <ImageUp className="h-4 w-4" aria-hidden="true" />
              Chọn ảnh
            </Button>
          )}
        </div>

        {localError ? <ErrorAlert>{localError}</ErrorAlert> : null}
        {create.isError ? <ErrorAlert>{toUserMessage(create.error)}</ErrorAlert> : null}
      </div>
    </Modal>
  );
}

/**
 * The counts for the chosen period.
 *
 * RENDERED AS CARDS, NOT A TABLE. There is exactly one `<table>` on this screen
 * and it is the incident list; a second one would make "the table" ambiguous to
 * anybody — a screen reader, a test, or a person — trying to refer to it.
 *
 * "Lượt không sửa được" and "Cần xử lý lại" sit side by side on purpose. They are
 * different numbers that sound like the same one: the first counts EVENTS (an
 * incident three technicians failed on contributes three), the second counts
 * INCIDENTS currently waiting to be picked up again (that same incident
 * contributes one, and none at all once somebody accepts it).
 */
export function IncidentRangeSummary({
  from,
  to,
  branchId,
}: {
  from: string;
  to: string;
  branchId: number | null;
}) {
  const summary = useQuery({
    queryKey: ['incident-range-summary', { from, to, branchId }],
    queryFn: () => reportsApi.incidentSummary({ from, to, branchId: branchId ?? undefined }),
  });

  if (!summary.data) return null;
  const s = summary.data.summary;

  const cells: { label: string; value: number; tone?: string }[] = [
    { label: 'Tổng sự cố phát sinh', value: s.total },
    { label: 'Sự cố khách sạn', value: s.newCount },
    { label: 'Đang sửa', value: s.inProgressCount },
    { label: 'Đã hoàn thành', value: s.completedCount },
    { label: 'Lượt không sửa được', value: s.cannotRepairAttempts, tone: 'text-rose-700' },
    { label: 'Cần xử lý lại', value: s.needsReworkIssues, tone: 'text-rose-700' },
  ];

  return (
    <div className="mb-4" data-testid="incident-range-summary">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((c) => (
          <div key={c.label} className="rounded-xl border border-slate-300 bg-white p-3 shadow-sm">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{c.label}</p>
            <p className={`text-lg font-semibold ${c.tone ?? 'text-slate-900'}`}>{c.value}</p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Ngoài khoảng thời gian này, hiện còn{' '}
        <strong className="text-slate-700">{s.outstandingTotal}</strong> sự cố chưa hoàn thành trên
        toàn hệ thống.
      </p>
    </div>
  );
}

/**
 * The incident export.
 *
 * Opens the PDF endpoint in a new tab rather than fetching it into memory: the
 * request carries the session cookie, the browser handles the download, and the
 * file never has to be turned into a blob URL the page must then revoke.
 */
export function IncidentExportModal({
  onClose,
  branchId,
  initialRange,
}: {
  onClose: () => void;
  branchId: number | null;
  /** The period already on screen, when one is applied. */
  initialRange: DateRangeValue | null;
}) {
  const today = hcmToday();
  const [range, setRange] = useState<DateRangeValue>(initialRange ?? { from: today, to: today });

  const ready = range.from !== '' && range.to !== '';

  function download() {
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (branchId != null) params.set('branchId', String(branchId));
    window.open(`/api/admin/reports/incidents.pdf?${params.toString()}`, '_blank', 'noopener');
    onClose();
  }

  return (
    <Modal
      open
      title="Xuất báo cáo sự cố"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Hủy
          </Button>
          <Button onClick={download} disabled={!ready} data-testid="incident-export-confirm">
            <Download className="h-4 w-4" aria-hidden="true" />
            Tải PDF
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <DateRangeField legend="Khoảng thời gian" value={range} onChange={setRange} testId="incident-report-range" />
        <p className="text-sm text-slate-600">
          {branchId == null
            ? 'Báo cáo gồm tất cả chi nhánh.'
            : 'Báo cáo chỉ gồm chi nhánh đang lọc. Bỏ lọc để xuất tất cả.'}
        </p>
        <p className="text-xs text-slate-500">
          Báo cáo gồm cả lịch sử xử lý từng lần, kể cả những lần không sửa được.
        </p>
      </div>
    </Modal>
  );
}

/* ------------------------------ The incident table ------------------------------ */

const muted = (v: ReactNode) => <span className="text-slate-400">{v}</span>;

/** The latest attempt's result, in the technical workflow's own words. */
function latestResult(issue: Issue): ReactNode {
  const attempts = issue.attempts ?? [];
  const last = attempts[attempts.length - 1];
  if (!last?.outcome) return muted(last ? 'Đang xử lý' : '—');
  return (
    <span className={last.outcome === 'CANNOT_REPAIR' ? 'text-rose-600' : 'text-emerald-700'}>
      {REPAIR_OUTCOME_LABEL[last.outcome]}
      {/* Breaks before the duration, never inside it. */}
      {last.durationLabel ? (
        <>
          {' '}
          <span className="whitespace-nowrap text-slate-500">· {last.durationLabel}</span>
        </>
      ) : null}
    </span>
  );
}

/**
 * ONE INCIDENT TABLE, for reception's board and the Admin's view alike.
 *
 * Every column is a field the technical workflow already maintains on
 * `HotelIssue` / `TechnicalRepairAttempt` — status through `IssueStatusBadge`,
 * result through `REPAIR_OUTCOME_LABEL`, times as the server stamped them. The
 * table stores nothing and decides nothing.
 */
export function IncidentTable({
  rows,
  title,
  testId,
  showBranch = false,
  readingMode = false,
  receptionView = false,
  compact,
  section,
  actions,
  emptyTitle,
  emptyMessage,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  rows: Issue[];
  title: string;
  testId: string;
  /** The Admin looks across branches; reception only ever sees its own. */
  showBranch?: boolean;
  /**
   * The Admin's reading screen: the expander at every width, several rows open
   * at once. Reception keeps the phone-only expander of its other tables.
   */
  readingMode?: boolean;
  /**
   * Reception's progress view: where the repair stands, nothing to operate. No
   * reporter (it is their own branch's report) and no last-update stamp; the
   * completion time and the status are what the desk is asked about.
   */
  receptionView?: boolean;
  compact?: boolean;
  section?: SectionFrame;
  actions?: (issue: Issue) => ReactNode;
  emptyTitle: string;
  emptyMessage: string;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  const issue: DataColumn<Issue> = {
    key: 'issue',
    header: 'Sự cố',
    className: 'min-w-[12rem] max-w-[22rem]',
    render: (i) => (
      <>
        <span className="line-clamp-2 whitespace-pre-wrap text-slate-800">{i.description}</span>
        {i.category ? <span className="block text-xs text-slate-500">{issueCategoryLabel(i)}</span> : null}
      </>
    ),
  };
  const location: DataColumn<Issue> = {
    key: 'location',
    header: 'Khu vực',
    className: 'min-w-[8rem] font-medium text-slate-800',
    render: (i) => i.locationLabel,
  };
  const status: DataColumn<Issue> = {
    key: 'status',
    header: 'Trạng thái',
    className: 'whitespace-nowrap',
    render: (i) => <IssueStatusBadge status={i.status} needsRework={i.needsRework} />,
  };
  const technician: DataColumn<Issue> = {
    key: 'technician',
    header: 'Kỹ thuật',
    secondary: true,
    className: 'whitespace-nowrap',
    render: (i) =>
      i.technicianName ? (
        <>
          {i.technicianName}
          {i.technicianPhone ? <span className="block text-xs text-slate-400">{i.technicianPhone}</span> : null}
        </>
      ) : (
        muted('Chưa tiếp nhận')
      ),
  };
  const attempts: DataColumn<Issue> = {
    key: 'attempts',
    header: 'Lần sửa',
    align: 'right',
    secondary: true,
    className: 'w-[1%] whitespace-nowrap',
    render: (i) => String(i.attempts?.length ?? 0),
  };

  /*
    Eight columns at desk width: the free-text column is a little narrower than
    the Admin's and the technician and "Lần sửa" headers may wrap, so "Trạng thái"
    — the answer the desk is asked for — stays on screen instead of scrolled off.
  */
  const columns: DataColumn<Issue>[] = receptionView
    ? [
        {
          key: 'stt',
          header: 'STT',
          className: 'w-[1%] whitespace-nowrap text-slate-400',
          render: (_i, index) => index + 1,
        },
        { ...issue, className: 'min-w-[10rem] max-w-[20rem]' },
        { ...location, className: 'min-w-[7rem] font-medium text-slate-800' },
        {
          key: 'createdAt',
          header: 'Thời gian báo cáo',
          className: 'min-w-[5.5rem] text-slate-500',
          render: (i) => formatDateTime(i.createdAt),
        },
        { ...technician, className: 'min-w-[6rem]' },
        {
          key: 'completedAt',
          header: 'Thời gian hoàn thành',
          secondary: true,
          className: 'min-w-[5.5rem] text-slate-500',
          render: (i) => formatDateTime(i.completedAt),
        },
        { ...attempts, className: 'w-[1%]' },
        status,
      ]
    : [
        issue,
        location,
        status,
        {
          key: 'reporter',
          header: 'Người báo',
          secondary: true,
          className: 'whitespace-nowrap',
          render: (i) => i.reportedByName ?? muted('—'),
        },
        ...(showBranch
          ? [
              {
                key: 'branch',
                header: 'Chi nhánh',
                secondary: true,
                className: 'min-w-[6rem] text-slate-500',
                render: (i: Issue) => i.branch?.address ?? muted('—'),
              },
            ]
          : []),
        {
          key: 'createdAt',
          header: 'Thời gian',
          className: 'min-w-[5.5rem] text-slate-500',
          render: (i) => formatDateTime(i.createdAt),
        },
        technician,
        { key: 'result', header: 'Kết quả gần nhất', secondary: true, className: 'min-w-[7rem]', render: latestResult },
        attempts,
        {
          key: 'updatedAt',
          header: 'Cập nhật',
          className: 'min-w-[5.5rem] text-slate-500',
          render: (i) => formatDateTime(i.updatedAt),
        },
      ];

  return (
    <DataTable
      testId={testId}
      title={title}
      badge={rows.length}
      columns={columns}
      rows={rows}
      rowKey={(i) => i.id}
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={onRetry}
      compact={compact}
      section={section}
      emptyTitle={emptyTitle}
      emptyMessage={emptyMessage}
      actions={actions}
      detailToggle={readingMode ? 'always' : 'mobile'}
      multiExpand={readingMode}
      renderDetail={(i) =>
        i.attempts && i.attempts.length > 0 ? (
          // IssueTimeline renders its own "Lịch sử xử lý" heading.
          <IssueTimeline attempts={i.attempts} />
        ) : (
          <p className="text-sm text-slate-400">Chưa có lần xử lý nào được ghi nhận.</p>
        )
      }
    />
  );
}
