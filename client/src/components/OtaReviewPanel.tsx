/**
 * The Admin review screen for an Agoda or CTrip reservation.
 *
 * Every value shown here — including the note and whether dispatch is allowed —
 * comes from the server. The Admin edits, the panel sends the corrections back,
 * and the server re-resolves and re-validates. Nothing is decided locally: a PMS
 * code is only offered if the server said it is valid for the selected branch,
 * and the note is only ever the one the server generated.
 *
 * That round trip is the point. The note is pasted straight into the hotel PMS,
 * so a preview computed from a second, client-side implementation could drift
 * from what would actually be dispatched.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Copy, Plus, Send, Trash2 } from 'lucide-react';
import {
  OTA_PAYMENT_LABEL,
  OTA_SOURCE_LABEL,
  otaReviewApi,
  type OtaPaymentMode,
  type OtaReviewOverrides,
  type OtaReviewResponse,
  type OtaReviewRoomLine,
  type OtaReviewSource,
} from '../api/otaReview';
import { toUserMessage } from '../api/errors';
import { Card } from './Card';
import { Button } from './Button';
import { ErrorAlert } from './ErrorAlert';
import { copyText } from '../lib/copy';

const inputClass =
  'w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

/** Whole VND from a typed value; empty stays null rather than becoming 0. */
function parseAmount(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '');
  return digits.length > 0 ? Number(digits) : null;
}

function formatAmount(value: number | null): string {
  return value == null ? '' : String(value);
}

export interface OtaReviewPanelProps {
  source: OtaReviewSource;
  rawText: string;
  /** Called when the Admin dispatches a review the server marked valid. */
  onDispatch?: (branchId: number, note: string) => void;
  onBack?: () => void;
}

