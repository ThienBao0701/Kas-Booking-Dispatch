/**
 * The three non-payment, non-monitoring category forms of "Báo cáo vấn đề".
 *
 * ONE SHAPE FOR ALL OF THEM: the fields the category was specified with, a
 * "Thêm" button, and the record appears in the table below immediately. No
 * wizard, no second screen, no confirmation step — a receptionist filling this
 * in has a guest standing in front of them.
 *
 * NO FORM ASKS WHO IS FILLING IT IN, which branch it is, or what time it is.
 * Those come from the open shift, on the server. An employee field would be the
 * one thing that made every record here deniable.
 *
 * "Sự cố cơ sở vật chất đang xử lý" has NO form here — it is a monitoring board, not
 * an entry category. See `FacilityIssueBoard.tsx`.
 */
import { useEffect, useRef, useState } from 'react';
import { SeverityPicker } from './Severity';
import { DEFAULT_SEVERITY } from '../lib/severity';
import type { Severity } from '../api/receptionReports';
import { useReportSubmitOverride } from '../lib/reportSubmit';
import { useAuth } from '../auth/AuthProvider';
import { maySelfClaim } from '../lib/requestWork';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useDebounced } from '../hooks/useDebounced';
import {
  WORK_DEPARTMENT_OPTIONS,
  reportsApi,
  type WorkDepartment,
  type DeliveryDepartment,
  type NewReportInput,
  type NewRoomServiceInput,
  type ReportOptions,
  type RoomServiceType,
} from '../api/receptionReports';
import { ApiError, toUserMessage } from '../api/errors';
import { Button } from './Button';
import { Input } from './Input';
import { ErrorAlert } from './ErrorAlert';
import { MoneyInput } from './MoneyInput';
import { parseVnd } from '../lib/money';
import { parseQuantity } from '../lib/quantity';
import {
  ROOM_SERVICE_FALLBACK_LABELS,
  ROOM_SERVICE_ORDER,
  ROOM_SERVICE_PRICE_LABEL,
  roomServiceFields,
} from '../lib/roomServiceFields';

/** The selector's words before the server has spoken; the server refuses anything else. */
const DELIVERY_DEPARTMENT_FALLBACK: { code: DeliveryDepartment; label: string }[] = [
  { code: 'RECEPTION', label: 'Lễ tân' },
  { code: 'HOUSEKEEPING', label: 'Buồng phòng' },
  { code: 'TECHNICAL', label: 'Kỹ thuật' },
];

interface FormShellProps {
  title: string;
  testId: string;
  ready: boolean;
  pending: boolean;
  error: string | null;
  onSubmit: () => void;
  children: React.ReactNode;
  /**
   * `bare` drops the card and the heading because a dialog already supplies
   * both. Same form, same fields, same testids — only the chrome differs, so a
   * form cannot behave one way on the page and another in a modal.
   */
  bare?: boolean;
  /** In a dialog, "Hủy" sits beside "Thêm" and closes it. */
  onCancel?: () => void;
  /** The server warned of a possible duplicate: "Vẫn gửi" sends it as a separate issue. */
  onConfirmDuplicate?: () => void;
  /** Nobody of the chosen department is on shift: "Vẫn lưu, chờ giao" saves it unassigned. */
  onConfirmUnassigned?: () => void;
}

function FormShell({ title, testId, ready, pending, error, onSubmit, children, bare, onCancel, onConfirmDuplicate, onConfirmUnassigned }: FormShellProps) {
  return (
    <form
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit();
      }}
      className={bare ? 'space-y-3' : 'space-y-3 rounded-2xl border border-line bg-white px-4 py-4'}
    >
      {bare ? null : <p className="text-sm font-semibold text-slate-800">{title}</p>}
      {children}
      {error && onConfirmUnassigned ? (
        <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950" role="alert" data-testid={`${testId}-no-staff`}>
          <p>{error}</p>
          <p className="text-xs">Chọn bộ phận khác, hoặc lưu để quản lý giao người xử lý sau.</p>
          <Button type="button" variant="secondary" onClick={onConfirmUnassigned} loading={pending} data-testid={`${testId}-save-unassigned`}>
            Vẫn lưu, chờ giao
          </Button>
        </div>
      ) : error && onConfirmDuplicate ? (
        <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-950" role="alert" data-testid={`${testId}-duplicate`}>
          <p>{error}</p>
          <Button type="button" variant="secondary" onClick={onConfirmDuplicate} loading={pending} data-testid={`${testId}-confirm-duplicate`}>
            Vẫn gửi
          </Button>
        </div>
      ) : error ? (
        <ErrorAlert>{error}</ErrorAlert>
      ) : null}
      <div className={`flex justify-end gap-2 ${bare ? 'border-t border-line-subtle pt-3' : ''}`}>
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel} data-testid={`${testId}-cancel`}>
            Hủy
          </Button>
        ) : null}
        <Button type="submit" disabled={!ready} loading={pending} data-testid={`${testId}-add`}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Thêm
        </Button>
      </div>
    </form>
  );
}

