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
 * "Sự cố vật chất đang xử lý" has NO form here — it is a monitoring board, not
 * an entry category. See `FacilityIssueBoard.tsx`.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import {
  reportsApi,
  type NewReportInput,
  type ReportOptions,
  type RoomServiceType,
} from '../api/receptionReports';
import { toUserMessage } from '../api/errors';
import { Button } from './Button';
import { Input } from './Input';
import { ErrorAlert } from './ErrorAlert';
import { MoneyInput } from './MoneyInput';
import { parseVnd } from '../lib/money';
import { roomServiceFields } from '../lib/roomServiceFields';

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
      className={bare ? 'space-y-3' : 'space-y-3 rounded-2xl border border-slate-200 bg-white px-4 py-4'}
    >
      {bare ? null : <p className="text-sm font-semibold text-slate-800">{title}</p>}
      {children}
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      <div className={`flex justify-end gap-2 ${bare ? 'border-t border-slate-100 pt-3' : ''}`}>
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

/** Shared mutation wiring — every form creates through the same endpoint. */
function useCreateReport(onCreated: () => void | Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (input: NewReportInput) => reportsApi.create(input),
    onSuccess: async () => {
      setError(null);
      await onCreated();
    },
    onError: (e) => setError(toUserMessage(e)),
  });
  return { mutation, error, setError };
}

/* ---------------------- Vấn đề khách yêu cầu ---------------------- */

export function GuestRequestForm({
  options,
  onCreated,
  bare,
  onCancel,
}: {
  options?: ReportOptions;
  onCreated: () => void | Promise<void>;
  bare?: boolean;
  onCancel?: () => void;
}) {
  const [itemType, setItemType] = useState('');
  const [guestName, setGuestName] = useState('');
  const [note, setNote] = useState('');
  const { mutation, error } = useCreateReport(async () => {
    setItemType('');
    setGuestName('');
    setNote('');
    await onCreated();
  });

  const suggestions = options?.guestRequestItems ?? ['Balo', 'Hành lý', 'Vật dụng khác'];

  return (
    <FormShell
      title="Vấn đề khách yêu cầu"
      testId="guest-request-form"
      bare={bare}
      onCancel={onCancel}
      ready={itemType.trim().length > 0 && guestName.trim().length > 0}
      pending={mutation.isPending}
      error={error}
      onSubmit={() =>
        mutation.mutate({
          category: 'GUEST_REQUEST',
          guestRequest: {
            itemType: itemType.trim(),
            guestName: guestName.trim(),
            note: note.trim() || undefined,
          },
        })
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Input
            label="Ký gửi"
            value={itemType}
            onChange={(e) => setItemType(e.target.value)}
            placeholder="Balo, Hành lý, Vật dụng khác…"
            data-testid="guest-request-item"
          />
          {/*
            SUGGESTIONS, NOT A CLOSED LIST. A guest leaving a wedding dress or a
            bicycle must be recorded as that, not forced into "Vật dụng khác",
            which loses the one fact the record exists to preserve.
          */}
          <div className="flex flex-wrap gap-1">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setItemType(s)}
                data-testid={`guest-request-suggest-${s}`}
                className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <Input
          label="Tên khách"
          value={guestName}
          onChange={(e) => setGuestName(e.target.value)}
          data-testid="guest-request-guest"
        />
      </div>
      <Input label="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} data-testid="guest-request-note" />
    </FormShell>
  );
}

/* -------------------- Vấn đề về chất lượng dịch vụ -------------------- */

