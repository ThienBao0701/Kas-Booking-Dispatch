import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, CalendarCheck2, ChevronDown, ClipboardList, StickyNote } from 'lucide-react';
import {
  type BookingDetail,
  type OperationalRecord,
  type RequestAuditView,
  type RoomView,
} from '../api/bookings';
import { buildPmsNote } from '../lib/pmsNote';
import { formatAmountCopy, formatDate, formatDateTime, formatMoney } from '../lib/format';
import { Card } from './Card';
import { CopyButton, CopyField, CutButton, CutPlaceholder } from './CopyButton';
import { ClaimCountdown } from './ClaimCountdown';
import { CUT_PLACEHOLDER, type CutController } from '../lib/cut';
import { LastMinuteBadge, PaymentBadge, SourceBadge, WorkflowBadge } from './Badges';
import { ErrorAlert } from './ErrorAlert';
import { Section } from './Section';
import { DeleteBookingButton } from './DeleteBookingButton';
import { RedispatchButton } from './RedispatchButton';
import { ProofSection } from './ProofSection';
import { Toast } from './Toast';

const MISSING_PHONE = '(Hiển thị số điện thoại)';

/** How the reviewed payment mode reads to an operator. Never translated further. */
const PAYMENT_MODE_LABEL: Record<string, string> = {
  CN: 'CN',
  HOTEL_PAYMENT: 'THANH TOÁN TẠI KHÁCH SẠN',
};

/**
 * Hotel policy times, shown beside the stay dates in the header, in 12-hour
 * form with the Vietnamese part of day spelled out.
 *
 * They are the same for every reservation: the hotel applies one arrival and
 * one departure time to all of them, and no source sends a per-booking time.
 * Constants rather than booking fields precisely BECAUSE they are policy — a
 * screen that read them off the booking would imply they can differ per guest.
 * Display only: nothing writes them back and no logic reads them.
 */
const CHECK_IN_TIME = '02:00PM (CHIỀU)';
const CHECK_OUT_TIME = '12:00PM (TRƯA)';

/** Booking.com is the only source that reliably supplies a guest phone. */
function hasPhoneSection(booking: BookingDetail): boolean {
  if (booking.sourcePlatform === 'BOOKING_COM') return true;
  return (booking.phone ?? '').trim().length > 0;
}

/**
 * One "<label> : <date>   <time>" line in the sticky header.
 *
 * The DATE is always the booking's own — never a constant — so every booking
 * renders its own stay. The TIME is the hotel policy constant beside it.
 *
 * BOLD THROUGHOUT, icon included: the two lines are the first thing read on
 * this screen and they are read together, so no part of either is allowed to
 * recede. Label and date carry fixed widths so the check-in and check-out
 * columns line up under one another instead of drifting with the text.
 */
function StayLine({ label, date, time }: { label: string; date: string | null | undefined; time: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-bold text-slate-900">
      <CalendarCheck2 className="h-4 w-4 stroke-[2.5] text-brand-600" aria-hidden="true" />
      <span className="w-24">{label} :</span>
      <span className="w-24">{formatDate(date)}</span>
      <span>{time}</span>
    </div>
  );
}

/**
 * The payment field, per source. ADMIN-ONLY — see the supporting-fields block.
 *
 * H1 — the PAY BEFORE / PAY AFTER CHECK-IN wording belongs to Booking.com,
 * whose `paymentStatus` genuinely means that. Applying it to an OTA booking
 * stated something the mail never said.
 *
 * Agoda supplies its own wording ("CN", "Pay at Hotel", …) which the parser
 * already captured and dispatch already stored; it is shown VERBATIM, never
 * mapped onto the Booking.com vocabulary.
 *
 * CTrip supplies nothing — its parser extracts no payment value at all — so
 * the field is absent rather than filled with a guess. An invented payment
 * term is the kind of error a branch would act on.
 */
function PaymentField({ booking }: { booking: BookingDetail }) {
  if (booking.sourcePlatform === 'BOOKING_COM') {
    return (
      <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Thanh toán</p>
        <div className="mt-1">
          <PaymentBadge status={booking.paymentStatus} />
        </div>
      </div>
    );
  }

  // The reviewed mode wins: it is what the Admin accepted and what the branch
  // was told. The mail's own wording is the fallback for bookings dispatched
  // before the reviewed value was persisted.
  const reviewed = (booking.reviewedPaymentMode ?? '').trim();
  const stated = (reviewed.length > 0 ? PAYMENT_MODE_LABEL[reviewed] ?? reviewed : booking.ota.paymentType ?? '').trim();
  if (stated.length === 0) return null;
  return <ReadField label="Thanh toán" value={stated} />;
}