/**
 * Shared mutation wiring — every form creates through the same endpoint.
 * `branchId` is a SUPERVISOR's target branch; omitted for Reception, whose
 * branch is its open shift's (the server ignores it for a receptionist).
 */
function useCreateReport(onCreated: () => void | Promise<void>, branchId?: number) {
  const [error, setError] = useState<string | null>(null);
  // The input the server warned may duplicate an existing report — "Vẫn gửi" sends it again, confirmed.
  const [duplicateOf, setDuplicateOf] = useState<NewReportInput | null>(null);
  // The request nobody of its department could receive — "Vẫn lưu, chờ giao" saves it unassigned.
  const [unassignedOf, setUnassignedOf] = useState<NewReportInput | null>(null);
  // "Nhập bù" submits the same form to its own endpoint (see lib/reportSubmit).
  const override = useReportSubmitOverride();
  const mutation = useMutation({
    mutationFn: (input: NewReportInput & { confirmDuplicate?: boolean; allowUnassigned?: boolean }) =>
      override ? override(input) : reportsApi.create({ ...input, branchId }),
    onSuccess: async () => {
      setError(null);
      setDuplicateOf(null);
      setUnassignedOf(null);
      await onCreated();
    },
    onError: (e, input) => {
      setError(toUserMessage(e));
      setDuplicateOf(e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE' ? input : null);
      const noStaff = e instanceof ApiError && (e.details as { reason?: string } | undefined)?.reason === 'NO_STAFF_ON_SHIFT';
      setUnassignedOf(noStaff ? input : null);
    },
  });
  const confirmDuplicate = duplicateOf ? () => mutation.mutate({ ...duplicateOf, confirmDuplicate: true }) : undefined;
  const confirmUnassigned = unassignedOf ? () => mutation.mutate({ ...unassignedOf, allowUnassigned: true }) : undefined;
  return { mutation, error, setError, confirmDuplicate, confirmUnassigned };
}

/** A department, or "Tự nhận việc" — the writer takes the request itself. */
export type DepartmentChoice = WorkDepartment | 'SELF';
const SELF_OPTION = { code: 'SELF' as const, label: 'Tự nhận việc' };

/**
 * "BỘ PHẬN NHẬN VIỆC" — required, beside "Mức độ". Under it, who is "đang
 * trong ca" at the branch in each department (an open shift — not an online
 * status), so the desk sees before saving when a department has nobody.
 * `allowSelf`: offers "Tự nhận việc" (a department's own staff).
 */
export function DepartmentPicker({
  value,
  onChange,
  branchId,
  allowSelf = false,
  testId = 'guest-request-department',
}: {
  value: DepartmentChoice | '';
  onChange: (value: DepartmentChoice) => void;
  branchId?: number;
  allowSelf?: boolean;
  testId?: string;
}) {
  const staff = useQuery({
    queryKey: ['reception', 'dispatch-staff', branchId ?? null],
    queryFn: () => reportsApi.dispatchStaff(branchId),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const onShift = staff.data?.onShift;
  const nobody = value !== '' && value !== 'SELF' && onShift !== undefined && onShift[value].length === 0;
  const options: { code: DepartmentChoice; label: string }[] = [...WORK_DEPARTMENT_OPTIONS, ...(allowSelf ? [SELF_OPTION] : [])];
  return (
    <fieldset data-testid={testId}>
      <legend className="mb-1.5 block text-sm font-medium text-slate-700">
        Bộ phận nhận việc <span className="text-rose-600">*</span>
      </legend>
      <div role="radiogroup" aria-label="Bộ phận nhận việc" className="inline-flex flex-wrap overflow-hidden rounded-xl border border-line-strong">
        {options.map((o, i) => {
          const on = value === o.code;
          return (
            <button
              key={o.code}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.code)}
              data-testid={`${testId}-${o.code}`}
              className={`inline-flex min-h-[2.5rem] items-center px-3.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 ${
                i > 0 ? 'border-l border-line-strong' : ''
              } ${on ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {onShift ? (
        <p className="mt-1 text-xs text-slate-500" data-testid={testId === 'guest-request-department' ? 'guest-request-on-shift' : `${testId}-on-shift`}>
          Đang trong ca: {WORK_DEPARTMENT_OPTIONS.map((o) => `${o.label} ${onShift[o.code].length}`).join(' · ')}
        </p>
      ) : null}
      {value === 'SELF' ? <p className="mt-1 text-xs text-slate-600">Bạn là người xử lý yêu cầu này.</p> : null}
      {nobody ? (
        <p className="mt-1 text-xs font-medium text-amber-800" role="status" data-testid={testId === 'guest-request-department' ? 'guest-request-no-staff-hint' : `${testId}-no-staff-hint`}>
          Hiện không có nhân viên {WORK_DEPARTMENT_OPTIONS.find((o) => o.code === value)?.label} nào đang trong ca tại chi nhánh này.
        </p>
      ) : null}
    </fieldset>
  );
}

/** A multi-line field with the same look as `Input`. */
function TextArea({
  label,
  value,
  onChange,
  testId,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId: string;
  maxLength: number;
}) {
  return (
    <label className="block text-sm font-medium text-slate-700">
      {label}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        maxLength={maxLength}
        data-testid={testId}
        className="mt-1 w-full rounded-xl border border-line-strong bg-white px-3 py-2 text-sm hover:border-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
      />
    </label>
  );
}

/* ---------------- Vấn đề khách yêu cầu thực hiện (Request) ---------------- */

/**
 * TÊN KHÁCH, MÃ EZ, NỘI DUNG — and nothing else.
 *
 * "Ký gửi" and "Số phòng" are gone: what the guest asked for is written in
 * full in "Nội dung", and Mã EZ finds the booking. A new request is "Đã tiếp
 * nhận" from the moment it is saved; completing it is a separate step.
 */
export function GuestRequestForm({
  onCreated,
  bare,
  onCancel,
  branchId,
}: {
  onCreated: () => void | Promise<void>;
  bare?: boolean;
  onCancel?: () => void;
  /** A supervisor's target branch; omitted for Reception (its shift decides). */
  branchId?: number;
}) {
  // Bộ phận buồng phòng writes the content and "Mức độ" only — never the guest: Reception names the guest afterwards.
  const role = useAuth().user?.role;
  const housekeeping = role === 'HOUSEKEEPING' || role === 'HOUSEKEEPING_MANAGER';
  const [guestName, setGuestName] = useState('');
  const [ezCode, setEzCode] = useState('');
  const [content, setContent] = useState('');
  const [severity, setSeverity] = useState<Severity>(DEFAULT_SEVERITY);
  const [department, setDepartment] = useState<DepartmentChoice | ''>('');
  const allowSelf = maySelfClaim(useAuth().user);
  const { mutation, error, confirmDuplicate, confirmUnassigned } = useCreateReport(async () => {
    setGuestName('');
    setEzCode('');
    setContent('');
    setSeverity(DEFAULT_SEVERITY);
    setDepartment('');
    await onCreated();
  }, branchId);

  return (
    <FormShell
      title="Vấn đề khách yêu cầu thực hiện"
      testId="guest-request-form"
      bare={bare}
      onCancel={onCancel}
      ready={(housekeeping || guestName.trim().length > 0) && content.trim().length > 0 && department !== ''}
      pending={mutation.isPending}
      error={error}
      onConfirmDuplicate={confirmDuplicate}
      onConfirmUnassigned={confirmUnassigned}
      onSubmit={() =>
        mutation.mutate({
          category: 'GUEST_REQUEST',
          guestRequest: housekeeping
            ? { note: content.trim(), severity, receivingDepartment: department || undefined }
            : { guestName: guestName.trim(), ezCode: ezCode.trim() || undefined, note: content.trim(), severity, receivingDepartment: department || undefined },
        })
      }
    >
      {housekeeping ? null : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Tên khách"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            data-testid="guest-request-guest"
          />
          <Input label="Mã EZ" value={ezCode} onChange={(e) => setEzCode(e.target.value)} data-testid="guest-request-ez" />
        </div>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <SeverityPicker value={severity} onChange={setSeverity} testId="guest-request-severity" />
        <DepartmentPicker value={department} onChange={setDepartment} branchId={branchId} allowSelf={allowSelf} />
      </div>
      <div>
        <TextArea
          label="Nội dung"
          value={content}
          onChange={setContent}
          maxLength={2000}
          testId="guest-request-content"
        />
        <p className="mt-1 text-xs text-slate-500" data-testid="guest-request-content-hint">
          Chỉ báo cáo những vấn đề cần theo dõi hoặc có thời gian thực hiện kéo dài. Những vấn đề có thể xử lý ngay thì không cần tạo báo cáo.
        </p>
      </div>
    </FormShell>
  );
}

/* ------------------- Vấn đề về chất lượng và dịch vụ ------------------- */

/**
 * TÊN KHÁCH, MÃ EZ, MỨC ĐỘ, MÔ TẢ. No room, no staff field (the shift says who). A new report is "Đã tiếp nhận"; completing it — with an optional
 * "Hướng xử lý" — is a separate step on the table.
 */
export function ServiceQualityForm({
  onCreated,
  bare,
  onCancel,
  branchId,
}: {
  onCreated: () => void | Promise<void>;
  bare?: boolean;
  onCancel?: () => void;
  /** A supervisor's target branch; omitted for Reception (its shift decides). */
  branchId?: number;
}) {
  const [guestName, setGuestName] = useState('');
  const [ezCode, setEzCode] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<Severity>(DEFAULT_SEVERITY);
  const { mutation, error, confirmDuplicate } = useCreateReport(async () => {
    setGuestName('');
    setEzCode('');
    setDescription('');
    setSeverity(DEFAULT_SEVERITY);
    await onCreated();
  }, branchId);

  return (
    <FormShell
      title="Vấn đề về chất lượng và dịch vụ"
      testId="service-quality-form"
      bare={bare}
      onCancel={onCancel}
      ready={guestName.trim().length > 0 && description.trim().length > 0}
      pending={mutation.isPending}
      error={error}
      onConfirmDuplicate={confirmDuplicate}
      onSubmit={() =>
        mutation.mutate({
          category: 'CUSTOMER_COMPLAINT',
          complaint: {
            guestName: guestName.trim(),
            ezCode: ezCode.trim() || undefined,
            description: description.trim(),
            severity,
          },
        })
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Tên khách"
          value={guestName}
          onChange={(e) => setGuestName(e.target.value)}
          data-testid="service-quality-guest"
        />
        <Input label="Mã EZ" value={ezCode} onChange={(e) => setEzCode(e.target.value)} data-testid="service-quality-ez" />
      </div>
      <SeverityPicker value={severity} onChange={setSeverity} testId="service-quality-severity" />
      <TextArea
        label="Mô tả"
        value={description}
        onChange={setDescription}
        maxLength={4000}
        testId="service-quality-description"
      />
    </FormShell>
  );
}

/* ------------------------- Dịch vụ phòng, KPI ------------------------- */

/** "Số đêm" as typed — a positive whole number, or null. Never a silent zero. */
/** A review count as typed: blank is 0, anything else must be whole digits. */
function parseCount(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return 0;
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function parseNights(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 ? n : null;
}

/** One chosen service's own fields, as typed. */
interface ServiceDraft {
  roomClass: string;
  fromRoomClass: string;
  toRoomClass: string;
  nights: string;
  price: string;
  note: string;
  // "Review": two whole-number counts, as digits typed.
  tripadvisor: string;
  google: string;
}

const EMPTY_DRAFT: ServiceDraft = {
  roomClass: '',
  fromRoomClass: '',
  toRoomClass: '',
  nights: '',
  price: '',
  note: '',
  tripadvisor: '',
  google: '',
};

/** Whether one chosen service has everything it asks for. */
function draftReady(type: RoomServiceType, d: ServiceDraft): boolean {
  const needs = roomServiceFields(type);
  if (needs.review) {
    // A blank count is 0; the pair must report at least one review.
    const t = parseCount(d.tripadvisor);
    const g = parseCount(d.google);
    return t !== null && g !== null && t + g > 0;
  }
  return (
    parseVnd(d.price) !== null &&
    (!needs.roomClass || d.roomClass.trim().length > 0) &&
    (!needs.upgrade || (d.fromRoomClass.trim().length > 0 && d.toRoomClass.trim().length > 0)) &&
    (!needs.nights || parseNights(d.nights) !== null)
  );
}

/** One service's body — its OWN fields only (see the form's comment). */
function serviceBody(type: RoomServiceType, d: ServiceDraft, guestName: string, ezCode: string): NewRoomServiceInput {
  const needs = roomServiceFields(type);
  const common = { serviceType: type, guestName, ezCode: ezCode || undefined };
  if (needs.review) {
    // A count, not a sale: no price and no note are sent at all.
    return { ...common, tripadvisorCount: parseCount(d.tripadvisor) ?? 0, googleCount: parseCount(d.google) ?? 0 };
  }
  return {
    ...common,
    price: parseVnd(d.price) ?? 0,
    note: d.note.trim() || undefined,
    ...(needs.roomClass ? { roomClass: d.roomClass.trim() } : {}),
    ...(needs.upgrade ? { fromRoomClass: d.fromRoomClass.trim(), toRoomClass: d.toRoomClass.trim() } : {}),
    ...(needs.nights ? { nights: parseNights(d.nights) ?? undefined } : {}),
  };
}

/** What one chosen service still needs, in the words of its fields. */
function draftMissing(type: RoomServiceType, d: ServiceDraft): string[] {
  const needs = roomServiceFields(type);
  if (needs.review) {
    const t = parseCount(d.tripadvisor);
    const g = parseCount(d.google);
    return t !== null && g !== null && t + g > 0 ? [] : ['số review (Tripadvisor hoặc Google)'];
  }
  return [
    ...(parseVnd(d.price) === null ? [ROOM_SERVICE_PRICE_LABEL.toLowerCase()] : []),
    ...(needs.roomClass && !d.roomClass.trim() ? ['hạng phòng'] : []),
    ...(needs.upgrade && !(d.fromRoomClass.trim() && d.toRoomClass.trim()) ? ['từ / tới hạng phòng'] : []),
    ...(needs.nights && parseNights(d.nights) === null ? ['số đêm'] : []),
  ];
}

/** One service row as typed: which service (none chosen yet: ''), and its own fields. */
interface ServiceRow {
  key: number;
  type: RoomServiceType | '';
  draft: ServiceDraft;
}

const blankRow = (key: number): ServiceRow => ({ key, type: '', draft: EMPTY_DRAFT });

/**
 * ONE GUEST, ONE OR SEVERAL SERVICES — a guest may buy a room night, smoke and
 * send laundry in the same stay.
 *
 * THE GUEST FIRST: "Mã EZ" and "Tên khách", once. A Mã EZ already in the
 * journal fills an EMPTY name with the name it was recorded with; a name already
 * typed is never replaced — a different recorded name is offered, not imposed.
 * An unknown code is simply typed with its name.
 *
 * THEN ONE ROW PER SERVICE: each row chooses its service and shows exactly that
 * service's fields (from `roomServiceFields`, the table the tables and the
 * correction dialog read); "+ Thêm dịch vụ" adds a row, the bin removes one.
 * Each row is still recorded as ONE entry of its own, so every table, total,
 * KPI and export reads it unchanged; several are saved together, all or none.
 *
 * A HIDDEN FIELD IS NEVER SENT: each body is built from its own service's
 * fields only, and the server applies the same rule again.
 */
export function RoomServiceForm({
  options,
  onCreated,
  bare,
  onCancel,
  branchId,
}: {
  options?: ReportOptions;
  onCreated: () => void | Promise<void>;
  bare?: boolean;
  onCancel?: () => void;
  /** A supervisor's target branch; omitted for Reception (its shift decides). */
  branchId?: number;
}) {
  const [guestName, setGuestName] = useState('');
  const [ezCode, setEzCode] = useState('');
  const [rows, setRows] = useState<ServiceRow[]>([blankRow(1)]);

  const { mutation, error, confirmDuplicate } = useCreateReport(async () => {
    setGuestName('');
    setEzCode('');
    setRows([blankRow(1)]);
    await onCreated();
  }, branchId);

  // "Mã EZ" → the name it was recorded with (the reader's own scope, on the server).
  const ez = useDebounced(ezCode.trim(), 400);
  const lookup = useQuery({
    queryKey: ['reception', 'reports', 'guest', ez, branchId ?? null],
    queryFn: () => reportsApi.guest(ez, { branchId }),
    enabled: ez.length > 0,
    staleTime: 60_000,
  });
  const known = ez.length > 0 && ez === ezCode.trim() ? (lookup.data?.guest ?? null) : null;
  // Fill an empty name once per code — never over what was typed.
  const filledFor = useRef<string | null>(null);
  useEffect(() => {
    if (known && filledFor.current !== known.ezCode && guestName.trim() === '') {
      filledFor.current = known.ezCode;
      setGuestName(known.guestName);
    }
  }, [known, guestName]);
  const differs = known !== null && guestName.trim() !== '' && guestName.trim() !== known.guestName;

  const labelOf = (t: RoomServiceType) =>
    options?.roomServiceTypes.find((x) => x.code === t)?.label ?? ROOM_SERVICE_FALLBACK_LABELS[t];
  const setRow = (key: number, patch: Partial<ServiceRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const setField = (key: number, field: keyof ServiceDraft, value: string) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, draft: { ...r.draft, [field]: value } } : r)));

  const chosen = rows.filter((r): r is ServiceRow & { type: RoomServiceType } => r.type !== '');
  const ready =
    guestName.trim().length > 0 && rows.length > 0 && chosen.length === rows.length && chosen.every((r) => draftReady(r.type, r.draft));

  const submit = () => {
    if (!ready) return;
    const bodies = chosen.map((r) => serviceBody(r.type, r.draft, guestName.trim(), ezCode.trim()));
    // One service: the single entry, exactly as before. Several: saved together.
    mutation.mutate(
      bodies.length === 1
        ? { category: 'ROOM_SERVICE', roomService: bodies[0]! }
        : { category: 'ROOM_SERVICE', roomServices: bodies },
    );
  };

  return (
    <FormShell
      title="Thêm dịch vụ"
      testId="room-service-form"
      bare={bare}
      onCancel={onCancel}
      ready={ready}
      pending={mutation.isPending}
      error={error}
      onConfirmDuplicate={confirmDuplicate}
      onSubmit={submit}
    >
      <fieldset className="space-y-2" data-testid="room-service-guest-block">
        <legend className="text-sm font-semibold text-slate-800">Khách</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Mã EZ" value={ezCode} onChange={(e) => setEzCode(e.target.value)} autoComplete="off" data-testid="room-service-ez" />
          <Input label="Tên khách" value={guestName} onChange={(e) => setGuestName(e.target.value)} data-testid="room-service-guest" />
        </div>
        {ez.length > 0 && lookup.isFetching ? <p className="text-xs text-slate-500">Đang tìm khách theo mã EZ…</p> : null}
        {differs ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-amber-900" data-testid="room-service-ez-differs">
            Mã EZ này đã ghi với tên “{known.guestName}”.
            <button type="button" className="font-semibold underline" onClick={() => setGuestName(known.guestName)} data-testid="room-service-ez-use">
              Dùng tên này
            </button>
          </p>
        ) : known ? (
          <p className="text-xs text-emerald-800" data-testid="room-service-ez-found">
            Đã tìm thấy khách theo mã EZ.
          </p>
        ) : ez.length > 0 && lookup.isSuccess && ez === ezCode.trim() ? (
          <p className="text-xs text-slate-500" data-testid="room-service-ez-unknown">
            Chưa có khách nào với mã EZ này — nhập tên khách.
          </p>
        ) : null}
      </fieldset>

      <ul className="space-y-3" data-testid="room-service-rows">
        {rows.map((r, i) => {
          const missing = r.type ? draftMissing(r.type, r.draft) : [];
          return (
            <li key={r.key} className="space-y-3 rounded-xl border border-line-subtle p-3" data-testid={`room-service-row-${i}`}>
              <div className="flex items-end gap-2">
                <label className="block min-w-0 flex-1">
                  <span className="mb-1 block text-sm font-medium text-slate-700">Dịch vụ {i + 1}</span>
                  <select
                    value={r.type}
                    onChange={(e) => setRow(r.key, { type: e.target.value as RoomServiceType | '' })}
                    className="block min-h-[2.75rem] w-full rounded-lg border border-line-strong bg-white px-3 text-base text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
                    data-testid={`room-service-select-${i}`}
                  >
                    <option value="">Chọn dịch vụ…</option>
                    {/* One entry per service for a guest: a service chosen on another row is not offered twice. */}
                    {ROOM_SERVICE_ORDER.map((t) => (
                      <option key={t} value={t} disabled={rows.some((o) => o.key !== r.key && o.type === t)}>
                        {labelOf(t)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-red-700"
                  aria-label={`Bỏ dịch vụ ${i + 1}`}
                  data-testid={`room-service-remove-${i}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              {r.type ? (
                <ServiceFields label={labelOf(r.type)} type={r.type} draft={r.draft} onField={(field, value) => setField(r.key, field, value)} />
              ) : (
                <p className="text-xs text-slate-500">Chọn dịch vụ để nhập thông tin.</p>
              )}
              {missing.length > 0 ? (
                <p className="text-xs text-red-700" data-testid={`room-service-missing-${i}`}>
                  Còn thiếu: {missing.join(', ')}.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => setRows((rs) => [...rs, blankRow(rs.length === 0 ? 1 : Math.max(...rs.map((x) => x.key)) + 1)])}
          data-testid="room-service-add-row"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Thêm dịch vụ
        </Button>
        <p className="text-sm text-slate-600" data-testid="room-service-count">
          {rows.length === 0 ? 'Chưa có dịch vụ nào' : `${rows.length} dịch vụ`}
          {!guestName.trim() && rows.length > 0 ? ' · cần nhập tên khách' : ''}
        </p>
      </div>
    </FormShell>
  );
}

/** One chosen service's block: exactly the fields it asks for. */
function ServiceFields({
  label,
  type,
  draft,
  onField,
}: {
  label: string;
  type: RoomServiceType;
  draft: ServiceDraft;
  onField: (field: keyof ServiceDraft, value: string) => void;
}) {
  const needs = roomServiceFields(type);
  return (
    <fieldset className="space-y-3 rounded-xl border border-line-subtle p-3" data-testid={`room-service-item-${type}`}>
      <legend className="px-1 text-sm font-semibold text-slate-800">{label}</legend>
      {/*
        THE SAME COLUMN WIDTHS AS THE ROWS AROUND IT. "Bán phòng" has two
        fields here (Hạng phòng, Số đêm) and gets two columns, like Tên
        khách / Mã EZ above and Giá tiền / Ghi chú below; "Upgrade" has
        three (Từ, Tới hạng phòng, Số đêm) and gets three.
      */}
      {needs.roomClass || needs.upgrade || needs.nights ? (
        <div className={`grid gap-3 ${needs.upgrade ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`} data-testid="room-service-conditional">
          {needs.roomClass ? (
            <Input label="Hạng phòng" value={draft.roomClass} onChange={(e) => onField('roomClass', e.target.value)} data-testid="room-service-class" />
          ) : null}
          {needs.upgrade ? (
            <>
              <Input
                label="Từ hạng phòng"
                value={draft.fromRoomClass}
                onChange={(e) => onField('fromRoomClass', e.target.value)}
                data-testid="room-service-from"
              />
              <Input
                label="Tới hạng phòng"
                value={draft.toRoomClass}
                onChange={(e) => onField('toRoomClass', e.target.value)}
                data-testid="room-service-to"
              />
            </>
          ) : null}
          {needs.nights ? (
            // A whole number of nights: a number keyboard on a phone, digits only ("at least 1": parseNights and the server).
            <Input
              label="Số đêm"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={draft.nights}
              onChange={(e) => onField('nights', e.target.value.replace(/\D/g, ''))}
              data-testid="room-service-nights"
            />
          ) : null}
        </div>
      ) : null}

      {needs.review ? (
        // "REVIEW" IS A COUNT: how many reviews the guest left on each site — never text, never a price.
        <div className="grid gap-3 sm:grid-cols-2" data-testid="room-service-review-counts">
          <Input
            label="Tripadvisor"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={draft.tripadvisor}
            onChange={(e) => onField('tripadvisor', e.target.value.replace(/\D/g, ''))}
            placeholder="0"
            data-testid="room-service-tripadvisor"
          />
          <Input
            label="Google"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={draft.google}
            onChange={(e) => onField('google', e.target.value.replace(/\D/g, ''))}
            placeholder="0"
            data-testid="room-service-google"
          />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <MoneyInput label={ROOM_SERVICE_PRICE_LABEL} required value={draft.price} onChange={(v) => onField('price', v)} data-testid="room-service-price" />
          <Input label="Ghi chú" value={draft.note} onChange={(e) => onField('note', e.target.value)} data-testid="room-service-note" />
        </div>
      )}
    </fieldset>
  );
}

/* ------------------- Giao nhận hàng hóa của khách sạn ------------------- */

/**
 * BỘ PHẬN, TÊN HÀNG HÓA, SỐ LƯỢNG — and an optional note.
 *
 * "Số lượng" is a NUMBER input, not a text box: the box refuses letters, and
 * `parseQuantity` (like the server's own check) refuses zero, a fraction and a
 * negative, so a quantity is never free text. There is no status field to fill
 * in: submitting is the hand-over, and the record is stored as "Đã hoàn thành" —
 * the form says so rather than asking.
 */
export function DeliveryForm({
  options,
  onCreated,
  bare,
  onCancel,
  branchId,
}: {
  options?: ReportOptions;
  onCreated: () => void | Promise<void>;
  bare?: boolean;
  onCancel?: () => void;
  /** A supervisor's target branch; omitted for Reception (its shift decides). */
  branchId?: number;
}) {
  const departments = options?.deliveryDepartments ?? DELIVERY_DEPARTMENT_FALLBACK;
  const [department, setDepartment] = useState<DeliveryDepartment | ''>('');
  const [itemName, setItemName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const { mutation, error, confirmDuplicate } = useCreateReport(async () => {
    setDepartment('');
    setItemName('');
    setQuantity('');
    setNote('');
    await onCreated();
  }, branchId);

  const parsed = parseQuantity(quantity);
  return (
    <FormShell
      title="Giao nhận hàng hóa của khách sạn"
      testId="delivery-form"
      bare={bare}
      onCancel={onCancel}
      ready={department !== '' && itemName.trim().length > 0 && parsed !== null}
      pending={mutation.isPending}
      error={error}
      onConfirmDuplicate={confirmDuplicate}
      onSubmit={() =>
        department !== '' && parsed !== null
          ? mutation.mutate({
              category: 'HOTEL_DELIVERY',
              delivery: {
                department,
                itemName: itemName.trim(),
                quantity: parsed,
                note: note.trim() || undefined,
              },
            })
          : undefined
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm font-medium text-slate-700">
          Bộ phận
          <select
            value={department}
            onChange={(e) => setDepartment(e.target.value as DeliveryDepartment | '')}
            data-testid="delivery-department"
            className="block w-full rounded-xl border border-line-strong bg-white px-3 py-2.5 text-sm font-normal text-slate-900 hover:border-slate-600 focus:outline-none focus:ring-2 focus:ring-brand-600"
          >
            <option value="">— Chọn bộ phận —</option>
            {departments.map((d) => (
              <option key={d.code} value={d.code}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <Input
          label="Số lượng"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          data-testid="delivery-quantity"
          error={quantity !== '' && parsed === null ? 'Số lượng phải là số nguyên từ 1 trở lên.' : undefined}
        />
      </div>
      <Input
        label="Tên hàng hóa"
        value={itemName}
        onChange={(e) => setItemName(e.target.value)}
        data-testid="delivery-item"
      />
      <TextArea label="Ghi chú (không bắt buộc)" value={note} onChange={setNote} testId="delivery-note" maxLength={2000} />
      <p className="text-xs text-slate-500" data-testid="delivery-status-hint">
        Trạng thái: <span className="font-medium text-emerald-700">Đã hoàn thành</span> — bản ghi được lưu ở
        trạng thái này ngay khi gửi.
      </p>
    </FormShell>
  );
}
