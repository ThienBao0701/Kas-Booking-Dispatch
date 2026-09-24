import { Router } from 'express';
import { z } from 'zod';
import { getClock } from '../lib/clock';
import { ApiError } from '../lib/errors';
import { requireAuth, requirePasswordChanged, requireRole } from '../middleware/auth';
import { checkInShift, findOpenSession, serializeShiftSession } from '../shift/shiftService';
import { endShift, endShiftPreview } from '../shift/endShiftService';
import { handoverShift, serializeHandoverResult } from '../shift/handoverService';
import {
  createHandoverNote,
  listHandoverNotes,
  pendingWork,
  serializeHandoverNote,
} from '../shift/handoverNoteService';
import { SHIFT_DEFINITIONS } from '../shift/shiftTypes';
import type { UserWithBranch } from '../auth/serialize';

const SHIFT = z.enum(['A', 'B', 'C', 'A4', 'C4']);

const checkInSchema = z.object({
  shiftType: SHIFT,
  /**
   * Trimmed by zod BEFORE min(1), so a name of only spaces is refused rather
   * than stored. The service trims again — it is reachable without this router.
   */
  receptionistName: z.string().trim().min(1, 'Vui lòng nhập họ tên lễ tân.').max(200),
});

/**
 * "Đổi ca". Every field is required except the account binding.
 *
 * `incomingShiftType` is asked for EXPLICITLY and never inferred. Ca A and Ca A4
 * both start at 06:00 and Ca C and Ca C4 both end at 06:00, so at a handover the
 * clock genuinely cannot tell which shift is being taken on — and a wrong guess
 * would be accepted silently and would decide when the next prompt appears.
 *
 * There is NO `handoverAt` field, on purpose. The instant is the server's.
 */
const handoverSchema = z.object({
  reason: z.string().trim().min(1, 'Vui lòng nhập lý do đổi ca.').max(1000),
  incomingName: z.string().trim().min(1, 'Vui lòng nhập họ tên người nhận ca.').max(200),
  incomingShiftType: SHIFT,
  incomingUserId: z.coerce.number().int().positive().optional(),
  note: z
    .object({
      content: z.string().trim().min(1, 'Vui lòng nhập nội dung bàn giao.').max(5000),
      priority: z.enum(['NORMAL', 'HIGH']).optional(),
    })
    .optional(),
});

/** A standalone "Bàn giao ca" note, written without changing shift. */
const noteSchema = z.object({
  content: z.string().trim().min(1, 'Vui lòng nhập nội dung bàn giao.').max(5000),
  priority: z.enum(['NORMAL', 'HIGH']).optional(),
  incomingName: z.string().trim().max(200).optional(),
  incomingShiftType: SHIFT.optional(),
});

const noteListSchema = z.object({
  branchId: z.coerce.number().int().positive().optional(),
});

function actor(user: UserWithBranch) {
  return { id: user.id, role: user.role, branchId: user.branchId, fullName: user.fullName };
}

/** Only a receptionist works a shift. */
const requireReception = requireRole('RECEPTIONIST');

/**
 * Reception shift check-in.
 *
 * The whole point of these routes is that the browser never decides who is
 * working: it asks the server for the current shift on every load, and the
 * server answers from the database. Nothing here trusts React state, which is
 * why a refresh, a second tab and a reopened laptop all agree.
 */