export function ServiceQualityForm({
  onCreated,
  bare,
  onCancel,
}: {
  onCreated: () => void | Promise<void>;
  bare?: boolean;
  onCancel?: () => void;
}) {
  const [guestName, setGuestName] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const { mutation, error } = useCreateReport(async () => {
    setGuestName('');
    setLocation('');
    setDescription('');
    await onCreated();
  });

  return (
    <FormShell
      title="Vấn đề về chất lượng dịch vụ"
      testId="service-quality-form"
      bare={bare}
      onCancel={onCancel}
      ready={
        guestName.trim().length > 0 && location.trim().length > 0 && description.trim().length > 0
      }
      pending={mutation.isPending}
      error={error}
      onSubmit={() =>
        mutation.mutate({
          category: 'CUSTOMER_COMPLAINT',
          complaint: {
            guestName: guestName.trim(),
            location: location.trim(),
            description: description.trim(),
          },
        })
      }
    >
      {/*
        THREE FIELDS, AND NO MORE. No priority, no severity, no status: this is an
        operational record for the Admin and for whatever follow-up happens
        outside this system, not a ticket queue with no worker assigned to it.
        The category is still `CUSTOMER_COMPLAINT` on the wire — only the label a
        receptionist reads changed, so the existing audit rows, exports and
        authorization all keep working unmodified.
      */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Tên khách"
          value={guestName}
          onChange={(e) => setGuestName(e.target.value)}
          data-testid="service-quality-guest"
        />
        <Input
          label="Số phòng / Khác"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="101, Sảnh, Nhà hàng…"
          data-testid="service-quality-location"
        />
      </div>
      <label className="block text-sm font-medium text-slate-700">
        Mô tả
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={4000}
          data-testid="service-quality-description"
          className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
        />
      </label>
    </FormShell>
  );
}

/* ------------------------- Dịch vụ phòng, KPI ------------------------- */

/**
 * THE SUBTYPE IS CHOSEN OUTSIDE THIS FORM.
 *
 * The records table and this form must show the SAME subtype — "Bán phòng"
 * entries under a "Bán phòng" table, never mixed with "Giặt ủi" — so the
 * selection lives on `OperationalReportsPage` beside the table, and this form
 * only reads it. It renders no picker of its own: two pickers over one piece of
 * state is two places to read it and one to forget.
 */
export function RoomServiceForm({
  serviceType,
  onCreated,
  bare,
  onCancel,
}: {
  serviceType: RoomServiceType;
  onCreated: () => void | Promise<void>;
  bare?: boolean;
  onCancel?: () => void;
}) {
  const [guestName, setGuestName] = useState('');
  const [phone, setPhone] = useState('');
  const [roomNumber, setRoomNumber] = useState('');
  const [roomClass, setRoomClass] = useState('');
  const [fromRoomClass, setFromRoomClass] = useState('');
  const [toRoomClass, setToRoomClass] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');

  const { mutation, error } = useCreateReport(async () => {
    setGuestName('');
    setPhone('');
    setRoomNumber('');
    setRoomClass('');
    setFromRoomClass('');
    setToRoomClass('');
    setServiceName('');
    setPrice('');
    setNote('');
    await onCreated();
  });

  // The SAME table the records list and the correction dialog read — the form
  // RENDERS from it and does not decide validity, so a request made with curl
  // is refused by the same rule the operator sees.
  const needs = roomServiceFields(serviceType);

  const ready =
    guestName.trim().length > 0 &&
    parseVnd(price) !== null &&
    (!needs.roomClass || roomClass.trim().length > 0) &&
    (!needs.upgrade || (fromRoomClass.trim().length > 0 && toRoomClass.trim().length > 0)) &&
    (!needs.roomNumber || roomNumber.trim().length > 0) &&
    (!needs.serviceName || serviceName.trim().length > 0);

  return (
    <FormShell
      title="Dịch vụ phòng, KPI"
      testId="room-service-form"
      bare={bare}
      onCancel={onCancel}
      ready={ready}
      pending={mutation.isPending}
      error={error}
      onSubmit={() =>
        mutation.mutate({
          category: 'ROOM_SERVICE',
          roomService: {
            serviceType,
            guestName: guestName.trim(),
            phone: phone.trim() || undefined,
            roomNumber: roomNumber.trim() || undefined,
            roomClass: roomClass.trim() || undefined,
            fromRoomClass: fromRoomClass.trim() || undefined,
            toRoomClass: toRoomClass.trim() || undefined,
            serviceName: serviceName.trim() || undefined,
            price: parseVnd(price) ?? 0,
            note: note.trim() || undefined,
          },
        })
      }
    >
      {/*
        NO SUBTYPE PICKER HERE ANY MORE. Choosing which subtype to LOOK at is a
        view decision and lives on the page; this dialog adds to whichever one
        is selected, and its title says which. Two pickers with one selection
        between them is two places to read the same state and one to forget.
      */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Input label="Tên khách" value={guestName} onChange={(e) => setGuestName(e.target.value)} data-testid="room-service-guest" />
        {needs.phone ? (
          <Input
            label="SĐT"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            hint="Không bắt buộc."
            data-testid="room-service-phone"
          />
        ) : null}
        {needs.roomClass ? (
          <Input label="Loại phòng" value={roomClass} onChange={(e) => setRoomClass(e.target.value)} data-testid="room-service-class" />
        ) : null}
        {needs.upgrade ? (
          <>
            <Input
              label="Từ hạng phòng"
              value={fromRoomClass}
              onChange={(e) => setFromRoomClass(e.target.value)}
              data-testid="room-service-from"
            />
            <Input
              label="Lên hạng phòng"
              value={toRoomClass}
              onChange={(e) => setToRoomClass(e.target.value)}
              data-testid="room-service-to"
            />
          </>
        ) : null}
        {needs.roomNumber ? (
          <Input label="Phòng" value={roomNumber} onChange={(e) => setRoomNumber(e.target.value)} data-testid="room-service-room" />
        ) : null}
        {needs.serviceName ? (
          <Input
            label="Loại hình dịch vụ"
            value={serviceName}
            onChange={(e) => setServiceName(e.target.value)}
            data-testid="room-service-name"
          />
        ) : null}
        <MoneyInput label="Giá tiền" required value={price} onChange={setPrice} data-testid="room-service-price" />
      </div>

      <Input label="Ghi chú" value={note} onChange={(e) => setNote(e.target.value)} data-testid="room-service-note" />
    </FormShell>
  );
}
