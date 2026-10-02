/**
 * Wires the three CẮT controls of one booking to the clipboard and the server.
 *
 * ONE CONTROLLER PER BOOKING, NOT ONE PER FIELD. All three buttons share this
 * hook, so they share one mutation, one claim and one deadline — the structure
 * itself is what makes "three separate timers" unrepresentable rather than
 * merely untested.
 *
 * ── THE SEQUENCE ──────────────────────────────────────────────────────────
 *   1. copy the value to the SYSTEM clipboard and wait for the result
 *   2. only if that succeeded, tell the server the field was taken
 *   3. the server claims the order if this was the first cut
 *   4. the refetched `cutFields` is what hides the field
 *
 * Steps 1 and 2 are in that order deliberately. Hiding first and copying after
 * would, on any clipboard failure, leave the receptionist with neither the
 * value on screen nor the value in the clipboard — and they cannot get it back,
 * because the field stays hidden for the rest of the cycle.
 *
 * There is no optimistic hiding: after a successful cut the booking query is
 * invalidated and the SERVER's `cutFields` renders. A refresh, a second tab and
 * this tab therefore always agree, and a cut the server refused never appears
 * to have worked.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { bookingsApi, type ClaimFields, type CutField } from '../api/bookings';
import { toUserMessage } from '../api/errors';
import { copyText } from '../lib/copy';
import { claimStateOf } from '../lib/claim';
import { CUT_CLIPBOARD_FAILED, type CutController } from '../lib/cut';
import { useAuth } from '../auth/AuthProvider';

export function useCut(
  bookingId: string,
  cutFields: CutField[] | undefined,
  claim: ClaimFields,
): CutController {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [pending, setPending] = useState<CutField | null>(null);
  const [clipboardError, setClipboardError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (field: CutField) => bookingsApi.cut(bookingId, field),
    onSettled: () => setPending(null),
    onSuccess: () => {
      // Both queries: the detail re-renders the fields, and the list re-renders
      // because the first cut has just taken the order off everyone else's queue.
      void queryClient.invalidateQueries({ queryKey: ['booking', bookingId] });
      void queryClient.invalidateQueries({ queryKey: ['bookings'] });
      void queryClient.invalidateQueries({ queryKey: ['nav-badges'] });
    },
  });

  const taken = new Set(cutFields ?? []);

  return {
    isCut: (field) => taken.has(field),
    cut: (field, value) => {
      // Cutting an already-cut field is a no-op rather than a second request:
      // the server is idempotent, but there is nothing to ask it for. One at a
      // time, so a double-click cannot put two values in the clipboard at once.
      if (taken.has(field) || pending !== null) return;

      setPending(field);
      setClipboardError(null);

      void copyText(value).then((copied) => {
        if (!copied) {
          // Nothing is hidden and no claim is started. The screen is exactly as
          // it was, which is the only safe outcome when the value did not reach
          // the clipboard.
          setPending(null);
          setClipboardError(CUT_CLIPBOARD_FAILED);
          return;
        }
        mutation.mutate(field);
      });
    },
    pending,
    error: clipboardError ?? (mutation.isError ? toUserMessage(mutation.error) : null),
    claimIsMine: claimStateOf(claim, user?.id) === 'MINE',
  };
}