export function createReceptionShiftsRouter(): Router {
  const router = Router();

  // GET /api/reception/shifts/options — the five shifts, with their clock times.
  // Served rather than hardcoded in the client so the times exist ONCE.
  router.get('/reception/shifts/options', requireAuth, requirePasswordChanged, (_req, res) => {
    res.json({ shifts: SHIFT_DEFINITIONS });
  });

  // GET /api/reception/shifts/current — the open session, or null.
  //
  // Answers with `session: null` rather than 404 when nobody is checked in: "no
  // shift yet" is the normal state at the start of a day, not an error, and the
  // client renders the picker from it.
  router.get('/reception/shifts/current', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const now = getClock().now();
      const session = await findOpenSession(user.id);
      res.json({ session: session ? serializeShiftSession(session, now) : null });
    })().catch(next);
  });

  // POST /api/reception/shifts/check-in — open a shift (closes the previous one).
  router.post('/reception/shifts/check-in', requireAuth, requirePasswordChanged, requireReception, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const input = checkInSchema.parse(req.body ?? {});
      const clock = getClock();
      const session = await checkInShift(input, actor(user), clock);
      res.status(201).json({ session: serializeShiftSession(session, clock.now()) });
    })().catch(next);
  });

  /*
    GET /api/reception/shifts/end-preview — what "Kết thúc ca" is about to close.

    Read-only, and it changes nothing. The confirmation dialog needs the shift,
    the receptionist, the start time and the drawer, plus whether there is
    outstanding work that nobody has written a handover note about. Computing
    that in the browser would mean three more requests and a second copy of the
    rule the reminder is based on.
  */
  router.get('/reception/shifts/end-preview', requireAuth, requirePasswordChanged, requireReception, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const now = getClock().now();
      const preview = await endShiftPreview(actor(user));
      res.json({
        session: preview.session ? serializeShiftSession(preview.session, now) : null,
        pending: preview.pending,
        handoverNoteCount: preview.handoverNoteCount,
        reportCount: preview.reportCount,
        cash: preview.cash,
        handoverAdvised: preview.handoverAdvised,
      });
    })().catch(next);
  });

  /*
    POST /api/reception/shifts/close — "Kết thúc ca".

    The shift ends and NOTHING opens in its place. The next receptionist checks
    in and says who they are; until then the desk has no open session, which is
    the honest state — and it is what stops the shift that just ended from
    recording anything else.

    NO TIMESTAMP IS ACCEPTED. The actual end is `closedAt`, stamped by the server
    from the business clock. A reception PC with a wrong clock must not be able
    to decide which receptionist owns the cash around the boundary.

    DELIBERATELY NOT "Đổi ca": that one hands the desk to a NAMED person in the
    same instant and records a reason. Folding the two together would make every
    ordinary 14:00 invent an incoming receptionist who has not arrived yet.
  */
  router.post('/reception/shifts/close', requireAuth, requirePasswordChanged, requireReception, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const clock = getClock();
      const result = await endShift(actor(user), clock);
      res.json({
        closed: result.closed,
        session: result.session ? serializeShiftSession(result.session, clock.now()) : null,
        cash: result.cash,
      });
    })().catch(next);
  });

  /*
    POST /api/reception/shifts/handover — "Đổi ca".

    DELIBERATELY NOT A FLAG ON check-in. Check-in already closes a previous
    session and opens a new one, which is the right behaviour for a receptionist
    arriving at the start of their own shift, and it takes exactly two fields.
    A handover is a different event with a different record — it names who is
    taking over and why the shift ended early — and folding the two together
    would put four optional fields on the request every receptionist makes at
    06:00 every morning, three of which would be meaningless to them.

    It is the OUTGOING receptionist who calls this, from their own session. That
    is what makes closing the outgoing session possible at all: no endpoint
    anywhere closes somebody else's shift.
  */
  router.post('/reception/shifts/handover', requireAuth, requirePasswordChanged, requireReception, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const input = handoverSchema.parse(req.body ?? {});
      const clock = getClock();
      const result = await handoverShift(input, actor(user), clock);
      res.status(201).json(serializeHandoverResult(result, clock.now()));
    })().catch(next);
  });

  /*
    GET /api/reception/handover-notes — this branch's notes, newest first.

    GATED TO RECEPTION AND ADMIN, EXPLICITLY.

    This route shipped for a few hours with only `requireAuth`, which was a real
    hole rather than a stylistic slip: `listHandoverNotes` narrows by branch only
    for a RECEPTIONIST, so TECHNICAL and BOOKING_DEPARTMENT fell past both arms
    of that check with an empty `where` — and read every branch's notes, plus any
    branch they named in the query string. Handover notes carry guest callbacks,
    room details and staff names.

    The gate names both roles rather than relying on the service, and the service
    now refuses a cross-branch read from anyone who is not an Admin as well.
  */
  router.get('/reception/handover-notes', requireAuth, requirePasswordChanged, requireRole('ADMIN', 'RECEPTIONIST'), (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const q = noteListSchema.parse(req.query);
      const notes = await listHandoverNotes(actor(user), { branchId: q.branchId });
      res.json({ notes: notes.map(serializeHandoverNote) });
    })().catch(next);
  });

  /*
    GET /api/reception/handover-notes/context — "việc đang tồn" for the form.

    Declared BEFORE nothing, but named as a sub-path of the collection rather
    than a sibling because it is the same subject; there is no ":id" route under
    handover-notes for it to be mistaken for.
  */
  router.get('/reception/handover-notes/context', requireAuth, requirePasswordChanged, requireReception, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      if (user.branchId == null) {
        throw ApiError.branchAccessDenied('Tài khoản chưa được gán chi nhánh.');
      }
      res.json({ pending: await pendingWork(user.branchId) });
    })().catch(next);
  });

  // POST /api/reception/handover-notes — leave a note for the next shift.
  router.post('/reception/handover-notes', requireAuth, requirePasswordChanged, requireReception, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const input = noteSchema.parse(req.body ?? {});
      const note = await createHandoverNote(input, actor(user), getClock());
      res.status(201).json({ note: serializeHandoverNote(note) });
    })().catch(next);
  });

  return router;
}
