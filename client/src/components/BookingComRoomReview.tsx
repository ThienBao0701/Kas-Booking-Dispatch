/**
 * The Admin's room-class and PMS-note review for a BOOKING.COM reservation.
 *
 * Two things the Booking.com flow had no surface for, and both are about the
 * same fact: the note a receptionist pastes is generated from the booking's
 * stored room-class snapshot, and until now nobody could see that snapshot or
 * correct it before the booking left.
 *
 * WHAT IS AND IS NOT REIMPLEMENTED HERE:
 *
 *   The dropdown lists the branch's OWN active room classes, read from the
 *   existing room-mapping API. There is no second catalogue in the frontend.
 *
 *   The note is produced by `buildPmsNote`, the SAME Booking.com builder
 *   reception uses. There is no second generator and no Agoda-style format
 *   anywhere near this file: an Agoda note is a different layout produced on
 *   the server, and a Booking.com booking must never print one.
 *
 * ── CONTROLLED, NOT SELF-PERSISTING ───────────────────────────────────────
 * This used to POST each selection against a persisted DRAFT and adopt whatever
 * the server echoed back. There is no draft any more: the reservation is created
 * once, at Send. So the component now takes its rooms as props and reports a
 * change to the parent, which owns the review state.
 *
 * That does NOT make the browser the authority on which class is valid. The
 * options offered are the branch's own ACTIVE mapping, served by the server, and
 * the choice is re-resolved against that same mapping when the order is
 * dispatched — a class that does not belong to the branch is refused there, not
 * quietly stored. What moved is WHEN the choice is written, not WHO decides it.
 *
 * The OTA room name is displayed exactly as Booking.com stated it and is never
 * replaced by the internal code — they are different fields answering different
 * questions ("what did the platform sell?" vs "what is it called in our PMS?").
 */
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Copy, StickyNote } from 'lucide-react';
import { roomMappingApi } from '../api/roomMapping';
import { toUserMessage } from '../api/errors';
import { UNMAPPED_ROOM_MESSAGE, everyRoomHasPmsCode } from '../lib/bookingComRoomClass';
import { buildPmsNote, type PmsNoteInput } from '../lib/pmsNote';
import { copyText } from '../lib/copy';
import { Card } from './Card';
import { Button } from './Button';
import { ErrorAlert } from './ErrorAlert';
import { useState } from 'react';

const inputClass =
  'w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600';

/** One room of the review, as this card needs to read and update it. */
export interface ReviewRoomView {
  roomIndex: number;
  /** The name Booking.com printed, verbatim. */
  roomType: string | null;
  roomClassId?: string | null;
  roomClassPmsCode?: string | null;
  roomClassDisplayName?: string | null;
  roomClassStatus?: 'RESOLVED' | 'MANUAL' | 'UNRESOLVED' | 'LEGACY' | null;
  nights: readonly unknown[];
}

export interface BookingComRoomReviewProps {
  /**
   * The reservation as the review currently stands — stored or not.
   *
   * `Omit` rather than an intersection: the rooms here are the richer review
   * rows, and intersecting the two room shapes would leave the narrower one
   * winning at every property access.
   */
  booking: Omit<PmsNoteInput, 'rooms'> & { rooms: readonly ReviewRoomView[] };
  /** The branch whose internal codes are being offered. */
  branchId: number | undefined;
  /**
   * The picker is disabled while this is true.
   *
   * It exists for the legacy stored-booking caller, where the codes belong to
   * the branch the booking was SAVED against and offering a newly picked
   * branch's codes would produce a refusal the Admin could not explain. An
   * in-memory review has no saved branch to diverge from, so it never sets it.
   */
  branchDirty?: boolean;
  /** Reports the Admin's choice to whoever owns the review state. */
  onRoomClassChanged: (roomIndex: number, roomClassId: string, pmsCode: string, displayName: string) => void;
}

