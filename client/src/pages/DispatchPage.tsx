import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FilePlus2, Send, Sparkles } from 'lucide-react';
import { bookingsApi, branchesApi, BUSINESS_TYPE_LABEL, SOURCE_LABEL, type AgodaPartnerExtras, type BookingComDispatchPayload, type BookingSource, type BusinessType, type ExtractResponse, type ParserQuality, type WarningView } from '../api/bookings';
import { roomMappingApi } from '../api/roomMapping';
import { ApiError, toUserMessage } from '../api/errors';
import { branchLabel } from '../auth/types';
import { AgodaPartnerCard } from '../components/AgodaPartnerCard';
import { OtaReviewPanel } from '../components/OtaReviewPanel';
import { BookingComRoomReview, type ReviewRoomView } from '../components/BookingComRoomReview';
import { UNMAPPED_ROOM_MESSAGE, everyRoomHasPmsCode } from '../lib/bookingComRoomClass';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { ErrorAlert } from '../components/ErrorAlert';
import { PageHeader } from '../components/PageState';
import { formatMoney } from '../lib/format';

interface NightDraft {
  stayDate: string;
  amount: string;
}
/**
 * One room of the review.
 *
 * The room-class fields live HERE rather than in a separate server-owned
 * object: with no draft to hold them, the Admin's choice is part of the same
 * local state as everything else they are editing, and it travels to the server
 * once, in the dispatch payload.
 */
interface RoomDraft {
  roomIndex: number;
  roomType: string;
  roomSubtotal: number | null;
  roomClassId: string | null;
  roomClassPmsCode: string | null;
  roomClassDisplayName: string | null;
  roomClassStatus: 'RESOLVED' | 'MANUAL' | 'UNRESOLVED' | 'LEGACY' | null;
  nights: NightDraft[];
}
interface FormState {
  hotelName: string;
  customerName: string;
  phone: string;
  bookingCode: string;
  checkInDate: string;
  checkOutDate: string;
  totalAmount: string;
  paymentStatus: 'PAY_BEFORE' | 'PAY_AFTER';
  specialRequest: string;
  rooms: RoomDraft[];
}