export function OtaReviewPanel({ source, rawText, onDispatch, onBack }: OtaReviewPanelProps) {
  const [overrides, setOverrides] = useState<OtaReviewOverrides>({});
  const [data, setData] = useState<OtaReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');
  /** idle → sending → sent, or duplicate when the booking already existed. */
  const [dispatchState, setDispatchState] = useState<'idle' | 'sending' | 'sent' | 'duplicate'>(
    'idle',
  );
  /**
   * Local text being typed, per field.
   *
   * Free-text inputs are NOT driven straight from the server response: every
   * keystroke would round-trip, and the response arriving mid-word would
   * overwrite what the Admin was still typing. The draft holds the in-progress
   * value and is pushed on blur; selects, dates and checkboxes are single
   * interactions and patch immediately.
   */
  const [draft, setDraft] = useState<Record<string, string>>({});

  /**
   * Re-asks the server after every correction. The Admin's overrides are sent
   * verbatim, so a manual value is never lost to a re-parse of the raw text.
   */
  const refresh = useCallback(
    async (next: OtaReviewOverrides) => {
      setLoading(true);
      setError(null);
      try {
        setData(await otaReviewApi.review(source, rawText, next));
      } catch (err) {
        setError(toUserMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [source, rawText],
  );

  useEffect(() => {
    void refresh({});
    // Deliberately keyed on the pasted text and source only: an override change
    // triggers its own refresh through `patch`.
  }, [refresh]);

  /** The value to display: what is being typed, else what the server returned. */
  const shown = (key: string, serverValue: string): string =>
    draft[key] !== undefined ? draft[key]! : serverValue;

  const setDraftValue = (key: string, value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const patch = (change: Partial<OtaReviewOverrides>) => {
    const next = { ...overrides, ...change };
    setOverrides(next);
    void refresh(next);
  };

  /** Commits a typed field and clears its draft so the server value resumes. */
  const commit = (key: string, change: Partial<OtaReviewOverrides>) => {
    setDraft((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
    patch(change);
  };

  const review = data?.review;
  const validCodes = data?.validPmsCodes ?? [];

  /**
   * The note as edited on screen. `null` means "whatever the server generated".
   *
   * Reset whenever the server regenerates the note, so a correction to the
   * branch, the rooms or the payment mode is never hidden behind a stale hand
   * edit. The Admin's own edit survives until one of those actually changes it.
   */
  const [noteEdit, setNoteEdit] = useState<string | null>(null);
  const serverNote = review?.note ?? null;
  useEffect(() => {
    setNoteEdit(null);
  }, [serverNote]);
  const noteText = noteEdit ?? serverNote ?? '';
  /** The rooms currently on screen — the Admin's if edited, else the server's. */
  const rooms: OtaReviewRoomLine[] = overrides.rooms ?? review?.rooms ?? [];

  /**
   * Internal codes split by whether THIS OTA source already maps to them.
   *
   * `knownOtaRoomNames` is the branch's mapping table for this platform alone,
   * so the codes in it are the ones an Agoda / Booking.com / CTrip reservation
   * actually resolves to — those are offered first, under the source's name.
   *
   * The branch's remaining active codes stay listed below rather than being
   * filtered away. This selector exists precisely for the case where automatic
   * mapping FAILED, and a room class with no mapping yet is the likeliest thing
   * an Admin needs to pick; hiding it would leave the booking undispatchable
   * with no way forward on this screen.
   */
  const sourceCodes = Array.from(
    new Set((data?.knownOtaRoomNames ?? []).map((m) => m.pmsCode)),
  ).filter((code) => validCodes.includes(code));
  const otherCodes = validCodes.filter((code) => !sourceCodes.includes(code));

  const patchRooms = (next: OtaReviewRoomLine[]) => patch({ rooms: next });

  /**
   * Sends the reviewed reservation to its branch.
   *
   * The server re-derives the review and refuses anything it would have
   * blocked, so this reports what actually happened rather than assuming
   * success. A reservation that was already dispatched comes back as such
   * instead of creating a second booking, and that is said plainly — an Admin
   * who clicks twice should learn that, not see two "sent" messages.
   */
  const sendToBranch = async () => {
    if (!review?.canDispatch || dispatchState === 'sending') return;
    setDispatchState('sending');
    setError(null);
    try {
      const result = await otaReviewApi.dispatch(source, rawText, overrides);
      setDispatchState(result.created ? 'sent' : 'duplicate');
      if (result.review.branchId !== null && result.review.note !== null) {
        onDispatch?.(result.review.branchId, result.review.note);
      }
    } catch (err) {
      setDispatchState('idle');
      setError(toUserMessage(err));
    }
  };

  /** Copies what is ON SCREEN, so a hand-edited note copies as edited. */
  const onCopy = async () => {
    if (!noteText.trim()) return;
    const ok = await copyText(noteText);
    setCopyState(ok ? 'ok' : 'fail');
    window.setTimeout(() => setCopyState('idle'), 2500);
  };

  /*
    ALREADY DISPATCHED → say so, and stop.

    Re-sending returns the existing booking untouched, so there is still no
    path from here to a second dispatch. What changed in 5.2 is that the pilot
    does not use the field-by-field comparison: the hotel reconciles amendments
    in its own PMS, and a reviewer faced with a diff they are not expected to
    act on will either guess or ignore it. The status is stated plainly instead.

    The amendment API and its pipeline are untouched and still fully tested —
    only this screen stopped calling them.
  */
  if (data?.existingBookingId) {
    return (
      <Card className="p-5" data-testid="amendment-already-dispatched">
        <p className="text-sm font-medium text-slate-800">Đơn này đã được gửi cho chi nhánh.</p>
        {onBack ? (
          <div className="mt-3">
            <Button variant="secondary" onClick={onBack}>Quay lại</Button>
          </div>
        ) : null}
      </Card>
    );
  }

  if (!review) {
    return (
      <Card className="p-5">
        {error ? <ErrorAlert>{error}</ErrorAlert> : <p className="text-sm text-slate-500">Đang phân tích…</p>}
        {onBack ? (
          <div className="mt-3">
            <Button variant="secondary" onClick={onBack}>Quay lại</Button>
          </div>
        ) : null}
      </Card>
    );
  }

  return (
    <div className="space-y-4" data-testid="ota-review">
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}

      {/* 1. Source + 3. Branch ------------------------------------------- */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-700">
            Nguồn: <span className="text-brand-700">{OTA_SOURCE_LABEL[review.source]}</span>
          </p>
          {loading ? <span className="text-xs text-slate-400">Đang cập nhật…</span> : null}
        </div>

        <label className="mt-3 block text-sm font-medium text-slate-600">
          Chi nhánh
          <select
            aria-label="Chi nhánh"
            className={`${inputClass} mt-1`}
            value={review.branchId ?? ''}
            onChange={(e) => patch({ branchId: e.target.value ? Number(e.target.value) : null, rooms: undefined })}
          >
            <option value="">— Chưa chọn chi nhánh —</option>
            {(data?.branchOptions ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                Chi nhánh {b.branchNumber} — {b.address}
              </option>
            ))}
          </select>
        </label>
        {review.requiresManualBranch ? (
          <p className="mt-1 text-xs text-red-700">
            Không nhận diện được chi nhánh từ tên khách sạn. Vui lòng chọn thủ công.
          </p>
        ) : null}
      </Card>

      {/* 4–8. Core fields ------------------------------------------------- */}
      <Card className="p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-600">
            Mã đặt phòng
            <input
              aria-label="Mã đặt phòng"
              className={`${inputClass} mt-1`}
              value={shown('bookingCode', review.bookingCode ?? '')}
              onChange={(e) => setDraftValue('bookingCode', e.target.value)}
              onBlur={(e) => commit('bookingCode', { bookingCode: e.target.value })}
            />
          </label>
          <label className="block text-sm font-medium text-slate-600">
            Tên khách
            <input
              aria-label="Tên khách"
              className={`${inputClass} mt-1`}
              value={shown('guestName', review.guestName ?? '')}
              onChange={(e) => setDraftValue('guestName', e.target.value)}
              onBlur={(e) => commit('guestName', { guestName: e.target.value })}
            />
          </label>
          <label className="block text-sm font-medium text-slate-600">
            Nhận phòng
            <input
              type="date"
              aria-label="Nhận phòng"
              className={`${inputClass} mt-1`}
              value={review.checkIn ?? ''}
              onChange={(e) => patch({ checkIn: e.target.value || null })}
            />
          </label>
          <label className="block text-sm font-medium text-slate-600">
            Trả phòng
            <input
              type="date"
              aria-label="Trả phòng"
              className={`${inputClass} mt-1`}
              value={review.checkOut ?? ''}
              onChange={(e) => patch({ checkOut: e.target.value || null })}
            />
          </label>
        </div>
        <p className="mt-2 text-sm text-slate-600">
          Số đêm: <strong data-testid="ota-nights">{review.nights ?? '—'}</strong>
        </p>
      </Card>

      {/* 9. Room lines ---------------------------------------------------- */}
      <Card className="p-5">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Hạng phòng</p>
          <Button
            variant="secondary"
            onClick={() =>
              patchRooms([
                ...rooms,
                {
                  quantity: 1,
                  otaRoomName: '',
                  otaRoomTypeId: null,
                  pmsCode: null,
                  requiresManualMapping: true,
                },
              ])
            }
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Thêm loại phòng
          </Button>
        </div>

        <ul className="space-y-2" aria-label="Danh sách hạng phòng">
          {rooms.map((room, index) => (
            <li key={index} className="rounded-xl border border-slate-200 p-3">
              <div className="grid gap-2 sm:grid-cols-[6rem_1fr_10rem_auto] sm:items-end">
                <label className="block text-xs font-medium text-slate-500">
                  Số lượng
                  <input
                    type="number"
                    min={1}
                    aria-label={`Số lượng phòng dòng ${index + 1}`}
                    className={`${inputClass} mt-1`}
                    value={shown(`room-${index}-qty`, String(room.quantity))}
                    onChange={(e) => setDraftValue(`room-${index}-qty`, e.target.value)}
                    onBlur={(e) => {
                      const next = [...rooms];
                      next[index] = { ...room, quantity: Number(e.target.value) || 0 };
                      commit(`room-${index}-qty`, { rooms: next });
                    }}
                  />
                </label>

                {/*
                  THE OTA'S OWN ROOM NAME, exactly as the platform printed it —
                  "Deluxe Queen Room With City View", not the internal code it
                  resolves to. The internal code is chosen in the select beside
                  this field and never replaces the name here.

                  `rawOtaRoomName` is the untouched original; `otaRoomName` is
                  the normalised key the branch mappings are looked up by (Agoda
                  strips a trailing style marker such as "(2)"). The Admin reads
                  the original, and a blur that changed nothing commits nothing
                  — so merely tabbing through the field cannot quietly swap the
                  mapping key for the display name.
                */}
                <label className="block text-xs font-medium text-slate-500">
                  Tên hạng phòng trên {OTA_SOURCE_LABEL[review.source]}
                  <input
                    aria-label={`Tên hạng phòng dòng ${index + 1}`}
                    className={`${inputClass} mt-1`}
                    value={shown(
                      `room-${index}-name`,
                      room.rawOtaRoomName ?? room.otaRoomName ?? '',
                    )}
                    onChange={(e) => setDraftValue(`room-${index}-name`, e.target.value)}
                    onBlur={(e) => {
                      const original = room.rawOtaRoomName ?? room.otaRoomName ?? '';
                      if (e.target.value === original) {
                        // Untouched: drop the draft, leave the review alone.
                        setDraft((d) => {
                          const next = { ...d };
                          delete next[`room-${index}-name`];
                          return next;
                        });
                        return;
                      }
                      const next = [...rooms];
                      // Clearing the manual code lets the server re-resolve.
                      next[index] = {
                        ...room,
                        otaRoomName: e.target.value,
                        rawOtaRoomName: e.target.value,
                        pmsCode: null,
                      };
                      commit(`room-${index}-name`, { rooms: next });
                    }}
                  />
                  {room.otaRoomTypeId ? (
                    <span className="mt-0.5 block text-xs text-slate-400">ID: {room.otaRoomTypeId}</span>
                  ) : null}
                </label>

                <label className="block text-xs font-medium text-slate-500">
                  Mã nội bộ
                  <select
                    aria-label={`Mã nội bộ dòng ${index + 1}`}
                    className={`${inputClass} mt-1`}
                    value={room.pmsCode ?? ''}
                    onChange={(e) => {
                      const next = [...rooms];
                      next[index] = {
                        ...room,
                        pmsCode: e.target.value || null,
                        requiresManualMapping: !e.target.value,
                      };
                      patchRooms(next);
                    }}
                  >
                    <option value="">— Chưa gán —</option>
                    {/*
                      Only codes the server said are valid for this branch, with
                      the ones this OTA source already maps to offered first.
                    */}
                    {sourceCodes.length > 0 ? (
                      <>
                        <optgroup label={`Mã dùng cho ${OTA_SOURCE_LABEL[review.source]}`}>
                          {sourceCodes.map((code) => (
                            <option key={code} value={code}>{code}</option>
                          ))}
                        </optgroup>
                        {otherCodes.length > 0 ? (
                          <optgroup label="Mã khác của chi nhánh">
                            {otherCodes.map((code) => (
                              <option key={code} value={code}>{code}</option>
                            ))}
                          </optgroup>
                        ) : null}
                      </>
                    ) : (
                      validCodes.map((code) => (
                        <option key={code} value={code}>{code}</option>
                      ))
                    )}
                  </select>
                </label>

                <Button
                  variant="danger"
                  onClick={() => patchRooms(rooms.filter((_, i) => i !== index))}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Xoá
                </Button>
              </div>

              {room.requiresManualMapping ? (
                <p className="mt-2 flex items-center gap-1 text-xs text-red-700">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  Chưa gán mã hạng phòng nội bộ cho chi nhánh này.
                </p>
              ) : null}
            </li>
          ))}
          {rooms.length === 0 ? (
            <li className="py-3 text-center text-sm text-slate-400">Chưa có dòng phòng nào.</li>
          ) : null}
        </ul>
      </Card>

      {/* 10–14. Prices, breakfast, payment -------------------------------- */}
      <Card className="p-5">
        {/*
          CTrip calls the branch's figure "Công nợ" and no longer shows a
          guest-booked price at all: its note prints the creation date where
          that price used to sit, so the field had nothing left to feed. The
          server matches — it stops requiring the figure for a CTrip note.

          Agoda is unchanged. Its CN note still prints GIÁ KHÁCH ĐẶT, so the
          field stays and is still required there.
        */}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-600">
            {review.source === 'AGODA' ? 'Giá chi nhánh (Net rate)' : 'Công nợ'}
            <input
              aria-label={review.source === 'AGODA' ? 'Giá chi nhánh' : 'Công nợ'}
              className={`${inputClass} mt-1`}
              value={shown('branchPrice', formatAmount(review.branchPrice))}
              onChange={(e) => setDraftValue('branchPrice', e.target.value)}
              onBlur={(e) => commit('branchPrice', { branchPrice: parseAmount(e.target.value) })}
            />
          </label>
          {review.source === 'AGODA' ? (
            <label className="block text-sm font-medium text-slate-600">
              Giá khách đặt (Reference sell rate)
              <input
                aria-label="Giá khách đặt"
                className={`${inputClass} mt-1`}
                value={shown('guestBookedPrice', formatAmount(review.guestBookedPrice))}
                onChange={(e) => setDraftValue('guestBookedPrice', e.target.value)}
                onBlur={(e) => commit('guestBookedPrice', { guestBookedPrice: parseAmount(e.target.value) })}
              />
            </label>
          ) : null}
        </div>

        {/* 10. Nightly prices — shown only when the platform stated them. */}
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Giá từng đêm</p>
          {review.nightlyRates.length === 0 ? (
            <p className="mt-1 text-xs text-slate-500" data-testid="ota-no-nightly">
              Nền tảng không cung cấp giá từng đêm. Hệ thống không tự chia tổng tiền.
            </p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-sm text-slate-700">
              {review.nightlyRates.map((n) => (
                <li key={n.stayDate}>
                  {n.stayDate}: {n.amount == null ? 'Chưa xác định' : n.amount.toLocaleString('vi-VN')}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-4">
          {/*
            Breakfast is a configured business rule for these eight branches on
            Agoda and CTrip — never included — so this is shown as a fixed fact
            rather than a choice. It stays visible because the note's wording
            depends on it and an Admin needs to see what will be generated; it
            is disabled because there is nothing here to decide. The server
            enforces the same rule, so a request that sets it is normalised
            rather than believed.
          */}
          <label className="flex items-center gap-2 text-sm text-slate-500">
            <input
              type="checkbox"
              aria-label="Ăn sáng"
              checked={false}
              disabled
              readOnly
              className="h-4 w-4 rounded border-slate-300 text-slate-400"
            />
            Không ăn sáng
          </label>

          <label className="block text-sm font-medium text-slate-600">
            Hình thức thanh toán
            <select
              aria-label="Hình thức thanh toán"
              className={`${inputClass} mt-1`}
              value={review.paymentMode}
              onChange={(e) => patch({ paymentMode: e.target.value as OtaPaymentMode })}
            >
              {/* Exactly two options, worded as the operator words them. */}
              <option value="CN">{OTA_PAYMENT_LABEL.CN}</option>
              <option value="HOTEL_PAYMENT">{OTA_PAYMENT_LABEL.HOTEL_PAYMENT}</option>
            </select>
          </label>

        </div>
      </Card>

      {/*
        15. THE NOTE — and the row above ends at payment.

        A textarea sat here asking who created the reservation in the PMS. It is
        gone: the branch needs the NOTE, and the note is right below. Asking for
        a name as well put two different things under one heading, and the name
        was never what a receptionist did anything with.
      */}
      <Card className="p-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-700">Ghi chú PMS</p>
          <div className="flex items-center gap-2">
            {copyState === 'ok' ? <span className="text-xs text-green-700">Đã sao chép.</span> : null}
            {copyState === 'fail' ? (
              <span className="text-xs text-red-700">Không sao chép được. Vui lòng chọn và sao chép thủ công.</span>
            ) : null}
            <Button variant="secondary" onClick={onCopy} disabled={!noteText.trim()}>
              <Copy className="h-4 w-4" aria-hidden="true" />
              Sao chép note
            </Button>
          </div>
        </div>

        {/*
          EDITABLE. It was a read-only dark block, which is why nobody could fix
          a wording the generator got slightly wrong without going back to the
          fields. It is now an ordinary light textarea in the app's own input
          style: no readOnly, no disabled, monospaced so the string contract
          stays legible.
        */}
        {serverNote !== null ? (
          <>
            <textarea
              data-testid="ota-note"
              aria-label="Ghi chú PMS"
              rows={3}
              value={noteText}
              onChange={(e) => setNoteEdit(e.target.value)}
              className={`${inputClass} whitespace-pre-wrap font-mono`}
            />
            {/*
              The dispatched note is regenerated by the server from the fields
              above — a hand edit is for copying, not for sending. Saying so is
              the difference between a useful scratch pad and an Admin who
              believes the branch received text it never got.
            */}
            {noteEdit !== null && noteEdit !== serverNote ? (
              <p className="mt-1 text-xs text-amber-700" data-testid="ota-note-edited">
                Đã sửa tay. Bản sửa dùng để sao chép; đơn gửi chi nhánh vẫn dùng ghi chú hệ thống tạo.
              </p>
            ) : null}
          </>
        ) : (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {review.noteError ?? 'Chưa đủ dữ liệu để tạo ghi chú.'}
          </p>
        )}
      </Card>

      {/* 16. Warnings and blocking reasons -------------------------------- */}
      {review.blockingReasons.length > 0 ? (
        <Card className="border-red-200 bg-red-50/50 p-4">
          <p className="mb-1 text-sm font-semibold text-red-800">Chưa thể gửi đơn</p>
          <ul className="list-inside list-disc space-y-0.5 text-sm text-red-700" data-testid="ota-blocking">
            {review.blockingReasons.map((reason, i) => (
              <li key={`${reason}-${i}`}>{reason}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {review.warnings.length > 0 ? (
        <Card className="border-amber-200 bg-amber-50/50 p-4">
          <ul className="list-inside list-disc space-y-0.5 text-sm text-amber-800" data-testid="ota-warnings">
            {review.warnings.map((w, i) => (
              <li key={`${w.code}-${i}`}>{w.message}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {dispatchState === 'sent' || dispatchState === 'duplicate' ? (
        <Card>
          <p
            data-testid="ota-dispatch-result"
            className={dispatchState === 'sent' ? 'text-sm text-emerald-700' : 'text-sm text-amber-700'}
          >
            {dispatchState === 'sent'
              ? 'Đã gửi chi nhánh. Đơn đã được lưu và lễ tân sẽ nhận được thông báo.'
              : 'Đơn này đã được gửi trước đó. Hệ thống giữ nguyên đơn cũ, không tạo đơn trùng.'}
          </p>
        </Card>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {onBack ? (
          <Button variant="secondary" onClick={onBack}>Đơn khác</Button>
        ) : null}
        {/*
          The panel dispatches for itself: it already holds the source, the
          pasted text and the Admin's corrections, which is exactly what the
          endpoint needs. `onDispatch` is a SUCCESS notification for the page,
          not the mechanism — an optional callback was the mechanism once, and
          because no page supplied one the button silently did nothing.
        */}
        <Button
          onClick={() => void sendToBranch()}
          disabled={!review.canDispatch || dispatchState === 'sending'}
          loading={dispatchState === 'sending'}
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          Gửi chi nhánh
        </Button>
      </div>
    </div>
  );
}