export function BookingComRoomReview({
  booking,
  branchId,
  branchDirty = false,
  onRoomClassChanged,
}: BookingComRoomReviewProps) {
  /**
   * The branch's active room classes — the existing source of truth, keyed by
   * branch so switching branch re-fetches rather than reusing the old list.
   */
  const mapping = useQuery({
    queryKey: ['room-mapping', branchId],
    queryFn: () => roomMappingApi.get(branchId!),
    enabled: branchId !== undefined,
    staleTime: 5 * 60_000,
  });

  const options = (mapping.data?.active?.roomClasses ?? []).filter((c) => c.active);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  return (
    <>
      <Card className="p-5" data-testid="bcom-room-classes">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <ClipboardList className="h-4 w-4 text-brand-600" aria-hidden="true" />
          Hạng phòng
        </div>

        {branchId === undefined ? (
          <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">
            Vui lòng chọn chi nhánh để xem danh sách mã nội bộ.
          </p>
        ) : null}

        {/*
          The codes belong to the branch the booking is SAVED against, which is
          also what the server validates a selection with. Offering the newly
          picked branch's codes before the change is saved would produce a
          refusal the Admin could not explain, so it says what to do instead.
        */}
        {branchDirty ? (
          <p
            className="mb-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
            data-testid="bcom-branch-dirty"
          >
            Bạn vừa đổi chi nhánh. Vui lòng bấm “Lưu thay đổi” để cập nhật danh sách mã nội bộ theo
            chi nhánh mới.
          </p>
        ) : null}

        {branchId !== undefined && mapping.isError ? (
          <ErrorAlert>{toUserMessage(mapping.error)}</ErrorAlert>
        ) : null}

        {branchId !== undefined && !mapping.isLoading && !mapping.isError && options.length === 0 ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Chi nhánh này chưa có cấu hình hạng phòng đang áp dụng. Vui lòng cấu hình trong mục
            “Khách sạn &amp; chi nhánh” trước khi gửi đơn.
          </p>
        ) : null}

        <ul className="space-y-2" aria-label="Danh sách hạng phòng">
          {booking.rooms.map((room) => (
            <li key={room.roomIndex} className="rounded-xl border border-slate-200 p-3">
              <div className="grid gap-2 sm:grid-cols-[6rem_1fr_12rem] sm:items-end">
                <label className="block text-xs font-medium text-slate-500">
                  Số lượng
                  <input
                    readOnly
                    aria-label={`Số lượng phòng dòng ${room.roomIndex}`}
                    className={`${inputClass} mt-1 bg-slate-50`}
                    value={1}
                  />
                </label>

                {/*
                  The name Booking.com printed, verbatim — "(0)" and all. It is
                  edited in the room card above; here it is shown as the thing
                  the internal code is being chosen FOR.
                */}
                <label className="block text-xs font-medium text-slate-500">
                  Tên hạng phòng trên Booking.com
                  <input
                    readOnly
                    aria-label={`Tên hạng phòng dòng ${room.roomIndex}`}
                    className={`${inputClass} mt-1 bg-slate-50`}
                    value={room.roomType ?? ''}
                  />
                </label>

                <label className="block text-xs font-medium text-slate-500">
                  Mã nội bộ
                  <select
                    aria-label={`Mã nội bộ dòng ${room.roomIndex}`}
                    className={`${inputClass} mt-1`}
                    disabled={branchId === undefined || branchDirty || options.length === 0}
                    value={room.roomClassId ?? ''}
                    onChange={(e) => {
                      if (!e.target.value) return; // never un-set back to nothing
                      const chosen = options.find((c) => c.id === e.target.value);
                      if (!chosen) {
                        // The list came from the server; a value not in it means
                        // the branch's mapping moved underneath this screen.
                        setSelectionError(
                          'Danh sách mã nội bộ đã thay đổi. Vui lòng tải lại trang.',
                        );
                        return;
                      }
                      setSelectionError(null);
                      onRoomClassChanged(
                        room.roomIndex,
                        chosen.id,
                        chosen.pmsCode,
                        chosen.displayName,
                      );
                    }}
                  >
                    <option value="">— Chưa chọn —</option>
                    {options.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.pmsCode} — {c.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/*
                An auto-detected code is shown as detected rather than silently
                accepted: the Admin is being asked to confirm it, not to notice
                its absence.
              */}
              {room.roomClassPmsCode ? (
                <p className="mt-2 text-xs text-slate-500" data-testid={`bcom-room-${room.roomIndex}-status`}>
                  Mã đang dùng: <strong className="text-slate-700">{room.roomClassPmsCode}</strong>
                  {room.roomClassStatus === 'MANUAL' ? ' · đã chọn thủ công' : null}
                  {room.roomClassStatus === 'RESOLVED' ? ' · hệ thống tự nhận diện' : null}
                </p>
              ) : (
                <p className="mt-2 text-xs text-red-700" data-testid={`bcom-room-${room.roomIndex}-status`}>
                  Chưa gán mã hạng phòng nội bộ cho chi nhánh này.
                </p>
              )}
            </li>
          ))}
          {booking.rooms.length === 0 ? (
            <li className="py-3 text-center text-sm text-slate-400">Chưa có dòng phòng nào.</li>
          ) : null}
        </ul>

        {selectionError ? (
          <div className="mt-3">
            <ErrorAlert>{selectionError}</ErrorAlert>
          </div>
        ) : null}

        {!everyRoomHasPmsCode(booking.rooms) ? (
          <p className="mt-3 text-sm text-red-700" data-testid="bcom-room-blocking">
            {UNMAPPED_ROOM_MESSAGE}
          </p>
        ) : null}
      </Card>

      <PmsNoteCard booking={booking} />
    </>
  );
}

