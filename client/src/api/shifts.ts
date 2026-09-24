import { api } from './client';
import type { CashSummary } from './receptionReports';

export type ShiftType = 'A' | 'B' | 'C' | 'A4' | 'C4';

export interface ShiftOption {
  code: ShiftType;
  name: string;
  startLocalTime: string;
  endLocalTime: string;
  crossesMidnight: boolean;
  graceMinutes: number;
}

export interface ShiftSession {
  id: string;
  branchId: number;
  shiftType: ShiftType;
  shiftName: string;
  /** "06:00 – 14:00", built by the server so the times exist in one place. */
  shiftWindow: string;
  receptionistName: string;
  startedAt: string;
  nominalEndAt: string;
  graceEndAt: string;
  closedAt: string | null;
  /**
   * TRUE once the nominal end plus the 10-minute grace has passed.
   *
   * COMPUTED BY THE SERVER, deliberately. The alternative — comparing
   * `graceEndAt` against the browser's clock — would make the handover prompt
   * depend on how accurately each reception PC is set, and a machine running ten
   * minutes fast would nag its receptionist early, every shift.
   */
  promptDue: boolean;
}

export interface CheckInInput {
  shiftType: ShiftType;
  receptionistName: string;
}

/** One early shift change, as the Admin audit and the confirmation read it. */
export interface ShiftHandoverSide {
  shiftSessionId: string;
  userId: number | null;
  name: string;
  shiftType: ShiftType;
  shiftName: string;
  shiftWindow: string;
}

export interface ShiftHandover {
  id: string;
  branchId: number;
  branch: { id: number; code: string; hotelName: string; address: string } | null;
  outgoing: ShiftHandoverSide;
  incoming: ShiftHandoverSide;
  /** The SERVER's instant of confirmation, never the browser's. */
  actualHandoverAt: string;
  reason: string;
  createdAt: string;
}

export interface HandoverInput {
  reason: string;
  incomingName: string;
  incomingShiftType: ShiftType;
  incomingUserId?: number;
  note?: { content: string; priority?: HandoverPriority };
}

export type HandoverPriority = 'NORMAL' | 'HIGH';

export interface HandoverNote {
  id: string;
  branchId: number;
  branch: { id: number; code: string; hotelName: string; address: string } | null;
  shiftSessionId: string | null;
  handoverId: string | null;
  outgoingName: string;
  outgoingShiftType: ShiftType;
  outgoingShiftName: string;
  outgoingShiftWindow: string;
  incomingName: string | null;
  incomingShiftType: ShiftType | null;
  incomingShiftName: string | null;
  content: string;
  priority: HandoverPriority;
  createdAt: string;
}

/** "Việc đang tồn" — live context shown beside the handover form, never copied. */
export interface PendingWork {
  openIssues: { id: string; location: string; status: string; needsRework: boolean }[];
  bookings: { awaitingCreation: number; awaitingReview: number; needsRecreation: number };
}

export interface NewHandoverNoteInput {
  content: string;
  priority?: HandoverPriority;
  incomingName?: string;
  incomingShiftType?: ShiftType;
}

/** What "Kết thúc ca" is about to close. Read-only; it changes nothing. */
export interface EndShiftPreview {
  session: ShiftSession | null;
  pending: PendingWork;
  handoverNoteCount: number;
  reportCount: number;
  cash: CashSummary | null;
  /**
   * TRUE when work is outstanding and this shift has written no handover note.
   *
   * A REMINDER, NOT A GATE. The close is never blocked: a receptionist whose
   * replacement is standing beside them has already handed over in person, and
   * refusing to let them leave would turn a prompt into an obstacle they learn
   * to click through. What the system must not do is RECORD a handover that did
   * not happen.
   */
  handoverAdvised: boolean;
}

export interface EndShiftResult {
  /** 1 when a shift was closed, 0 when there was nothing open. Idempotent. */
  closed: number;
  /** The session with `closedAt` set — the server's instant, never the browser's. */
  session: ShiftSession | null;
  cash: CashSummary | null;
}

export const shiftsApi = {
  options: () => api.get<{ shifts: ShiftOption[] }>('/reception/shifts/options'),

  /** The open session, or null when nobody is checked in yet. */
  current: () => api.get<{ session: ShiftSession | null }>('/reception/shifts/current'),

  checkIn: (input: CheckInInput) =>
    api.post<{ session: ShiftSession }>('/reception/shifts/check-in', input),

  /**
   * "Kết thúc ca". Carries NO timestamp: the end instant is the server's, and a
   * reception PC with a wrong clock must not decide which receptionist owns the
   * cash around the boundary.
   */
  close: () => api.post<EndShiftResult>('/reception/shifts/close', {}),

  endPreview: () => api.get<EndShiftPreview>('/reception/shifts/end-preview'),

  /**
   * "Đổi ca". Carries no timestamp — the handover instant is the server's, and
   * sending one from here would let a wrongly-set reception PC decide which
   * receptionist owns the orders around the boundary.
   */
  handover: (input: HandoverInput) =>
    api.post<{ handover: ShiftHandover; session: ShiftSession }>(
      '/reception/shifts/handover',
      input,
    ),

  handoverNotes: () => api.get<{ notes: HandoverNote[] }>('/reception/handover-notes'),

  handoverContext: () => api.get<{ pending: PendingWork }>('/reception/handover-notes/context'),

  createHandoverNote: (input: NewHandoverNoteInput) =>
    api.post<{ note: HandoverNote }>('/reception/handover-notes', input),
};