function stayDatesBetween(checkIn: string, checkOut: string): string[] {
  if (!checkIn || !checkOut) return [];
  const start = new Date(`${checkIn}T00:00:00Z`).getTime();
  const end = new Date(`${checkOut}T00:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return [];
  const out: string[] = [];
  for (let t = start; t < end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** The extraction preview, as the editable review the Admin works on. */
function toForm(res: ExtractResponse): FormState {
  return {
    hotelName: res.booking.hotelName ?? '',
    customerName: res.booking.guestName ?? '',
    phone: res.booking.phone ?? '',
    bookingCode: res.booking.bookingCode ?? '',
    checkInDate: res.booking.checkIn ?? '',
    checkOutDate: res.booking.checkOut ?? '',
    totalAmount: res.booking.totalAmount != null ? String(res.booking.totalAmount) : '',
    paymentStatus: res.booking.paymentStatus,
    specialRequest: res.booking.specialRequest ?? '',
    rooms: res.rooms.map((r) => ({
      roomIndex: r.roomIndex,
      roomType: r.roomName ?? '',
      roomSubtotal: r.roomTotal,
      // No branch is chosen yet, so nothing can be resolved yet. These fill in
      // when the Admin picks a branch — see the resolve effect below.
      roomClassId: null,
      roomClassPmsCode: null,
      roomClassDisplayName: null,
      roomClassStatus: null,
      nights: r.nights.map((n) => ({
        stayDate: n.stayDate,
        amount: n.amount != null ? String(n.amount) : '',
      })),
    })),
  };
}

function parseAmount(s: string): number | null {
  const digits = s.replace(/[^\d]/g, '');
  return digits.length > 0 ? Number(digits) : null;
}

/**
 * The whole reviewed reservation, as one request.
 *
 * Replaces the old save-then-send pair. Nothing here was ever written to the
 * database: this IS the booking, assembled at the moment the Admin sends it.
 */
function buildDispatch(
  form: FormState,
  branchId: number,
  rawText: string,
  businessType: BusinessType | null,
  manuallyConfirmed: boolean,
  acknowledgedWarningCodes: string[],
): BookingComDispatchPayload {
  return {
    rawText,
    branchId,
    hotelName: form.hotelName || null,
    customerName: form.customerName,
    phone: form.phone || null,
    bookingCode: form.bookingCode,
    checkInDate: form.checkInDate || null,
    checkOutDate: form.checkOutDate || null,
    totalAmount: parseAmount(form.totalAmount),
    paymentStatus: form.paymentStatus,
    specialRequest: form.specialRequest || null,
    rooms: form.rooms.map((r) => ({
      roomIndex: r.roomIndex,
      roomType: r.roomType || null,
      roomSubtotal: r.nights.every((n) => parseAmount(n.amount) !== null)
        ? r.nights.reduce((acc, n) => acc + (parseAmount(n.amount) ?? 0), 0)
        : r.roomSubtotal,
      roomClassId: r.roomClassId,
      nights: r.nights.map((n) => ({ stayDate: n.stayDate, amount: parseAmount(n.amount) })),
    })),
    // Sent only when a human actually decided it; otherwise the server's own
    // detector runs, exactly as it does today.
    ...(manuallyConfirmed && (businessType === 'DIRECT' || businessType === 'PARTNER')
      ? { businessType }
      : {}),
    acknowledgedWarningCodes,
  };
}

const inputClass =
  'w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

/**
 * What to paste, per platform. CTrip's line is deliberately explicit about the
 * conservative extraction: it is better for a receptionist to expect to check a
 * few fields than to trust a value the engine could not actually read.
 */
const SOURCE_HELP: Record<BookingSource, string> = {
  BOOKING_COM: 'Dán từ trang chi tiết đặt phòng trong Extranet (bao gồm cả bảng giá từng đêm).',
  AGODA: 'Dán email đặt phòng của đối tác (YCS) hoặc trang xác nhận dành cho khách.',
  CTRIP:
    'Dán trang xác nhận đặt phòng CTrip / Trip.com. Một số trường có thể cần bạn kiểm tra và bổ sung thủ công — hệ thống sẽ báo rõ trường nào.',
};

/*
  PLATFORMS THAT ARE LISTED BUT NOT YET BUILT.

  Deliberately NOT `BookingSource` values. That enum is a database type written
  onto every booking, and adding a member would be a migration for two tabs that
  cannot yet produce a booking. They exist here only as tabs, they never reach
  the extractor, and nothing can be dispatched under them.
*/
const PLACEHOLDER_SOURCES = ['TRIPADVISOR', 'G2J', 'TRAVELOKA'] as const;
type PlaceholderSource = (typeof PLACEHOLDER_SOURCES)[number];
type SourceTab = BookingSource | PlaceholderSource;

const PLACEHOLDER_LABEL: Record<PlaceholderSource, string> = {
  TRIPADVISOR: 'Tripadvisor',
  G2J: 'G2J',
  TRAVELOKA: 'Traveloka',
};

/** The exact wording the operator asked for. */
export const COMING_SOON = 'Ứng dụng sẽ phát triển phần này sớm nhất';

function isPlaceholder(tab: SourceTab): tab is PlaceholderSource {
  return (PLACEHOLDER_SOURCES as readonly string[]).includes(tab);
}

function tabLabel(tab: SourceTab): string {
  return isPlaceholder(tab) ? PLACEHOLDER_LABEL[tab] : SOURCE_LABEL[tab];
}

export function DispatchPage() {
  const navigate = useNavigate();
  const [source, setSource] = useState<SourceTab>('BOOKING_COM');
  const [rawText, setRawText] = useState('');
  // Agoda and CTrip go through the server-authoritative review panel; the
  // Booking.com flow below is untouched.
  const [otaRawText, setOtaRawText] = useState<string | null>(null);
  /**
   * The Booking.com review, held ENTIRELY in the browser.
   *
   * `reviewing` replaces the old `draftId`: it says a review is open, not that a
   * record exists. Nothing has been written at this point, and nothing will be
   * until the Admin presses Gửi — so a refresh loses the review, which is the
   * accepted cost of not leaving a row behind for every abandoned paste.
   */
  const [reviewing, setReviewing] = useState(false);
  /** The pasted text, kept for the dispatch: the server re-parses it itself. */
  const [reviewRawText, setReviewRawText] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [branchId, setBranchId] = useState<number | undefined>(undefined);
  const [warnings, setWarnings] = useState<WarningView[]>([]);
  const [quality, setQuality] = useState<ParserQuality | null>(null);
  const [agoda, setAgoda] = useState<AgodaPartnerExtras | null>(null);
  const [branchConfidence, setBranchConfidence] = useState<number | null>(null);
  const [businessType, setBusinessType] = useState<BusinessType | null>(null);
  const [businessTypeConfidence, setBusinessTypeConfidence] = useState<number | null>(null);
  const [businessTypeManuallyConfirmed, setBusinessTypeManuallyConfirmed] = useState(false);
  const [pendingWarnings, setPendingWarnings] = useState<WarningView[] | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const branches = useQuery({ queryKey: ['branches'], queryFn: () => branchesApi.list(), staleTime: 5 * 60_000 });

  /** Clears the open review. Used by "Đơn khác" and by a fresh extraction. */
  const resetReview = () => {
    setReviewing(false);
    setReviewRawText('');
    setForm(null);
    setBranchId(undefined);
    setWarnings([]);
    setQuality(null);
    setAgoda(null);
    setBranchConfidence(null);
    setBusinessType(null);
    setBusinessTypeConfidence(null);
    setBusinessTypeManuallyConfirmed(false);
    setPendingWarnings(null);
    setSendError(null);
  };

  const extractMut = useMutation({
    mutationFn: (text: string) => {
      // Unreachable: a placeholder tab renders no textarea and no extract
      // button. Refusing here rather than coercing to another platform means a
      // future caller cannot quietly send Tripadvisor text to the Booking parser.
      if (isPlaceholder(source)) throw new Error(COMING_SOON);
      return bookingsApi.extract(text, source);
    },
    onSuccess: (res, text) => {
      // A new extraction REPLACES whatever was on screen. There is nothing to
      // clean up in the database, because the previous review was never there.
      setForm(toForm(res));
      setReviewRawText(text);
      setWarnings(res.warnings);
      setBranchId(res.branchConfident && res.suggestedBranch ? res.suggestedBranch.id : undefined);
      setQuality(res.parserQuality);
      setAgoda(res.agoda ?? null);
      setBranchConfidence(res.suggestedBranch ? res.branchConfidence : null);
      setBusinessType(res.businessType);
      setBusinessTypeConfidence(res.businessTypeConfidence);
      setBusinessTypeManuallyConfirmed(false);
      setPendingWarnings(null);
      setSendError(null);
      setReviewing(true);
    },
  });

  /**
   * The Admin's business-type decision, recorded locally.
   *
   * It used to PATCH the draft. There is no draft: the choice rides along in the
   * dispatch payload, where the server applies the same rule the old endpoint
   * did — manual wins, confidence 100, source `manual:<admin>`.
   */
  const confirmBusinessType = (type: 'DIRECT' | 'PARTNER') => {
    setBusinessType(type);
    setBusinessTypeConfidence(100);
    setBusinessTypeManuallyConfirmed(true);
  };

  /**
   * Pre-fills each room's internal code once a branch is known.
   *
   * This is the work the extract-time snapshot used to do. It could not stay
   * there: resolution is scoped to a branch, and the branch is chosen here. The
   * server answers from the branch's ACTIVE mapping and writes nothing.
   *
   * A code the ADMIN chose is never overwritten — the same rule the stored
   * snapshot followed. This only fills blanks.
   */
  const roomNamesKey = form?.rooms.map((r) => r.roomType).join(' ') ?? '';
  useEffect(() => {
    if (branchId === undefined || !form || form.rooms.length === 0) return;
    let cancelled = false;
    const names = form.rooms.map((r) => r.roomType || null);

    void roomMappingApi
      .resolve(branchId, names)
      .then((res) => {
        if (cancelled) return;
        setForm((f) => {
          if (!f) return f;
          return {
            ...f,
            rooms: f.rooms.map((room, i) => {
              if (room.roomClassStatus === 'MANUAL') return room;
              const r = res.rooms[i];
              if (!r || r.roomClassId === null) {
                return {
                  ...room,
                  roomClassId: null,
                  roomClassPmsCode: null,
                  roomClassDisplayName: null,
                  roomClassStatus: 'UNRESOLVED' as const,
                };
              }
              return {
                ...room,
                roomClassId: r.roomClassId,
                roomClassPmsCode: r.pmsCode,
                roomClassDisplayName: r.displayName,
                roomClassStatus: r.status,
              };
            }),
          };
        });
      })
      .catch(() => {
        // Never block the review on resolution: the Admin can still pick each
        // code by hand, and the dispatch refuses anything left unmapped.
      });

    return () => {
      cancelled = true;
    };
    /*
      Keyed on the branch and the room NAMES, not on `form`.

      `form` changes on every keystroke and this effect writes back into it, so
      depending on it would re-resolve on each character typed and never settle.
      The two things resolution actually depends on are exactly the two listed:
      which branch's mapping to ask, and which names to ask about.
    */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, roomNamesKey]);

  /** Records the Admin's explicit choice for one room. */
  const applyRoomClass = (
    roomIndex: number,
    roomClassId: string,
    pmsCode: string,
    displayName: string,
  ) =>
    setForm((f) =>
      f
        ? {
            ...f,
            rooms: f.rooms.map((r) =>
              r.roomIndex === roomIndex
                ? {
                    ...r,
                    roomClassId,
                    roomClassPmsCode: pmsCode,
                    roomClassDisplayName: displayName,
                    roomClassStatus: 'MANUAL' as const,
                  }
                : r,
            ),
          }
        : f,
    );

  const updateForm = (patch: Partial<FormState>) => setForm((f) => (f ? { ...f, ...patch } : f));

  // Regenerate each room's night rows when the stay range changes.
  const onDateChange = (field: 'checkInDate' | 'checkOutDate', value: string) => {
    setForm((f) => {
      if (!f) return f;
      const next = { ...f, [field]: value };
      const dates = stayDatesBetween(next.checkInDate, next.checkOutDate);
      if (dates.length > 0) {
        next.rooms = f.rooms.map((r) => {
          const byDate = new Map(r.nights.map((n) => [n.stayDate, n.amount]));
          return { ...r, nights: dates.map((d) => ({ stayDate: d, amount: byDate.get(d) ?? '' })) };
        });
      }
      return next;
    });
  };

  /**
   * Sends the review — the one and only write.
   *
   * On failure the review stays exactly as it is, so the Admin corrects the
   * problem and presses Gửi again rather than re-pasting the whole reservation.
   * Nothing partial was created to clean up first.
   */
  async function doSend(ackCodes: string[]) {
    if (!reviewing || branchId === undefined || !form) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await bookingsApi.dispatchBookingCom(
        buildDispatch(
          form,
          branchId,
          reviewRawText,
          businessType,
          businessTypeManuallyConfirmed,
          ackCodes,
        ),
      );
      navigate(`/app/booking/${res.booking.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WARNINGS_NOT_ACKNOWLEDGED') {
        const details = err.details as { warnings?: WarningView[] } | undefined;
        setPendingWarnings(details?.warnings ?? []);
      } else if (err instanceof ApiError && err.code === 'DUPLICATE_BOOKING') {
        const d = err.details as { existingBookingId?: string; existingStatus?: string } | undefined;
        setSendError(`Đơn trùng đã tồn tại (${d?.existingStatus ?? ''}). Không thể gửi lại.`);
      } else {
        setSendError(toUserMessage(err));
      }
    } finally {
      setSending(false);
    }
  }

  const selectedBranch = useMemo(
    () => branches.data?.branches.find((b) => b.id === branchId),
    [branches.data, branchId],
  );

  /**
   * The reservation as the PMS note reads it, built from the review alone.
   *
   * There is no stored booking to merge with any more, so everything here is
   * local except the branch — which comes from the branches list, because the
   * note's breakfast line is the BRANCH's configuration, not the booking's.
   */
  const notePreview = useMemo(() => {
    if (!form) return null;
    return {
      bookingCode: form.bookingCode || null,
      rooms: form.rooms.map<ReviewRoomView>((r) => ({
        roomIndex: r.roomIndex,
        roomType: r.roomType || null,
        roomClassId: r.roomClassId,
        roomClassPmsCode: r.roomClassPmsCode,
        roomClassDisplayName: r.roomClassDisplayName,
        roomClassStatus: r.roomClassStatus,
        nights: r.nights,
      })),
      checkInDate: form.checkInDate || null,
      checkOutDate: form.checkOutDate || null,
      totalAmount: parseAmount(form.totalAmount),
      paymentStatus: form.paymentStatus,
      branch: selectedBranch ?? null,
      specialRequest: form.specialRequest || null,
      phone: form.phone || null,
      businessType: businessType ?? undefined,
    };
  }, [form, selectedBranch, businessType]);

  const roomsMapped = form ? everyRoomHasPmsCode(form.rooms) : false;

  // --- Agoda / CTrip: server-authoritative review ---
  if (otaRawText !== null && (source === 'AGODA' || source === 'CTRIP')) {
    return (
      <div className="space-y-4">
        <PageHeader
          title={`Kiểm tra & gửi — ${SOURCE_LABEL[source]}`}
          description="Kiểm tra thông tin, gán hạng phòng, chọn hình thức thanh toán rồi sao chép ghi chú."
        />
        <OtaReviewPanel
          source={source}
          rawText={otaRawText}
          onBack={() => {
            setOtaRawText(null);
            setRawText('');
          }}
        />
      </div>
    );
  }

  // --- Stage 1: paste + extract ---
  if (!reviewing) {
    // The three platforms with a real intake parser, then the two that are
    // listed but not built. Selecting one of the latter says so plainly rather
    // than handing its text to an extractor written for a different format.
    const sources: SourceTab[] = ['BOOKING_COM', 'AGODA', 'CTRIP', ...PLACEHOLDER_SOURCES];
    return (
      <div>
        <PageHeader title="Nhập đơn" description="Chọn nguồn, dán nội dung đặt phòng để trích xuất thông tin." />
        <Card className="p-5">
          {/* Source tabs — horizontally scrollable so they never cramp on a tablet. */}
          <div
            className="mb-4 -mx-1 flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-1"
            role="tablist"
            aria-label="Nguồn đặt phòng"
          >
            {sources.map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={source === s}
                onClick={() => {
                  setSource(s);
                  setOtaRawText(null);
                  extractMut.reset();
                }}
                className={`flex-shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
                  source === s ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {tabLabel(s)}
              </button>
            ))}
          </div>

          {isPlaceholder(source) ? (
            /*
              No textarea and no extract button on purpose. An input that accepts
              text and then does nothing with it is worse than no input: the
              operator would reasonably believe the order had been taken.
            */
            <p
              data-testid="source-coming-soon"
              role="status"
              className="rounded-xl bg-amber-50 px-4 py-6 text-center text-sm font-medium text-amber-900 ring-1 ring-inset ring-amber-200"
            >
              {COMING_SOON}
            </p>
          ) : (
            <>
              {extractMut.isError ? (
                <div className="mb-3">
                  <ErrorAlert>{toUserMessage(extractMut.error)}</ErrorAlert>
                </div>
              ) : null}
              <label className="mb-1 block text-sm font-medium text-slate-600">Nội dung {SOURCE_LABEL[source]}</label>
              <textarea
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                rows={14}
                placeholder={`Dán toàn bộ nội dung (Ctrl+A, Ctrl+C) từ trang chi tiết đặt phòng ${SOURCE_LABEL[source]}…`}
                className={`${inputClass} font-mono`}
              />
              <p className="mt-1 text-xs text-slate-500">{SOURCE_HELP[source]}</p>
              <div className="mt-4">
                <Button
                  onClick={() => {
                    // Booking.com parses into an in-browser review; Agoda and
                    // CTrip go to their own server-authoritative panel.
                    if (source === 'BOOKING_COM') extractMut.mutate(rawText);
                    else setOtaRawText(rawText);
                  }}
                  disabled={rawText.trim().length === 0}
                  loading={extractMut.isPending}
                >
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  Trích xuất thông tin
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>
    );
  }

  // --- Stage 2: review / edit / send ---
  if (!form) {
    return <PageHeader title="Nhập đơn Booking.com" description="Đang tải thông tin đã trích xuất…" />;
  }

  // Every room must carry an internal code: the note a receptionist pastes is
  // generated from that snapshot, and a missing one silently falls back to the
  // legacy keyword abbreviation rather than the branch's real PMS code.
  const canSend =
    branchId !== undefined &&
    form.customerName.trim() !== '' &&
    form.bookingCode.trim() !== '' &&
    roomsMapped;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Kiểm tra & gửi"
        description="Chỉnh sửa thông tin đã trích xuất, chọn chi nhánh rồi gửi."
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              // Nothing to withdraw or delete: the review only ever existed here.
              resetReview();
              setRawText('');
            }}
          >
            <FilePlus2 className="h-4 w-4" aria-hidden="true" />
            Đơn khác
          </Button>
        }
      />

      {quality ? <DataQualityCard quality={quality} branchConfidence={branchConfidence} /> : null}

      {/* Agoda hotel-partner email: structured fields + the exact two-line note. */}
      {agoda ? <AgodaPartnerCard agoda={agoda} /> : null}

      {businessType ? (
        <BusinessTypeCard
          type={businessType}
          confidence={businessTypeConfidence}
          manuallyConfirmed={businessTypeManuallyConfirmed}
          onConfirm={confirmBusinessType}
          confirming={false}
        />
      ) : null}

      {warnings.length > 0 ? (
        <Card className="border-amber-200 bg-amber-50/50 p-4">
          <p className="mb-1 text-sm font-semibold text-amber-800">Cảnh báo trích xuất</p>
          <ul className="list-inside list-disc space-y-0.5 text-sm text-amber-700">
            {warnings.map((w, i) => (
              <li key={`${w.code}-${i}`}>{w.message}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Địa chỉ khách sạn">
            <input
              className={`${inputClass} bg-slate-50 text-slate-700`}
              value={selectedBranch ? selectedBranch.address : ''}
              placeholder="Chưa chọn chi nhánh"
              readOnly
              aria-readonly="true"
            />
          </Field>
          <Field label="Mã đặt phòng"><input className={inputClass} value={form.bookingCode} onChange={(e) => updateForm({ bookingCode: e.target.value })} /></Field>
          <Field label="Tên khách"><input className={inputClass} value={form.customerName} onChange={(e) => updateForm({ customerName: e.target.value })} /></Field>
          <Field label="Số điện thoại"><input className={inputClass} value={form.phone} onChange={(e) => updateForm({ phone: e.target.value })} /></Field>
          <Field label="Nhận phòng"><input type="date" className={inputClass} value={form.checkInDate} onChange={(e) => onDateChange('checkInDate', e.target.value)} /></Field>
          <Field label="Trả phòng"><input type="date" className={inputClass} value={form.checkOutDate} onChange={(e) => onDateChange('checkOutDate', e.target.value)} /></Field>
          <Field label="Tổng tiền (VND)"><input inputMode="numeric" className={inputClass} value={form.totalAmount} onChange={(e) => updateForm({ totalAmount: e.target.value })} /></Field>
          <Field label="Thanh toán">
            <select className={inputClass} value={form.paymentStatus} onChange={(e) => updateForm({ paymentStatus: e.target.value as FormState['paymentStatus'] })}>
              <option value="PAY_AFTER">PAY AFTER CHECK-IN</option>
              <option value="PAY_BEFORE">PAY BEFORE CHECK-IN</option>
            </select>
          </Field>
        </div>
        <div className="mt-4">
          <Field label="Ghi chú / Yêu cầu đặc biệt">
            <textarea className={inputClass} rows={2} value={form.specialRequest} onChange={(e) => updateForm({ specialRequest: e.target.value })} />
          </Field>
        </div>
      </Card>

      {/* Rooms */}
      {form.rooms.map((room, ri) => (
        <Card key={room.roomIndex} className="p-5">
          <div className="mb-3">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Phòng {room.roomIndex}</p>
            <input
              className={`${inputClass} mt-1`}
              value={room.roomType}
              placeholder="Loại phòng"
              onChange={(e) => {
                const rooms = [...form.rooms];
                rooms[ri] = { ...room, roomType: e.target.value };
                updateForm({ rooms });
              }}
            />
          </div>
          <div className="space-y-2">
            {room.nights.map((night, ni) => (
              <div key={night.stayDate} className="flex items-center gap-3">
                <span className="w-28 text-sm text-slate-500">{night.stayDate}</span>
                <input
                  inputMode="numeric"
                  className={`${inputClass} max-w-xs`}
                  value={night.amount}
                  placeholder="Giá đêm (để trống nếu chưa rõ)"
                  onChange={(e) => {
                    const rooms = [...form.rooms];
                    const nights = [...room.nights];
                    nights[ni] = { ...night, amount: e.target.value };
                    rooms[ri] = { ...room, nights };
                    updateForm({ rooms });
                  }}
                />
              </div>
            ))}
          </div>
        </Card>
      ))}

      {/*
        Room classes + the Booking.com PMS note. Placed after the room prices
        and before the branch/send card so the Admin reads the booking, then
        confirms what it maps to, then decides to send — the note is the last
        thing seen before dispatch, which is what it is for.
      */}
      {notePreview ? (
        <BookingComRoomReview
          booking={notePreview}
          // The branch currently chosen. There is no "saved" branch to lag
          // behind it any more, so the codes offered are always the ones the
          // order will actually be validated against.
          branchId={branchId}
          onRoomClassChanged={applyRoomClass}
        />
      ) : null}

      {/* Branch + send */}
      <Card className="p-5">
        <Field label="Chọn chi nhánh gửi đến">
          <select
            className={inputClass}
            value={branchId ?? ''}
            onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">— Chọn chi nhánh —</option>
            {/* Only ACTIVE branches: /api/branches never lists a disabled one. */}
            {branches.data?.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {branchLabel(b)}
              </option>
            ))}
          </select>
        </Field>

        {selectedBranch ? (
          <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
            Xem trước: gửi <strong>{form.customerName || 'khách'}</strong> ({form.bookingCode || 'chưa có mã'}) đến{' '}
            <strong>{selectedBranch.address}</strong>, tổng {formatMoney(parseAmount(form.totalAmount))}.
          </p>
        ) : null}

        {sendError ? (
          <div className="mt-3">
            <ErrorAlert>{sendError}</ErrorAlert>
          </div>
        ) : null}

        {/* Says WHY the button is disabled, rather than leaving it dead. */}
        {branchId !== undefined && !roomsMapped ? (
          <p className="mt-3 text-sm text-red-700" data-testid="dispatch-room-blocking">
            {UNMAPPED_ROOM_MESSAGE}
          </p>
        ) : null}

        {/*
          "Lưu thay đổi" is gone, and its absence is the feature. It saved an
          unsent review to the database — the DRAFT this whole change removes.
          Edits now live on this screen until Gửi writes the booking once.
        */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => doSend([])} disabled={!canSend} loading={sending}>
            <Send className="h-4 w-4" aria-hidden="true" />
            Gửi xuống chi nhánh
          </Button>
        </div>
      </Card>

      {/* Warning acknowledgement dialog */}
      {pendingWarnings ? (
        <Card className="border-amber-300 bg-amber-50 p-5">
          <p className="text-sm font-semibold text-amber-800">Cần xác nhận trước khi gửi</p>
          <ul className="mt-2 list-inside list-disc space-y-0.5 text-sm text-amber-700">
            {pendingWarnings.map((w, i) => (
              <li key={`${w.code}-${i}`}>{w.message}</li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            <Button variant="secondary" onClick={() => setPendingWarnings(null)}>
              Quay lại chỉnh sửa
            </Button>
            <Button
              loading={sending}
              onClick={() => {
                const codes = pendingWarnings.map((w) => w.code);
                setPendingWarnings(null);
                void doSend(codes);
              }}
            >
              Xác nhận & gửi
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}

const QUALITY_STYLES: Record<ParserQuality['level'], { dot: string; text: string }> = {
  HIGH: { dot: 'bg-green-500', text: 'text-green-700' },
  MEDIUM: { dot: 'bg-amber-500', text: 'text-amber-700' },
  LOW: { dot: 'bg-red-500', text: 'text-red-700' },
};

/**
 * A small, additive read-out of the extraction's operational completeness score
 * and (when a branch is suggested) the branch-match confidence. It never blocks
 * editing or hides backend warnings — the warning-acknowledgement flow stays
 * authoritative; this only tells the admin how much to double-check.
 */
function DataQualityCard({
  quality,
  branchConfidence,
}: {
  quality: ParserQuality;
  branchConfidence: number | null;
}) {
  const style = QUALITY_STYLES[quality.level];
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <p className={`inline-flex items-center gap-2 text-sm font-semibold ${style.text}`}>
          <span className={`h-2.5 w-2.5 rounded-full ${style.dot}`} aria-hidden="true" />
          <span>
            Độ hoàn thiện dữ liệu: <span role="status">{quality.score}%</span>
          </span>
        </p>
        {branchConfidence !== null ? (
          <p className="text-sm text-slate-600">
            Độ tin cậy chi nhánh: <span className="font-semibold text-slate-900">{branchConfidence}%</span>
          </p>
        ) : null}
      </div>
      {quality.requiresAdminReview ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800"
        >
          Admin cần kiểm tra lại booking này trước khi gửi.
        </p>
      ) : null}
    </Card>
  );
}

const BUSINESS_TYPE_META: Record<BusinessType, { emoji: string; text: string }> = {
  DIRECT: { emoji: '🟢', text: 'text-green-700' },
  PARTNER: { emoji: '🟠', text: 'text-amber-700' },
  UNKNOWN: { emoji: '⚪', text: 'text-slate-600' },
};

/**
 * Business-type read-out on the review form. Shows the detected type + confidence,
 * a confirmation prompt when UNKNOWN, and two actions to mark the booking as a
 * normal ("Đơn thường") or partner ("Đơn đối tác") order. A manual choice is
 * persisted and overrides detection; the Admin can also override a confident
 * result.
 */
function BusinessTypeCard({
  type,
  confidence,
  manuallyConfirmed,
  onConfirm,
  confirming,
}: {
  type: BusinessType;
  confidence: number | null;
  manuallyConfirmed: boolean;
  onConfirm: (t: 'DIRECT' | 'PARTNER') => void;
  confirming: boolean;
}) {
  const meta = BUSINESS_TYPE_META[type];
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <p className={`text-sm font-semibold ${meta.text}`}>
          Loại đơn:{' '}
          <span role="status">
            {meta.emoji} {BUSINESS_TYPE_LABEL[type]}
          </span>
        </p>
        {type !== 'UNKNOWN' && confidence != null ? (
          <p className="text-sm text-slate-600">
            Độ tin cậy loại đơn: <span className="font-semibold text-slate-900">{confidence}%</span>
          </p>
        ) : null}
        {manuallyConfirmed ? <span className="text-xs text-slate-500">Admin đã xác nhận</span> : null}
      </div>

      {type === 'UNKNOWN' ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700"
        >
          Không thể tự xác định loại đơn. Admin vui lòng xác nhận.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => onConfirm('DIRECT')} loading={confirming} disabled={confirming}>
          Đánh dấu là Đơn thường
        </Button>
        <Button variant="secondary" onClick={() => onConfirm('PARTNER')} loading={confirming} disabled={confirming}>
          Đánh dấu là Đơn đối tác
        </Button>
      </div>
    </Card>
  );
}