/**
 * The Booking.com note, from the Booking.com builder.
 *
 * Editable so an Admin can correct wording before copying, and regenerated
 * whenever the booking behind it changes — including when the internal room
 * code changes, which is the whole point of the selector above. A hand edit
 * survives until the generated text itself changes, at which point the fresh
 * note wins: silently keeping a stale edit over a corrected note is how a
 * wrong room code would reach the hotel system.
 */
function PmsNoteCard({ booking }: { booking: PmsNoteInput }) {
  const generated = buildPmsNote(booking);
  const generatedText = generated.ok ? generated.text ?? '' : '';

  const [edit, setEdit] = useState<string | null>(null);
  const [editedFrom, setEditedFrom] = useState<string>(generatedText);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');

  // Drop the edit when the generated note moves on beneath it.
  if (edit !== null && editedFrom !== generatedText) {
    setEdit(null);
    setEditedFrom(generatedText);
  }

  const text = edit ?? generatedText;

  const onCopy = async () => {
    if (!text.trim()) return;
    const ok = await copyText(text);
    setCopyState(ok ? 'ok' : 'fail');
    window.setTimeout(() => setCopyState('idle'), 2500);
  };

  return (
    <Card className="p-5" data-testid="bcom-pms-note-card">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <StickyNote className="h-4 w-4 text-brand-600" aria-hidden="true" />
          Ghi chú PMS
        </div>
        <div className="flex items-center gap-2">
          {copyState === 'ok' ? <span className="text-xs text-green-700">Đã sao chép.</span> : null}
          {copyState === 'fail' ? (
            <span className="text-xs text-red-700">Không sao chép được. Vui lòng chọn và sao chép thủ công.</span>
          ) : null}
          <Button variant="secondary" onClick={onCopy} disabled={!text.trim()}>
            <Copy className="h-4 w-4" aria-hidden="true" />
            Sao chép note
          </Button>
        </div>
      </div>

      {generated.ok ? (
        <textarea
          data-testid="bcom-pms-note"
          aria-label="Ghi chú PMS"
          rows={3}
          value={text}
          onChange={(e) => {
            setEdit(e.target.value);
            setEditedFrom(generatedText);
          }}
          className={`${inputClass} whitespace-pre-wrap font-mono`}
        />
      ) : (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {generated.error}
        </p>
      )}
    </Card>
  );
}