/** A compact read-only labelled value (no copy button). */
function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-0.5 break-words text-sm text-slate-900">{value}</p>
    </div>
  );
}

/**
 * The full operational detail — shared by the standalone detail page and the
 * receptionist master-detail panel. Copy controls are deliberately minimal:
 * four main fields, one nightly-price copy per room row, and the PMS note.
 * When `onCompleted` is provided the parent owns the success toast (pass
 * `suppressInternalToast`) so it survives the panel switching.
 *
 * A receptionist sees FIVE things and nothing else: the summary, the main
 * information, the PMS note, the nightly rates and the proof upload (plus an
 * extraction warning when the parser flagged one, which is a thing to act on
 * rather than a record to read). Everything a colleague might find interesting
 * but nobody acts on — what the OTA said, the edit history, the activity log —
 * is gone from this file entirely, not hidden behind a role check.
 */
export function BookingDetailView({
  booking: b,
  isAdmin,
  onCompleted,
  suppressInternalToast = false,
  cut,
  serverNow,
}: {
  booking: BookingDetail;
  isAdmin: boolean;
  onCompleted?: (message?: string) => void;
  suppressInternalToast?: boolean;
  /**
   * Present only for a receptionist on a claimable dispatch screen. When it is
   * absent this component renders exactly what it always did — which is how
   * every Admin screen keeps its copy buttons untouched.
   */
  cut?: CutController;
  /** Server clock at the time this payload was produced, for the countdown. */
  serverNow?: string | null;
}) {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);
  const showPhone = hasPhoneSection(b);

  // Only the holder of a live claim sees a countdown. Another receptionist's
  // remaining time is not their business, and an elapsed one is not a deadline.
  const claimIsMine = cut?.claimIsMine ?? false;

  function refetchAll() {
    void queryClient.invalidateQueries({ queryKey: ['booking', b.id] });
    void queryClient.invalidateQueries({ queryKey: ['bookings'] });
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    void queryClient.invalidateQueries({ queryKey: ['nav-badges'] });
  }

  /*
    WHEN THE DISPLAY HITS 00:00, ASK THE SERVER — do not decide locally.

    Refetching is what makes the order disappear: the list query no longer
    returns it, because the server filters an elapsed claim out of reception's
    queue. Nothing is removed from the cache by hand, so the screen can never
    hide an order the server still considers live.
  */
  function onClaimExpired() {
    refetchAll();
  }

  // After a proof action (submit / approve / reject) refresh data and surface a
  // toast. The parent owns the toast in the master-detail inbox so it survives
  // the panel switching to the next booking.
  function handleProofChanged(message: string) {
    refetchAll();
    if (suppressInternalToast) onCompleted?.(message);
    else setToast(message);
  }

  /*
    THE CARDS BOTH ROLES HAVE, built once and placed by role below: a receptionist
    reads them in this order because they type the figures into the PMS; the Admin
    reads the evidence first and finds them under "Chi tiết đơn hàng".
  */
  const pmsCard = <PmsNoteCard booking={b} {...(cut ? { cut } : {})} />;
  // H5/H10 — rooms and nightly rates are never collapsed for a receptionist. A
  // receptionist types these figures into the PMS; hiding them behind a
  // disclosure adds a click to every booking and invites transcribing from
  // memory. Absent entirely when there are no rooms, rather than an empty container.
  const roomsCard =
    b.rooms.length > 0 ? (
      <Card className="p-5" data-testid="rooms-section">
        <p className="mb-3 text-sm font-semibold text-slate-700">
          Phòng &amp; giá từng đêm ({b.rooms.length})
        </p>
        <div className="space-y-3">
          {b.rooms.map((room) => (
            <RoomCard key={room.id} room={room} />
          ))}
        </div>
      </Card>
    ) : null;
  // Warnings (never for a missing phone — that is not a blocking condition)
  const warningsCard =
    b.warnings.length > 0 ? (
      <Card className="border-amber-200 bg-amber-50/50 p-5">
        <p className="mb-2 text-sm font-semibold text-amber-800">Cảnh báo trích xuất</p>
        <ul className="list-inside list-disc space-y-1 text-sm text-amber-700">
          {b.warnings.map((w, i) => (
            <li key={`${w.code}-${i}`}>{w.message}</li>
          ))}
        </ul>
      </Card>
    ) : null;

  return (
    <div className="space-y-5" data-testid="booking-detail">
      {/*
        Sticky summary. On a long detail page the operator scrolls into the
        nightly rates or the timeline and loses which guest they are looking at
        — and on a phone that is most of the page. The identity and the status
        stay in view; nothing else is pinned, so the sticky strip cannot grow
        tall enough to eat a small screen.
      */}
      <Card
        className={`sticky top-0 z-10 p-5 ${b.isLastMinute ? 'border-red-200 bg-red-50/95' : 'bg-white/95'} backdrop-blur`}
        data-testid="booking-sticky-header"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {/*
              ONE workflow chip. Four at once left a receptionist working out
              which of them meant "what do I do with this"; there is only ever
              one answer. The Admin keeps the source and business-type detail
              further down the page, where it is an audit concern rather than
              something to act on.
            */}
            <div className="flex flex-wrap items-center gap-2">
              {b.isLastMinute ? <LastMinuteBadge withSubtitle /> : null}
              <WorkflowBadge status={b.verificationStatus} />
              {isAdmin ? <SourceBadge source={b.sourcePlatform} /> : null}
              {/*
                THE COUNTDOWN LIVES HERE, on the booking being worked, and is
                nothing but mm:ss. It appears the moment the first CẮT starts the
                claim and is the only timer on the screen.
              */}
              {cut && claimIsMine ? (
                <ClaimCountdown
                  expiresAt={b.claimExpiresAt!}
                  serverNow={serverNow ?? null}
                  onExpired={onClaimExpired}
                />
              ) : null}
            </div>
            {/*
              The heading repeats the guest's name, so CẮT has to take it from
              here too — hiding the field below while the same string sits in
              32px type above it would remove nothing at all.
            */}
            {cut?.isCut('CUSTOMER_NAME') ? (
              <p className="mt-2 truncate text-xl font-semibold italic text-slate-400">
                {CUT_PLACEHOLDER}
              </p>
            ) : (
              <h1 className="mt-2 truncate text-xl font-semibold text-slate-900">
                {b.customerName ?? 'Khách chưa rõ'}
              </h1>
            )}
            {/*
              Both ends of the stay, each with the hotel's fixed policy time.
              The booking code that used to sit here is gone: it is a value a
              receptionist COPIES, and it already has a copy button of its own
              in the main card below. Duplicating it here gave them a second,
              uncopyable rendering of the same string to mistype from.
            */}
            {/* The Admin dispatches across eight hotels: which one is part of who this is. */}
            {isAdmin && b.branch ? (
              <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-slate-600" data-testid="booking-header-branch">
                <Building2 className="h-4 w-4 text-slate-400" aria-hidden="true" />
                {b.branch.address}
              </p>
            ) : null}
            <div className="mt-2 space-y-1 text-sm text-slate-700">
              <StayLine label="Nhận phòng" date={b.checkInDate} time={CHECK_IN_TIME} />
              <StayLine label="Trả phòng" date={b.checkOutDate} time={CHECK_OUT_TIME} />
            </div>
          </div>
        </div>
      </Card>

      {/* Main copyable fields (only the four operational essentials) */}
      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <ClipboardList className="h-4 w-4 text-brand-600" aria-hidden="true" />
          Thông tin chính
        </div>
        {/*
          RECEPTION sees two fields: the guest and the amount. The booking code
          and the phone number were removed from THEIR card only — reception
          reads the code off the PMS note they paste, and the phone is not
          something they dial from this screen.

          THE PHONE IS NOT GONE FROM THE SYSTEM. It is still on the booking, and
          the PMS note below still prints it beside the contact label — removing
          the field here removes a display, not the data.

          ADMIN keeps all four, unchanged.
        */}
        {/*
          A refused CẮT is shown here rather than as a toast: the reason is
          almost always "someone else already took this order", and that is
          something to read beside the buttons, not something to watch fade.
        */}
        {cut?.error ? (
          <div className="mb-3">
            <ErrorAlert>{cut.error}</ErrorAlert>
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <CopyField
            label="Tên khách"
            value={b.customerName}
            {...(cut ? { cut: { field: 'CUSTOMER_NAME' as const, controller: cut } } : {})}
          />
          {/*
            H2 — Agoda and CTrip rarely supply a guest phone. Showing an empty
            field or a placeholder invites a receptionist to hunt for a number
            that was never sent, so for an OTA booking the field is absent
            entirely. Booking.com keeps its placeholder: there the number is
            expected and its absence is worth noticing.
          */}
          {isAdmin && showPhone ? (
            <CopyField
              label="Số điện thoại"
              value={b.phone ?? MISSING_PHONE}
              copyValue={b.phone ?? MISSING_PHONE}
              mono
            />
          ) : null}
          {isAdmin ? <CopyField label="Mã Booking" value={b.bookingCode} mono /> : null}
          <CopyField
            label="Tổng tiền"
            value={formatMoney(b.totalAmount, b.currency)}
            copyValue={formatAmountCopy(b.totalAmount)}
            {...(cut ? { cut: { field: 'TOTAL_AMOUNT' as const, controller: cut } } : {})}
          />
        </div>

        {/*
          Supporting read-only fields (no copy buttons) — ADMIN ONLY, all of them.

          RECEPTION gets the four copyable essentials and nothing else. Payment,
          Check-in and Check-out were removed from their card: the two dates are
          in the header now, where they are read on every booking, so repeating
          them here was the same value twice on one screen.

          ADMIN keeps every field it has always had. An Admin dispatches across
          eight branches and reconciles payment terms against what the OTA said;
          a receptionist is standing in the one hotel the booking was sent to and
          acts on the four fields above. Branch FILTERING and permissions are
          untouched — this gate is presentational.

          The gate wraps the whole block rather than each child, so reception
          gets no empty grid holding margin under the four fields.
        */}
        {isAdmin ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ReadField label="Chi nhánh" value={b.branch?.address ?? '—'} />
            <PaymentField booking={b} />
          </div>
        ) : null}
        {b.specialRequest ? (
          <div className="mt-3">
            <ReadField label="Ghi chú / Yêu cầu đặc biệt" value={b.specialRequest} />
          </div>
        ) : null}
      </Card>

      {isAdmin ? (
        <>
          {warningsCard}
          {/* Proof-of-creation workflow (upload / review / verdict) — the checking state and its actions. */}
          <ProofSection booking={b} isAdmin={isAdmin} onChanged={handleProofChanged} />

          {/*
            THE ORIGINAL CONTENT stays one click away, on its own line. It is the
            evidence the review is checked against, so it is never buried.
          */}
          {b.rawText ? (
            <Card className="p-0" data-testid="raw-content-card">
              <details className="group px-5 py-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium text-brand-600">
                  Xem nội dung Booking.com gốc
                  <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
                  {b.rawText}
                </pre>
              </details>
            </Card>
          ) : null}

          {/*
            SECONDARY, COLLAPSED. What the receptionist works from (the PMS note,
            the rooms and nightly rates) and what the system recorded about the
            order (times, versions, request provenance) are still all here — one
            click down instead of above the evidence. Nothing was deleted.
          */}
          <Disclosure title="Chi tiết đơn hàng" hint="Ghi chú PMS · phòng & giá từng đêm" testId="booking-detail-more">
            {pmsCard}
            {roomsCard}
          </Disclosure>
          <Disclosure title="Chi tiết nội bộ" hint="Thời gian · phiên bản trích xuất · nguồn yêu cầu" testId="booking-internal-more">
            <OperationalCard record={b.operational} />
            <div className="grid gap-2 text-sm text-slate-600 sm:grid-cols-2" data-testid="booking-internal-times">
              <span>Gửi lúc (sentAt): {formatDateTime(b.sentAt)} {b.sentBy ? `· ${b.sentBy.fullName}` : ''}</span>
              <span>Xác nhận lúc (completedAt): {formatDateTime(b.completedAt)} {b.completedBy ? `· ${b.completedBy.fullName}` : ''}</span>
              <span>Tạo lúc: {formatDateTime(b.createdAt)}</span>
              <span>Phiên bản trích xuất: {b.parserVersion ?? '—'}</span>
            </div>
            {b.requestAudit ? <RequestAuditBlock audit={b.requestAudit} /> : null}
          </Disclosure>

          <div className="flex justify-end gap-2">
            {/*
              Only for a withdrawn order, and only because the SERVER said so —
              `canRedispatch` is derived from the same two conditions the endpoint
              enforces, so the control cannot offer something the write refuses.
            */}
            {b.canRedispatch ? (
              <RedispatchButton bookingId={b.id} guestName={b.customerName} onDone={setToast} />
            ) : null}
            <DeleteBookingButton bookingId={b.id} guestName={b.customerName} isAdmin={isAdmin} />
          </div>
        </>
      ) : (
        <>
          {pmsCard}
          {roomsCard}
          {warningsCard}
          <ProofSection booking={b} isAdmin={isAdmin} onChanged={handleProofChanged} />
        </>
      )}

      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

/**
 * A collapsed group of secondary cards: a one-line summary that opens to the
 * cards themselves. A native `<details>`, so it needs no state, keeps its own
 * open/closed memory while the panel is on screen, and is keyboard-operable.
 */
function Disclosure({
  title,
  hint,
  testId,
  children,
}: {
  title: string;
  hint: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-2xl border border-slate-200 bg-white" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3">
        <span>
          <span className="text-sm font-semibold text-slate-700">{title}</span>
          <span className="ml-2 text-xs text-slate-400">{hint}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-4 border-t border-slate-100 px-4 py-4">{children}</div>
    </details>
  );
}

/**
 * The real stay, as it happened.
 *
 * Hidden until the first operational event exists, so a booking that has only
 * been dispatched does not display a column of empty promises.
 */
function OperationalCard({ record }: { record: OperationalRecord }) {
  const rows = [
    { label: 'Đã nhận đơn', at: record.receivedAt, by: record.receivedBy },
    { label: 'Khách nhận phòng thực tế', at: record.actualCheckInAt, by: record.checkedInBy },
    { label: 'Khách trả phòng thực tế', at: record.actualCheckOutAt, by: record.checkedOutBy },
    { label: 'Đã huỷ', at: record.cancelledAt, by: record.cancelledBy },
  ].filter((r) => r.at !== null);
  if (rows.length === 0) return null;
  return (
    <Section id="operational" title="Diễn biến thực tế" count={rows.length} testId="operational-card">
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((r) => (
          <ReadField
            key={r.label}
            label={r.label}
            value={`${formatDateTime(r.at)}${r.by ? ` · ${r.by.fullName}` : ''}`}
          />
        ))}
      </div>
      {record.cancellationReason ? (
        <div className="mt-3">
          <ReadField label="Lý do huỷ" value={record.cancellationReason} />
        </div>
      ) : null}
    </Section>
  );
}

/**
 * Request provenance, inside the Admin card. Never rendered for a receptionist
 * — the server does not send it, so there is nothing to hide in the client.
 */
function RequestAuditBlock({ audit }: { audit: RequestAuditView }) {
  return (
    <div className="mt-3 border-t border-slate-100 pt-3" data-testid="request-audit">
      <div className="grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
        <span>Parser commit: <span className="font-mono text-xs">{audit.parserCommit ?? '—'}</span></span>
        <span>Build ID: <span className="font-mono text-xs">{audit.reviewBuildId ?? '—'}</span></span>
      </div>
      {audit.requests.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm font-medium text-brand-600">
            Nguồn yêu cầu ({audit.requests.length})
          </summary>
          <ul className="mt-2 space-y-2 text-xs text-slate-600">
            {audit.requests.map((r) => (
              <li key={r.id} className="rounded-lg bg-slate-50 p-2 font-mono" data-testid="request-audit-row">
                <div>Request: {r.id}</div>
                <div>Correlation: {r.correlationId ?? '—'}</div>
                <div>Route: {r.route ?? '—'}</div>
                <div>IP: {r.ipAddress ?? '—'}</div>
                <div className="break-all">UA: {r.userAgent ?? '—'}</div>
                <div>Session: {r.sessionId ?? '—'}</div>
                <div>{formatDateTime(r.occurredAt)}</div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * THE PMS NOTE. One card, one meaning, on every screen.
 *
 * There used to be two cards fighting over the same heading: the note, and a
 * line naming whoever created the reservation. The name is gone — what a
 * receptionist transfers into the hotel system is this text.
 *
 * WHERE THE TEXT COMES FROM, and why it differs by source:
 *
 *   Agoda / CTrip — the note is STORED. It was generated once, at dispatch,
 *   from the review the Admin approved, and it is shown back exactly as stored.
 *   It is never rebuilt here, and it could not be: its second line carries the
 *   price the GUEST booked at, which is not a column on the booking. A screen
 *   that re-derived this note would have to invent that number, and a
 *   receptionist pastes it into the PMS as fact.
 *
 *   Booking.com — no note is stored, and none ever was. Its note is generated
 *   from the booking's own fields by a builder that has been operational since
 *   before the OTA path existed. That is left exactly as it is.
 *
 * An OTA booking dispatched before the note was stored has neither, and says
 * so. It used to fall through to the Booking.com builder, which printed "PAY
 * BEFORE CHECK-IN" on an Agoda reservation — wording that source never uses.
 *
 * Rendered in a `pre` so uppercase, spacing and line breaks survive intact:
 * the note is a string contract with the hotel system, not prose.
 */
function PmsNoteCard({ booking, cut }: { booking: BookingDetail; cut?: CutController }) {
  const stored = booking.adminPmsNote?.trim();
  const generated = booking.sourcePlatform === 'BOOKING_COM' ? buildPmsNote(booking) : null;
  const text = stored && stored.length > 0 ? stored : generated?.ok ? generated.text ?? null : null;
  const error = text
    ? null
    : generated?.error ?? 'Đơn này được gửi trước khi hệ thống lưu ghi chú PMS.';

  const isCut = cut ? cut.isCut('PMS_NOTE') : false;

  return (
    <Card className="p-5" data-testid="pms-note-card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <StickyNote className="h-4 w-4 text-brand-600" aria-hidden="true" />
          PMS NOTE
        </div>
        {/*
          For reception this is CẮT: the note is the last thing they take, and
          leaving a copy button beside an already-taken note invites pasting it
          into the hotel system twice.

          FOR ADMIN IT IS STILL "Sao chép", unchanged — copied whole rather than
          retyped, because retyping is where a digit goes missing and every
          figure on this note is one a guest is charged for.
        */}
        {cut ? (
          isCut || !text ? null : (
            // `text` verbatim: the note is a string contract with the hotel
            // system, and its line breaks are part of it.
            <CutButton field="PMS_NOTE" value={text} controller={cut} />
          )
        ) : text ? (
          <CopyButton
            value={text}
            label="Sao chép PMS Note"
            text="Sao chép"
            className="border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100"
          />
        ) : null}
      </div>
      {isCut ? (
        <CutPlaceholder />
      ) : text ? (
        <pre
          data-testid="pms-note-text"
          className="whitespace-pre-wrap break-words rounded-xl bg-slate-50 px-3 py-3 font-mono text-sm text-slate-800"
        >
          {text}
        </pre>
      ) : (
        <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">{error}</p>
      )}
    </Card>
  );
}

function RoomCard({ room }: { room: RoomView }) {
  const nights = room.nights.length;
  return (
    <Card className="p-5">
      <div className="mb-3">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Phòng {room.roomIndex} · {nights} đêm
        </p>
        <p className="text-base font-semibold text-slate-900">{room.roomType ?? '(chưa rõ loại phòng)'}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium uppercase tracking-wide text-slate-400">
              <th className="py-1.5 pr-4">Đêm</th>
              <th className="py-1.5 pr-4">Giá</th>
              <th className="py-1.5 pr-4" />
            </tr>
          </thead>
          <tbody>
            {room.nights.map((n) => {
              const missing = n.amount === null;
              return (
                <tr key={n.id} className="border-t border-slate-100">
                  <td className="py-1.5 pr-4 text-slate-700">{formatDate(n.stayDate)}</td>
                  <td className="py-1.5 pr-4 text-slate-900">
                    {missing ? <span className="text-amber-600">Chưa xác định</span> : formatMoney(n.amount, n.currency)}
                    {n.manuallyCorrected ? <span className="ml-2 text-xs text-slate-400">(sửa tay)</span> : null}
                  </td>
                  <td className="py-1.5 pr-4">
                    <CopyButton
                      value={formatAmountCopy(n.amount)}
                      text="Sao chép giá"
                      label={`Sao chép giá đêm ${formatDate(n.stayDate)}`}
                      disabled={missing}
                      disabledReason="Chưa có giá để sao chép"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {room.roomSubtotal != null ? (
        <div className="mt-3 text-sm text-slate-600">
          Tạm tính: <strong className="text-slate-900">{formatMoney(room.roomSubtotal)}</strong>
        </div>
      ) : null}
    </Card>
  );
}
