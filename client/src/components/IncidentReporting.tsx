/**
 * INCIDENT REPORTING — the one issue form, and the incident views.
 *
 * "Sự cố cơ sở vật chất đang xử lý" in "Báo cáo vấn đề" is now the only place a hotel
 * incident is reported or monitored, for reception and for the Admin alike. The
 * standalone "Báo cáo sự cố" / "Sự cố khách sạn" screen these came from is gone;
 * its FORM, its range summary and its PDF export live here, unchanged, and still
 * create and read the same `HotelIssue` rows through the same `/api/issues` the
 * technical department works from. There is no second incident system.
 */
import { useRef, useState, type ReactNode } from 'react';
import { SourceTag } from './SourceTag';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ImageUp, X } from 'lucide-react';
import {
  AREA_FIELDS,
  ISSUE_AREAS,
  ISSUE_AREA_LABEL,
  ISSUE_CATEGORY_LABEL,
  ISSUE_AREA_SUBTYPES,
  ISSUE_CATEGORIES,
  issuesApi,
  requiresLocationDetail,
  type Issue,
  type IssueAreaCategory,
  type IssueAreaSubtype,
  type IssueCategory,
  issueCategoryLabel,
  inspectionIsRelevant,
  currentVerdict,
} from '../api/issues';
import { toUserMessage } from '../api/errors';
import { Button } from './Button';
import { Modal } from './Modal';
import { ErrorAlert } from './ErrorAlert';
import { DateRangeField, type DateRangeValue } from './DateRangeField';
import { DataTable, type DataColumn } from './DataTable';
import type { SectionFrame } from './ReportSection';
import {
  IssueEditHistory,
  IssueInspectionBadge,
  IssueLifecycleDetail,
  IssueStageBadge,
  IssueTimeline,
} from './IssueViews';
import { useAuth } from '../auth/AuthProvider';
import { useBranchRooms } from '../hooks/useBranchRooms';
import { reportsApi } from '../api/reports';
import { formatDateTime, hcmToday } from '../lib/format';

const ACCEPTED = 'image/png,image/jpeg,image/webp';
const MAX_BYTES = 10 * 1024 * 1024;

/** What the incident form holds — the same fields for reporting one and for correcting one. */
export interface IssueFormValue {
  areaCategory: IssueAreaCategory;
  category: IssueCategory;
  areaSubtype: IssueAreaSubtype | '';
  roomNumber: string;
  floorNumber: string;
  locationDetail: string;
  description: string;
}

const EMPTY_ISSUE_FORM: IssueFormValue = {
  areaCategory: 'ROOM',
  category: 'AIR_CONDITIONER',
  areaSubtype: '',
  roomNumber: '',
  floorNumber: '',
  locationDetail: '',
  description: '',
};

const inputClass =
  'w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

/**
 * The description is ALWAYS required, and trimmed before it counts — "   " is
 * not a description. The other requirements follow the area.
 */
function issueFormReady(v: IssueFormValue): boolean {
  const fields = AREA_FIELDS[v.areaCategory];
  return (
    v.description.trim().length > 0 &&
    (!fields.roomNumber || v.roomNumber.trim().length > 0) &&
    (!fields.floorNumber || v.floorNumber.trim().length > 0) &&
    (!fields.areaSubtype || v.areaSubtype !== '') &&
    (!requiresLocationDetail(v.areaCategory, v.areaSubtype) || v.locationDetail.trim().length > 0)
  );
}

