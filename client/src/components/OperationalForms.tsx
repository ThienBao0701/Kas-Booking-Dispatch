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
import { useState } from 'react';
import { SeverityPicker } from './Severity';
import { DEFAULT_SEVERITY } from '../lib/severity';
import type { Severity } from '../api/receptionReports';
import { useReportSubmitOverride } from '../lib/reportSubmit';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import {
  reportsApi,
  type DeliveryDepartment,
  type NewReportInput,
  type NewRoomServiceInput,
  type ReportOptions,
  type RoomServiceType,
} from '../api/receptionReports';
import { toUserMessage } from '../api/errors';
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
}

function FormShell({ title, testId, ready, pending, error, onSubmit, children, bare, onCancel }: FormShellProps) {
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
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
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
  // "Nhập bù" submits the same form to its own endpoint (see lib/reportSubmit).
  const override = useReportSubmitOverride();
  const mutation = useMutation({
    mutationFn: (input: NewReportInput) => (override ? override(input) : reportsApi.create({ ...input, branchId })),
    onSuccess: async () => {
      setError(null);
      await onCreated();
    },
    onError: (e) => setError(toUserMessage(e)),
  });
  return { mutation, error, setError };
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
  const [guestName, setGuestName] = useState('');
  const [ezCode, setEzCode] = useState('');
  const [content, setContent] = useState('');
  const [severity, setSeverity] = useState<Severity>(DEFAULT_SEVERITY);
  const { mutation, error } = useCreateReport(async () => {
    setGuestName('');
    setEzCode('');
    setContent('');
    setSeverity(DEFAULT_SEVERITY);
    await onCreated();
  }, branchId);

  return (
    <FormShell
      title="Vấn đề khách yêu cầu thực hiện"
      testId="guest-request-form"
      bare={bare}
      onCancel={onCancel}
      ready={guestName.trim().length > 0 && content.trim().length > 0}
      pending={mutation.isPending}
      error={error}
      onSubmit={() =>
        mutation.mutate({
          category: 'GUEST_REQUEST',
          guestRequest: {
            guestName: guestName.trim(),
            ezCode: ezCode.trim() || undefined,
            note: content.trim(),
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
          data-testid="guest-request-guest"
        />
        <Input label="Mã EZ" value={ezCode} onChange={(e) => setEzCode(e.target.value)} data-testid="guest-request-ez" />
      </div>
      <SeverityPicker value={severity} onChange={setSeverity} testId="guest-request-severity" />
      <TextArea
        label="Nội dung"
        value={content}
        onChange={setContent}
        maxLength={2000}
        testId="guest-request-content"
      />
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
  const { mutation, error } = useCreateReport(async () => {
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

/**
 * ONE GUEST, ONE OR SEVERAL SERVICES — a guest may buy a room night, smoke and
 * send laundry in the same stay.
 *
 * "Chọn dịch vụ" ticks any number of the six; Tên khách and Mã EZ are asked
 * once, and each ticked service gets its own block with exactly its own fields
 * (from `roomServiceFields`, the table the tables and the correction dialog
 * read). Each service is still recorded as ONE entry of its own, so every
 * table, total, KPI and export reads it unchanged; several are saved together,
 * all or none.
 *
 * A HIDDEN FIELD IS NEVER SENT. Typing a room class, unticking "Bán phòng" and
 * saving submits no room class: each body is built from its service's own
 * fields, not from every box that ever had text in it. The server applies the
 * same rule again on its side.
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
  const [selected, setSelected] = useState<RoomServiceType[]>([]);
  const [guestName, setGuestName] = useState('');
  const [ezCode, setEzCode] = useState('');
  const [drafts, setDrafts] = useState<Partial<Record<RoomServiceType, ServiceDraft>>>({});

  const { mutation, error } = useCreateReport(async () => {
    setSelected([]);
    setGuestName('');
    setEzCode('');
    setDrafts({});
    await onCreated();
  }, branchId);

  const labelOf = (t: RoomServiceType) =>
    options?.roomServiceTypes.find((x) => x.code === t)?.label ?? ROOM_SERVICE_FALLBACK_LABELS[t];
  const draftOf = (t: RoomServiceType) => drafts[t] ?? EMPTY_DRAFT;
  const setField = (t: RoomServiceType, field: keyof ServiceDraft, value: string) =>
    setDrafts((prev) => ({ ...prev, [t]: { ...(prev[t] ?? EMPTY_DRAFT), [field]: value } }));
  // Always in the selector's own order, whatever order they were ticked in.
  const toggle = (t: RoomServiceType) =>
    setSelected((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : ROOM_SERVICE_ORDER.filter((x) => x === t || prev.includes(x))));

  const ready = selected.length > 0 && guestName.trim().length > 0 && selected.every((t) => draftReady(t, draftOf(t)));

  const submit = () => {
    if (!ready) return;
    const bodies = selected.map((t) => serviceBody(t, draftOf(t), guestName.trim(), ezCode.trim()));
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
      onSubmit={submit}
    >
      <fieldset className="space-y-2" data-testid="room-service-type">
        <legend className="text-sm font-medium text-slate-700">Chọn dịch vụ</legend>
        <p className="text-xs text-slate-500">Có thể chọn nhiều dịch vụ cho cùng một khách — mỗi dịch vụ được ghi thành một dòng riêng.</p>
        <div className="flex flex-wrap gap-2">
          {ROOM_SERVICE_ORDER.map((t) => {
            const on = selected.includes(t);
            return (
              <label
                key={t}
                className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                  on ? 'border-brand-600 bg-brand-50 font-medium text-brand-800' : 'border-line-strong bg-white text-slate-700 hover:border-slate-600'
                }`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(t)}
                  data-testid={`room-service-type-${t}`}
                  className="h-4 w-4 accent-brand-600"
                />
                {labelOf(t)}
              </label>
            );
          })}
        </div>
      </fieldset>

      {selected.length > 0 ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Tên khách" value={guestName} onChange={(e) => setGuestName(e.target.value)} data-testid="room-service-guest" />
            <Input label="Mã EZ" value={ezCode} onChange={(e) => setEzCode(e.target.value)} data-testid="room-service-ez" />
          </div>
          {selected.map((t) => (
            <ServiceFields key={t} label={labelOf(t)} type={t} draft={draftOf(t)} onField={(field, value) => setField(t, field, value)} />
          ))}
        </>
      ) : (
        <p className="text-sm text-slate-500" data-testid="room-service-pick-first">
          Chọn dịch vụ để nhập thông tin.
        </p>
      )}
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
  const { mutation, error } = useCreateReport(async () => {
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