/**
 * The report form's fields, WHICH CHANGE WITH THE AREA — shared by "Báo cáo sự cố
 * mới" and "Sửa vấn đề", so the two cannot disagree about what a hallway report
 * asks for.
 *
 * "Khu vực" is asked first, and it decides what else is asked: a room number for a
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
function IssueFormFields({
  value,
  onChange,
  rooms,
  floors,
}: {
  value: IssueFormValue;
  onChange: (patch: Partial<IssueFormValue>) => void;
  /**
   * The branch's room catalog. When there is one the room is CHOSEN from it —
   * never typed — so "302" is one room to every report and every repeat check;
   * null (no catalog, or still loading) keeps the typed field.
   */
  rooms?: string[] | null;
  /** The branch's floors (Hành lang, Cầu thang) — chosen, never typed, like the rooms. */
  floors?: string[] | null;
}) {
  const fields = AREA_FIELDS[value.areaCategory];
  const detailRequired = requiresLocationDetail(value.areaCategory, value.areaSubtype);
  return (
    <>
      <label className="block text-sm font-medium text-slate-700">
        Khu vực
        <select
          className={`${inputClass} mt-1`}
          value={value.areaCategory}
          aria-label="Khu vực"
          onChange={(e) =>
            onChange({
              areaCategory: e.target.value as IssueAreaCategory,
              // Clear what the new area does not ask for, so a value typed under
              // a previous choice cannot be submitted invisibly.
              areaSubtype: '',
              roomNumber: '',
              floorNumber: '',
              locationDetail: '',
            })
          }
        >
          {ISSUE_AREAS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </label>

      {fields.roomNumber ? (
        rooms && rooms.length > 0 ? (
          <label className="block text-sm font-medium text-slate-700">
            Số phòng
            <select
              className={`${inputClass} mt-1`}
              value={value.roomNumber}
              aria-label="Số phòng"
              data-testid="issue-room-select"
              onChange={(e) => onChange({ roomNumber: e.target.value })}
            >
              <option value="">— Chọn phòng —</option>
              {/* A legacy room typed before the catalog stays selectable on its own report. */}
              {value.roomNumber && !rooms.includes(value.roomNumber) ? (
                <option value={value.roomNumber}>{value.roomNumber} (cũ)</option>
              ) : null}
              {rooms.map((room) => (
                <option key={room} value={room}>
                  {room}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="block text-sm font-medium text-slate-700">
            Số phòng
            <input
              className={`${inputClass} mt-1`}
              value={value.roomNumber}
              onChange={(e) => onChange({ roomNumber: e.target.value })}
              placeholder="Ví dụ: 301"
              maxLength={50}
            />
          </label>
        )
      ) : null}

      {fields.floorNumber && floors ? (
        <label className="block text-sm font-medium text-slate-700">
          Tầng
          <select
            className={`${inputClass} mt-1`}
            value={value.floorNumber}
            aria-label="Tầng"
            data-testid="issue-floor"
            onChange={(e) => onChange({ floorNumber: e.target.value })}
          >
            <option value="">— Chọn tầng —</option>
            {/* A legacy floor typed before the catalog stays selectable on its own report. */}
            {value.floorNumber && !floors.includes(value.floorNumber) ? (
              <option value={value.floorNumber}>Tầng {value.floorNumber} (cũ)</option>
            ) : null}
            {floors.map((floor) => (
              <option key={floor} value={floor}>
                Tầng {floor}
              </option>
            ))}
          </select>
        </label>
      ) : fields.floorNumber ? (
        <label className="block text-sm font-medium text-slate-700">
          Số tầng
          <input
            className={`${inputClass} mt-1`}
            value={value.floorNumber}
            onChange={(e) => onChange({ floorNumber: e.target.value })}
            placeholder="Ví dụ: 3"
            maxLength={50}
          />
        </label>
      ) : null}

      {fields.areaSubtype ? (
        <label className="block text-sm font-medium text-slate-700">
          Loại sự cố
          <select
            className={`${inputClass} mt-1`}
            value={value.areaSubtype}
            aria-label="Loại sự cố"
            onChange={(e) => onChange({ areaSubtype: e.target.value as IssueAreaSubtype | '' })}
          >
            <option value="">— Chọn —</option>
            {ISSUE_AREA_SUBTYPES.map((st) => (
              <option key={st.value} value={st.value}>
                {st.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {fields.category ? (
        <label className="block text-sm font-medium text-slate-700">
          Loại sự cố
          <select
            className={`${inputClass} mt-1`}
            value={value.category}
            aria-label="Loại sự cố"
            onChange={(e) => onChange({ category: e.target.value as IssueCategory })}
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
      <label className="block text-sm font-medium text-slate-700">
        Vị trí cụ thể{' '}
        {detailRequired ? null : <span className="font-normal text-slate-500">(không bắt buộc)</span>}
        <input
          className={`${inputClass} mt-1`}
          value={value.locationDetail}
          onChange={(e) => onChange({ locationDetail: e.target.value })}
          placeholder="Ví dụ: hồ bơi tầng thượng, kho tầng hầm…"
          maxLength={500}
        />
      </label>

      <label className="block text-sm font-medium text-slate-700">
        Sự cố
        <textarea
          className={`${inputClass} mt-1`}
          rows={3}
          value={value.description}
          onChange={(e) => onChange({ description: e.target.value })}
          maxLength={2000}
          placeholder="Ví dụ: Máy lạnh không lạnh"
          aria-label="Sự cố"
        />
      </label>
    </>
  );
}

/**
 * WHICH BRANCH THIS RECORD IS FOR — shown at the top of every supervisor-entered
 * form, so nobody types a report for Chi nhánh 5 believing it is Chi nhánh 2.
 */
export function TargetBranchBanner({ label }: { label: string }) {
  return (
    <p
      data-testid="target-branch"
      className="flex items-center gap-2 rounded-xl border-rule border-brand-600 bg-brand-50 px-3 py-2 text-sm text-brand-800"
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-brand-700">Chi nhánh</span>
      <span className="font-semibold">{label}</span>
    </p>
  );
}

/**
 * "CÓ THỂ BỊ TRÙNG" — asked when "Gửi báo cáo" is pressed, if the server has an
 * open incident (or one finished recently) with the SAME structured key: branch,
 * area, room / floor / fixture and fault type — never the free text. Every
 * match is shown in full so the receptionist can tell whether it is the same
 * fault. A warning, never a block: "Vẫn gửi báo cáo" always sends.
 */
function DuplicateConfirm({ open, recent }: { open: Issue[]; recent: Issue[] }) {
  const row = (i: Issue) => {
    const last = i.attempts[i.attempts.length - 1];
    return (
      <li key={i.id} className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-slate-700">
        <p className="font-semibold text-slate-900">
          {i.areaCategory ? ISSUE_AREA_LABEL[i.areaCategory] : '—'} · {i.locationLabel}
          {i.category ? ` · ${ISSUE_CATEGORY_LABEL[i.category]}` : ''}
        </p>
        {i.locationDetail ? <p>Chi tiết: {i.locationDetail}</p> : null}
        <p className="whitespace-pre-wrap break-words">Mô tả: {i.description}</p>
        <p>Nguyên nhân: {i.cause ?? 'Chưa xác định'}</p>
        <p>
          Người báo: {i.reporterName ?? '—'} · {formatDateTime(i.createdAt)}
          {i.shiftType ? ` · Ca ${i.shiftType}` : ''}
        </p>
        <p>
          Trạng thái: {i.assignmentStateLabel ?? i.stageLabel}
          {' · Kỹ thuật: '}
          {i.assignedTechnician?.name ?? i.repairerName ?? 'Chưa giao'}
        </p>
        {last?.result ? <p>Kết quả lần trước: {last.result}</p> : null}
      </li>
    );
  };
  return (
    <div
      role="alert"
      data-testid="similar-issues"
      className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-sm text-amber-900"
    >
      <p className="font-semibold">Vấn đề này có thể bị trùng với một vấn đề đã được báo cáo.</p>
      {open.length > 0 ? (
        <>
          <p className="text-xs font-medium">Đang xử lý:</p>
          <ul className="space-y-1.5">{open.map(row)}</ul>
        </>
      ) : null}
      {recent.length > 0 ? (
        <>
          <p className="text-xs font-medium">Đã xử lý gần đây:</p>
          <ul className="space-y-1.5">{recent.map(row)}</ul>
        </>
      ) : null}
      <p className="font-semibold">Bạn chắc chắn muốn gửi báo cáo này chứ?</p>
    </div>
  );
}

export function NewIssueModal({
  onClose,
  onCreated,
  branchId,
  branchLabel,
}: {
  onClose: () => void;
  onCreated: (issue: Issue) => void;
  /**
   * A SUPERVISOR's target branch (Admin, Quản lý lễ tân, Tổng quản lý lễ tân).
   * Omitted for Reception, whose branch is its own — the server decides it.
   */
  branchId?: number;
  /** Shown at the top so the target branch stays unmistakable while typing. */
  branchLabel?: string;
}) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  // The rooms of the branch this report is FOR: the supervisor's chosen branch,
  // or the receptionist's own.
  const roomBranchId = branchId ?? user?.branch?.id ?? null;
  const { rooms, floors } = useBranchRooms(roomBranchId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<IssueFormValue>(EMPTY_ISSUE_FORM);
  // Optional: Reception often does not know why yet. The technician can fill
  // it in during the repair, and what is typed here is never overwritten.
  const [cause, setCause] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const fields = AREA_FIELDS[form.areaCategory];

  /*
    "CÓ THỂ BỊ TRÙNG" — checked when "Gửi báo cáo" is pressed, by the structured
    key the server compares. A match shows the warning; nothing found sends at
    once. A failed check never stops a report — it is only a warning.
  */
  const [duplicates, setDuplicates] = useState<{ open: Issue[]; recent: Issue[] } | null>(null);
  const check = useMutation({
    mutationFn: () =>
      issuesApi.similar({
        branchId,
        areaCategory: form.areaCategory,
        roomNumber: fields.roomNumber ? form.roomNumber.trim() : undefined,
        floorNumber: fields.floorNumber ? form.floorNumber.trim() : undefined,
        areaSubtype: fields.areaSubtype && form.areaSubtype ? form.areaSubtype : undefined,
        category: fields.category ? form.category : undefined,
      }),
    onSuccess: (found) => {
      if (found.open.length + found.recent.length > 0) setDuplicates(found);
      else create.mutate();
    },
    onError: () => create.mutate(),
  });

  const create = useMutation({
    mutationFn: () =>
      issuesApi.create({
        branchId,
        areaCategory: form.areaCategory,
        description: form.description,
        cause: cause.trim() || undefined,
        category: fields.category ? form.category : undefined,
        roomNumber: fields.roomNumber ? form.roomNumber : undefined,
        floorNumber: fields.floorNumber ? form.floorNumber : undefined,
        areaSubtype: fields.areaSubtype && form.areaSubtype ? form.areaSubtype : undefined,
        locationDetail: form.locationDetail || undefined,
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

  const ready = issueFormReady(form);

  return (
    <Modal
      open
      title="Báo cáo sự cố mới"
      onClose={onClose}
      footer={
        <>
          {duplicates ? (
            <>
              <Button variant="secondary" onClick={() => setDuplicates(null)} data-testid="duplicate-back">
                Hủy / quay lại
              </Button>
              <Button onClick={() => create.mutate()} loading={create.isPending} data-testid="duplicate-send">
                Vẫn gửi báo cáo
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>
                Hủy
              </Button>
              <Button
                onClick={() => check.mutate()}
                loading={check.isPending || create.isPending}
                disabled={!ready}
                data-testid="issue-submit"
              >
                Gửi báo cáo
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {branchLabel ? <TargetBranchBanner label={branchLabel} /> : null}
        {duplicates ? <DuplicateConfirm open={duplicates.open} recent={duplicates.recent} /> : null}
        <IssueFormFields
          value={form}
          onChange={(patch) => {
            setDuplicates(null);
            setForm((f) => ({ ...f, ...patch }));
          }}
          rooms={rooms}
          floors={floors}
        />

        <label className="block text-sm font-medium text-slate-700">
          Nguyên nhân <span className="font-normal text-slate-500">(không bắt buộc)</span>
          <input
            className={`${inputClass} mt-1`}
            value={cause}
            onChange={(e) => setCause(e.target.value)}
            maxLength={1000}
            placeholder="Ví dụ: Thiếu gas — để trống nếu chưa rõ"
            aria-label="Nguyên nhân"
          />
        </label>

        <div>
          <span className="mb-1 block text-sm font-medium text-slate-700">Ảnh (không bắt buộc)</span>
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
                className="h-24 w-24 rounded-xl border border-line object-cover"
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
 * "SỬA VẤN ĐỀ" — correct what an open incident says.
 *
 * THE SAME FIELDS AS THE REPORT FORM (`IssueFormFields`), filled with what is
 * stored, and nothing else: there is no status here, no technician and no time.
 * The report time, the status and the whole repair history are untouched by the
 * server, and the words that are replaced are kept in the incident's edit
 * history — the dialog says so, so nobody hesitates to fix a wrong room number.
 *
 * A LEGACY report (filed before the structured form) was never asked where it
 * was, and is not asked now: only its description can be corrected.
 */
export function EditIssueModal({
  issue,
  onClose,
  onSaved,
}: {
  issue: Issue;
  onClose: () => void;
  onSaved: (issue: Issue) => void;
}) {
  const queryClient = useQueryClient();
  const legacy = issue.areaCategory === null;
  const initial: IssueFormValue = {
    areaCategory: issue.areaCategory ?? 'ROOM',
    category: issue.category ?? 'OTHER',
    areaSubtype: issue.areaSubtype ?? '',
    roomNumber: issue.roomNumber ?? '',
    floorNumber: issue.floorNumber ?? '',
    locationDetail: issue.locationDetail ?? '',
    description: issue.description,
  };
  const [form, setForm] = useState<IssueFormValue>(initial);
  const fields = AREA_FIELDS[form.areaCategory];
  // The incident's OWN branch's rooms — a correction can never move it elsewhere.
  const { rooms, floors } = useBranchRooms(issue.branchId);

  const save = useMutation({
    mutationFn: () =>
      issuesApi.update(
        issue.id,
        legacy
          ? { description: form.description.trim() }
          : {
              areaCategory: form.areaCategory,
              description: form.description.trim(),
              category: fields.category ? form.category : null,
              roomNumber: fields.roomNumber ? form.roomNumber.trim() : null,
              floorNumber: fields.floorNumber ? form.floorNumber.trim() : null,
              areaSubtype: fields.areaSubtype && form.areaSubtype ? form.areaSubtype : null,
              locationDetail: form.locationDetail.trim() || null,
            },
      ),
    onSuccess: ({ issue: updated }) => {
      void queryClient.invalidateQueries({ queryKey: ['issues'] });
      onSaved(updated);
    },
  });

  const ready = legacy ? form.description.trim().length > 0 : issueFormReady(form);
  const changed = JSON.stringify(form) !== JSON.stringify(initial);

  return (
    <Modal
      open
      title="Sửa vấn đề"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-testid="edit-issue-cancel">
            Hủy
          </Button>
          <Button
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!ready || !changed}
            data-testid="edit-issue-save"
          >
            Lưu
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Thời gian báo cáo, trạng thái và lịch sử sửa chữa được giữ nguyên. Nội dung cũ được lưu trong lịch sử
          chỉnh sửa của sự cố.
        </p>
        {legacy ? (
          <label className="block text-sm font-medium text-slate-700">
            Mô tả sự cố
            <textarea
              className={`${inputClass} mt-1`}
              rows={3}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              maxLength={2000}
            />
          </label>
        ) : (
          <IssueFormFields
            value={form}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            rooms={rooms}
            floors={floors}
          />
        )}
        {save.isError ? <ErrorAlert>{toUserMessage(save.error)}</ErrorAlert> : null}
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
 * "Lượt không sửa được" and "Cần sửa lại" sit side by side on purpose. They are
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

  // The two inspection figures only while inspection is part of the workflow.
  const inspection = s.inspectionEnabled;
  const cells: { label: string; value: number; tone?: string }[] = [
    { label: 'Tổng sự cố phát sinh', value: s.total },
    { label: 'Sự cố khách sạn', value: s.newCount },
    { label: 'Đang sửa', value: s.inProgressCount },
    ...(inspection ? [{ label: 'Chờ nghiệm thu', value: s.awaitingInspectionCount, tone: 'text-violet-700' }] : []),
    { label: 'Đã hoàn thành', value: s.completedCount },
    { label: 'Lượt không sửa được', value: s.cannotRepairAttempts, tone: 'text-rose-700' },
    ...(inspection ? [{ label: 'Nghiệm thu không đạt', value: s.failedInspections, tone: 'text-rose-700' }] : []),
    { label: 'Cần sửa lại', value: s.needsReworkIssues, tone: 'text-rose-700' },
  ];

  return (
    <div className="mb-4" data-testid="incident-range-summary">
      <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${inspection ? 'lg:grid-cols-4 xl:grid-cols-8' : 'lg:grid-cols-6'}`}>
        {cells.map((c) => (
          <div key={c.label} className="rounded-xl border border-line bg-white p-3 shadow-sm">
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

  /*
    Whether the file carries inspection results is the SERVER's to say — the
    same flag the PDF is built with. The query is the one the period summary on
    screen already made, so for the period on screen it is answered from cache.
  */
  const summary = useQuery({
    queryKey: ['incident-range-summary', { from: range.from, to: range.to, branchId }],
    queryFn: () => reportsApi.incidentSummary({ from: range.from, to: range.to, branchId: branchId ?? undefined }),
    enabled: ready,
  });
  const inspection = summary.data?.summary.inspectionEnabled === true;

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
        <p className="text-xs text-slate-500" data-testid="incident-export-contents">
          Báo cáo gồm cả lịch sử xử lý từng lần — kể cả những lần không sửa được
          {inspection ? ' — và kết quả nghiệm thu' : ''}.
        </p>
      </div>
    </Modal>
  );
}

/* ------------------------------ The incident table ------------------------------ */

const muted = (v: ReactNode) => <span className="text-slate-500">{v}</span>;

/**
 * The stage, and — once there is something to state — the inspection beneath
 * it. Two badges, because "the technician finished" and "the repair passed" are
 * different events and Reception has to be able to tell them apart.
 */
function statusCell(i: Issue): ReactNode {
  return (
    <div className="flex flex-col items-start gap-1">
      <IssueStageBadge issue={i} />
      {inspectionIsRelevant(i) ? <IssueInspectionBadge issue={i} /> : null}
    </div>
  );
}

/** The latest verdict's who and when, under its badge — never in a tooltip. */
function inspectionCell(i: Issue): ReactNode {
  const judged = currentVerdict(i);
  return (
    <div className="flex flex-col items-start gap-0.5">
      <IssueInspectionBadge issue={i} />
      {judged ? (
        <span className="text-xs text-slate-600">
          {judged.inspectedByName ?? '—'}
          {judged.inspectedAt ? (
            <span className="block whitespace-nowrap text-slate-500">{formatDateTime(judged.inspectedAt)}</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * ONE INCIDENT TABLE, for reception's board and the Admin's view alike.
 *
 * Every column is a field the technical workflow already maintains on
 * `HotelIssue` / `TechnicalRepairAttempt` — the stage and the inspection through
 * the shared badges, both labelled by the server; times as the server stamped
 * them. The table stores nothing and decides nothing.
 */
export function IncidentTable({
  rows,
  title,
  testId,
  showBranch = false,
  readingMode = false,
  receptionView = false,
  summary = false,
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
  /**
   * Reception's OVERVIEW (and its archive): the five facts a glance needs —
   * STT, Khu vực, Sự cố, Nguyên nhân, Trạng thái. Who repaired it, when, and
   * how many times stay on the category's own screen and in the Admin's.
   */
  summary?: boolean;
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
    // "Admin tạo" beside the place: on every incident view, summary included.
    render: (i) => (
      <>
        {i.locationLabel}
        <SourceTag label={i.sourceLabel} />
      </>
    ),
  };
  /** THE cause — the latest technician's, else what Reception reported. */
  const cause: DataColumn<Issue> = {
    key: 'cause',
    header: 'Nguyên nhân',
    secondary: true,
    className: 'min-w-[8rem] max-w-[14rem]',
    render: (i) =>
      i.cause ? <span className="line-clamp-2 text-slate-700">{i.cause}</span> : muted('Chưa xác định'),
  };
  const status: DataColumn<Issue> = {
    key: 'status',
    header: 'Trạng thái',
    className: 'whitespace-nowrap',
    render: statusCell,
  };
  /** "Người sửa" from the attempts themselves, never from the reporter. */
  const repairer: DataColumn<Issue> = {
    key: 'repairer',
    header: 'Người sửa',
    secondary: true,
    className: 'min-w-[6rem]',
    render: (i) => {
      const last = i.attempts?.[i.attempts.length - 1];
      const phone = last?.technicianPhone ?? i.technicianPhone;
      return i.repairerName ? (
        <>
          {i.repairerName}
          {phone ? <span className="block text-xs text-slate-500">{phone}</span> : null}
        </>
      ) : (
        muted('Chưa tiếp nhận')
      );
    },
  };
  const completedAt: DataColumn<Issue> = {
    key: 'completedAt',
    header: 'Thời gian hoàn thành',
    secondary: true,
    className: 'min-w-[5.5rem] text-slate-600',
    render: (i) => (i.completedAt ? formatDateTime(i.completedAt) : muted('—')),
  };
  const reportedAt: DataColumn<Issue> = {
    key: 'createdAt',
    header: 'Thời gian báo cáo',
    className: 'min-w-[5.5rem] text-slate-600',
    render: (i) => formatDateTime(i.createdAt),
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
    Reception's order is the specification's: where, what, why, when it was
    reported, who repaired it, when it was finished, where it stands (with the
    inspection beneath). Nothing to operate here beyond "Sửa vấn đề" — Reception
    monitors; Bộ phận kỹ thuật works the incident. No "Lần sửa": how many times
    a technician went is the technical department's working detail, one click
    down in the expanded row's "Lịch sử xử lý".
  */
  // Admin shows "Nghiệm thu" as a column only while inspection is active.
  const inspectionOn = rows.some((r) => r.inspectionEnabled);
  // On a phone STT and "Nguyên nhân" fold into the row's expander, so the status stays in view.
  const summaryColumns: DataColumn<Issue>[] = [
    {
      key: 'stt',
      header: 'STT',
      secondary: true,
      className: 'w-[1%] whitespace-nowrap text-slate-500',
      render: (_i, index) => index + 1,
    },
    { ...location, className: 'min-w-[5rem] sm:min-w-[7rem] font-medium text-slate-800' },
    {
      ...issue,
      className: 'min-w-[6rem] sm:min-w-[9rem] max-w-[20rem]',
      // The fault in full — it is what the glance is for, so it wraps rather than clamps.
      render: (i) => (
        <>
          <span className="whitespace-pre-wrap text-slate-800 [overflow-wrap:anywhere]">{i.description}</span>
          {i.category ? <span className="block text-xs text-slate-500">{issueCategoryLabel(i)}</span> : null}
        </>
      ),
    },
    cause,
    { ...status, render: (i) => <IssueStageBadge issue={i} /> },
  ];

  const columns: DataColumn<Issue>[] = summary
    ? summaryColumns
    : receptionView
    ? [
        {
          key: 'stt',
          header: 'STT',
          className: 'w-[1%] whitespace-nowrap text-slate-500',
          render: (_i, index) => index + 1,
        },
        { ...location, className: 'min-w-[7rem] font-medium text-slate-800' },
        { ...issue, className: 'min-w-[9rem] max-w-[18rem]' },
        cause,
        reportedAt,
        repairer,
        completedAt,
        status,
      ]
    : [
        issue,
        location,
        cause,
        // The Admin has "Nghiệm thu" as a column of its own, so the stage cell
        // carries the stage alone rather than saying the inspection twice.
        { ...status, render: (i) => <IssueStageBadge issue={i} /> },
        ...(inspectionOn
          ? [
              {
                key: 'inspection',
                header: 'Nghiệm thu',
                className: 'min-w-[8.5rem]',
                render: inspectionCell,
              },
            ]
          : []),
        {
          key: 'reporter',
          header: 'Người báo',
          secondary: true,
          className: 'whitespace-nowrap',
          render: (i) => (
            <>
              {i.reporterName ?? muted('—')}
            </>
          ),
        },
        ...(showBranch
          ? [
              {
                key: 'branch',
                header: 'Chi nhánh',
                secondary: true,
                className: 'min-w-[6rem] text-slate-600',
                render: (i: Issue) => i.branch?.address ?? muted('—'),
              },
            ]
          : []),
        reportedAt,
        repairer,
        { ...completedAt, header: 'Hoàn thành' },
        attempts,
        {
          key: 'updatedAt',
          header: 'Cập nhật',
          className: 'min-w-[5.5rem] text-slate-600',
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
      actions={summary ? undefined : actions}
      // Reception's table dropped "Lần sửa", so the repair history is reached by
      // opening the row — at every width, not only on a phone.
      detailToggle={!summary && (readingMode || receptionView) ? 'always' : 'mobile'}
      multiExpand={readingMode}
      // The summary is a glance: no lifecycle to open — the detail lives on the
      // category's screen. (A phone still folds "Nguyên nhân" into its expander.)
      renderDetail={
        summary
          ? undefined
          : (i) =>
              readingMode ? (
                // The Admin's record: report, repair and inspection, then every attempt.
                <div className="space-y-3">
                  <IssueLifecycleDetail issue={i} showBranch={showBranch} />
                  <IssueEditHistory edits={i.edits ?? []} />
                </div>
              ) : (
                <div className="space-y-3">
                  {i.attempts && i.attempts.length > 0 ? (
                    // IssueTimeline renders its own "Lịch sử xử lý" heading.
                    <IssueTimeline attempts={i.attempts} stage={i.stage} showInspection={i.inspectionEnabled} />
                  ) : (
                    <p className="text-sm text-slate-500">Chưa có lần xử lý nào được ghi nhận.</p>
                  )}
                  <IssueEditHistory edits={i.edits ?? []} />
                </div>
              )
      }
    />
  );
}
