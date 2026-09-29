import type {
  IssueAreaCategory,
  IssueAreaSubtype,
  IssueCategory,
  IssueStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { Prisma as PrismaNS } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, type Clock } from '../lib/clock';
import { durationSeconds, formatDuration } from '../lib/duration';
import { captureShiftContext } from '../shift/shiftService';
import {
  generateIssuePhotoName,
  saveIssuePhoto,
  sniffImageMime,
} from './issueStorage';
import {
  AREA_FIELDS,
  ISSUE_AREA_LABELS,
  ISSUE_AREA_SUBTYPE_LABELS,
  describeLocation,
  normaliseArea,
  type AreaInput,
} from './issueArea';

/** The partial unique index that makes "one open attempt per incident" a fact. */
const ONE_OPEN_ATTEMPT = 'TechnicalRepairAttempt_one_open_per_issue';

// The full role enum — see issueSummary.ts. Access is decided at runtime.
type Actor = { id: number; role: UserRole; branchId: number | null; fullName: string };

export interface UploadedPhoto {
  buffer: Buffer;
  size: number;
}

/** Vietnamese labels for the issue categories, used in notifications. */
export const ISSUE_CATEGORY_LABELS: Record<IssueCategory, string> = {
  DOOR: 'Cửa',
  AIR_CONDITIONER: 'Máy lạnh',
  TOILET: 'Nhà vệ sinh',
  TV: 'TV',
  WIFI: 'Wifi',
  ELECTRICITY: 'Điện',
  WATER: 'Nước',
  FURNITURE: 'Nội thất',
  HOUSEKEEPING: 'Buồng phòng',
  GUEST_REQUEST: 'Yêu cầu của khách',
  OTHER: 'Khác',
};

/**
 * THE one include for an incident, and the reason it is exported.
 *
 * `serializeIssue` and the incident PDF are both typed on this payload, and the
 * Admin report loads its own rows. A second hand-copied include drifts the
 * moment a relation is added here — the report then type-checks against a shape
 * it no longer receives — so `routes/adminReports.ts` imports this one rather
 * than repeating it.
 */
export const ISSUE_INCLUDE = {
  branch: true,
  reportedBy: true,
  acceptedBy: true,
  completedBy: true,
  /// Oldest first: "Lần 1" really is the first attempt anybody made.
  attempts: { orderBy: { acceptedAt: 'asc' } },
  /// Oldest first: what a receptionist corrected after the report was filed.
  edits: { orderBy: { createdAt: 'asc' } },
  shiftSession: { select: { id: true, shiftType: true, receptionistName: true } },
} satisfies Prisma.HotelIssueInclude;

export type IssueDetail = Prisma.HotelIssueGetPayload<{ include: typeof ISSUE_INCLUDE }>;

export type RepairAttemptRow = IssueDetail['attempts'][number];

function actorView(user: { id: number; fullName: string } | null) {
  return user ? { id: user.id, fullName: user.fullName } : null;
}

/** The authenticated image endpoint for an issue photo — never a filesystem path. */
export function issuePhotoUrl(id: string): string {
  return `/api/issues/${id}/photo`;
}

/**
 * Public, branch-isolation-safe serialization of an issue.
 *
 * Each "who" is emitted twice on purpose: the live account (`reportedBy`) and
 * the name recorded at the time (`reportedByName`). The name falls back to the
 * account's current one only when there is no snapshot — i.e. on rows created
 * before snapshots existed — so a renamed account never silently rewrites the
 * history of a job somebody else did.
 */
/**
 * One attempt, as the timeline and the report say it.
 *
 * `durationSeconds` is computed from the two timestamps every time it is read,
 * never stored — see the model comment. An OPEN attempt is measured against
 * `now`, so "Đang sửa — 5 phút đã xử lý" counts up on its own as the page polls
 * rather than freezing at whatever it was when the technician pressed accept.
 */
export function serializeAttempt(attempt: RepairAttemptRow, now: Date) {
  const seconds = durationSeconds(attempt.acceptedAt, attempt.outcomeAt ?? now);
  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    technicianName: attempt.technicianNameSnapshot,
    technicianPhone: attempt.technicianPhone,
    acceptedByName: attempt.acceptedByNameSnapshot,
    acceptedAt: attempt.acceptedAt.toISOString(),
    /** Null while the technician is still working. */
    outcome: attempt.outcome,
    outcomeAt: attempt.outcomeAt ? attempt.outcomeAt.toISOString() : null,
    reason: attempt.reason,
    durationSeconds: seconds,
    /** Formatted HERE so the screen and the exported PDF cannot disagree. */
    durationLabel: formatDuration(seconds),
  };
}

export type SerializedAttempt = ReturnType<typeof serializeAttempt>;

/** The words for an edited column, so the screen never prints a raw column name. */
const EDIT_FIELD_LABELS: Record<string, string> = {
  description: 'Mô tả sự cố',
  areaCategory: 'Khu vực',
  roomNumber: 'Số phòng',
  floorNumber: 'Số tầng',
  areaSubtype: 'Loại vị trí',
  locationDetail: 'Vị trí cụ thể',
  category: 'Loại sự cố',
};

/** An enum-valued column's old/new value, as a person reads it. */
function editValueLabel(field: string, value: string | null): string | null {
  if (value === null) return null;
  if (field === 'areaCategory') return ISSUE_AREA_LABELS[value as keyof typeof ISSUE_AREA_LABELS] ?? value;
  if (field === 'areaSubtype') {
    return ISSUE_AREA_SUBTYPE_LABELS[value as keyof typeof ISSUE_AREA_SUBTYPE_LABELS] ?? value;
  }
  if (field === 'category') return ISSUE_CATEGORY_LABELS[value as IssueCategory] ?? value;
  return value;
}

export function serializeIssueEdit(edit: IssueDetail['edits'][number]) {
  return {
    id: edit.id,
    field: edit.field,
    fieldLabel: EDIT_FIELD_LABELS[edit.field] ?? edit.field,
    oldValue: editValueLabel(edit.field, edit.oldValue),
    newValue: editValueLabel(edit.field, edit.newValue),
    actorName: edit.actorNameSnapshot,
    createdAt: edit.createdAt.toISOString(),
  };
}

export function serializeIssue(issue: IssueDetail, now: Date = getClock().now()) {
  /*
    The CURRENT assignment's elapsed time, from the incident's own columns.

    Deliberately not read off the attempts: incidents worked before the attempt
    table existed have no rows, and their acceptance and completion live here.
    Computing it from the columns therefore gives the right answer for both the
    new incidents and the old ones, without inventing an attempt for the old.
  */
  const currentDuration = issue.acceptedAt
    ? durationSeconds(issue.acceptedAt, issue.completedAt ?? now)
    : null;

  const cannotRepairCount = issue.attempts.filter((a) => a.outcome === 'CANNOT_REPAIR').length;

  return {
    id: issue.id,
    branchId: issue.branchId,
    branch: issue.branch
      ? { id: issue.branch.id, code: issue.branch.code, hotelName: issue.branch.hotelName, address: issue.branch.address }
      : null,
    areaCategory: issue.areaCategory,
    roomNumber: issue.roomNumber,
    floorNumber: issue.floorNumber,
    areaSubtype: issue.areaSubtype,
    locationDetail: issue.locationDetail,
    /** The place as one line, so every screen says it the same way. */
    locationLabel: describeLocation(issue),
    category: issue.category,
    description: issue.description,
    photoUrl: issue.photoStoredName ? issuePhotoUrl(issue.id) : null,
    status: issue.status,
    reportedBy: actorView(issue.reportedBy),
    reportedByName: issue.reportedByNameSnapshot ?? issue.reportedBy?.fullName ?? null,
    acceptedBy: actorView(issue.acceptedBy),
    acceptedByName: issue.acceptedByNameSnapshot ?? issue.acceptedBy?.fullName ?? null,
    acceptedAt: issue.acceptedAt ? issue.acceptedAt.toISOString() : null,
    technicianName: issue.technicianName,
    technicianPhone: issue.technicianPhone,
    completedBy: actorView(issue.completedBy),
    completedByName: issue.completedByNameSnapshot ?? issue.completedBy?.fullName ?? null,
    completedAt: issue.completedAt ? issue.completedAt.toISOString() : null,

    /** Which shift reported it, when the reporter was on one. */
    shiftType: issue.shiftType,
    shiftReceptionistName: issue.shiftSession?.receptionistName ?? null,

    /**
     * How long the CURRENT assignment has taken — running while IN_PROGRESS,
     * final once completed, null while nobody has accepted it.
     */
    durationSeconds: currentDuration,
    durationLabel: formatDuration(currentDuration),

    /** Every attempt anybody has made, oldest first. Empty on legacy rows. */
    attempts: issue.attempts.map((a) => serializeAttempt(a, now)),
    /** Every correction made after the report was filed, oldest first. */
    edits: issue.edits.map(serializeIssueEdit),
    cannotRepairCount,
    /**
     * BACK IN THE QUEUE AFTER SOMEBODY TRIED.
     *
     * The operational difference between "nobody has looked at this yet" and
     * "somebody tried and could not fix it" is the whole point of the
     * "Không sửa được" flow, and `status` alone cannot express it — both are
     * NEW. This is the flag the queue reads to say "Cần xử lý lại".
     */
    needsRework: issue.status === 'NEW' && cannotRepairCount > 0,

    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
  };
}

async function loadIssue(id: string): Promise<IssueDetail> {
  const issue = await prisma.hotelIssue.findUnique({ where: { id }, include: ISSUE_INCLUDE });
  if (!issue) throw ApiError.notFound('Không tìm thấy báo cáo sự cố.');
  return issue;
}

/**
 * Branch isolation, unchanged for Reception and deliberately absent for the
 * other two roles: ADMIN watches every branch and TECHNICAL works every branch,
 * because one maintenance team serves all eight properties.
 */
function assertBranchAccess(issue: IssueDetail, actor: Actor): void {
  if (actor.role === 'RECEPTIONIST' && issue.branchId !== actor.branchId) {
    throw ApiError.branchAccessDenied();
  }
}

/** The ONLY role that may move an incident through the workflow. */
export function assertTechnicalActor(actor: Actor): void {
  if (actor.role !== 'TECHNICAL') {
    throw ApiError.forbidden('Chỉ bộ phận kỹ thuật mới xử lý được sự cố.');
  }
}

export interface CreateIssueInput extends AreaInput {
  branchId?: number;
  category?: IssueCategory | null;
  description: string;
  photo?: UploadedPhoto;
}

/**
 * Creates a new issue report. The reporter is the current user; a receptionist's
 * branch is always taken from their session (a client-supplied branchId is
 * ignored, so a report can never be filed against another branch). Every active
 * Admin is notified.
 */
export async function createIssue(input: CreateIssueInput, actor: Actor): Promise<IssueDetail> {
  const branchId = actor.role === 'RECEPTIONIST' ? actor.branchId : input.branchId ?? null;
  if (branchId == null) {
    throw ApiError.validation('Thiếu chi nhánh cho báo cáo sự cố.');
  }
  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw ApiError.validation('Chi nhánh không hợp lệ.');

  // Always mandatory, and trimmed FIRST so "   " is rejected like "".
  const description = input.description.trim();
  if (description.length === 0) throw ApiError.validation('Vui lòng nhập mô tả sự cố.');

  // The area decides which location columns are required, and drops the rest.
  const area = normaliseArea(input);

  // Optional single photo: the declared MIME is never trusted — sniff the bytes.
  const mime = input.photo ? sniffImageMime(input.photo.buffer) : null;
  if (input.photo && !mime) throw ApiError.unsupportedMedia();

  /*
    WHICH SHIFT REPORTED IT — captured, never required.

    `captureShiftContext` rather than `requireOpenSession`: submitting proof of a
    created order is an accounting act and is refused without a shift, but a
    broken door is not. Refusing an incident report because nobody had checked in
    would leave a real fault unreported in order to protect a statistic.

    `reportedByNameSnapshot` deliberately stays the ACCOUNT's name. It answers
    "which login filed this", which is what the existing reports and the reporter
    notification are built on; the person on the desk is a separate question that
    `shiftSessionId` answers without overwriting the first one.
  */
  const shift = await captureShiftContext(actor);

  const issue = await prisma.hotelIssue.create({
    data: {
      branchId,
      ...area,
      // Only some areas ask for a fault type; the rest store none rather than a
      // default nobody chose.
      category: AREA_FIELDS[area.areaCategory].category ? input.category ?? null : null,
      description,
      status: 'NEW',
      reportedByUserId: actor.id,
      reportedByNameSnapshot: actor.fullName,
      shiftSessionId: shift.shiftSessionId,
      shiftType: shift.shiftType,
    },
    include: ISSUE_INCLUDE,
  });

  if (input.photo && mime) {
    // Now that the id exists, generate the definitive file name and persist it.
    const finalName = generateIssuePhotoName(issue.id, mime);
    await saveIssuePhoto(input.photo.buffer, finalName);
    await prisma.hotelIssue.update({
      where: { id: issue.id },
      data: { photoStoredName: finalName, photoMimeType: mime },
    });
  }

  const created = await loadIssue(issue.id);
  await notifyNewIssue(branch.address, created);
  return created;
}

/**
 * A new incident notifies both the people who need to know: every active Admin
 * (who monitors) and every active TECHNICAL user (who will do the work). Before
 * the technical department existed only Admins were told, because only an Admin
 * could act on it.
 */
async function notifyNewIssue(branchAddress: string, issue: IssueDetail): Promise<void> {
  const recipients = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'TECHNICAL'] }, active: true },
    select: { id: true },
  });
  if (recipients.length === 0) return;
  // The category can now be absent (a hallway report has none), so the location
  // is what identifies the incident — it is always present.
  const what = issue.category ? ISSUE_CATEGORY_LABELS[issue.category] : describeLocation(issue);
  await prisma.notification.createMany({
    data: recipients.map((a) => ({
      userId: a.id,
      title: 'Có báo cáo sự cố mới',
      body: `${what} — ${branchAddress}`,
    })),
  });
}

export interface UpdateIssueInput {
  areaCategory?: IssueAreaCategory;
  roomNumber?: string | null;
  floorNumber?: string | null;
  areaSubtype?: IssueAreaSubtype | null;
  locationDetail?: string | null;
  category?: IssueCategory | null;
  description?: string;
}

/** The columns a correction may touch — the fields the report form itself asks for. */
const EDITABLE_ISSUE_FIELDS = [
  'areaCategory',
  'roomNumber',
  'floorNumber',
  'areaSubtype',
  'locationDetail',
  'category',
  'description',
] as const;

/**
 * "SỬA VẤN ĐỀ" — corrects what a report says, without touching how it has gone.
 *
 * WHO: the reception of the incident's own branch, and the Admin. Bộ phận kỹ
 * thuật works incidents, it does not rewrite them, and no other role reports
 * them at all.
 *
 * WHEN: while the incident is open — NEW or IN_PROGRESS, and after a "Không sửa
 * được" too. A COMPLETED incident is a closed record and is refused.
 *
 * WHAT IT NEVER TOUCHES: `createdAt`, the status, the reporter, the shift, the
 * technician, and every repair attempt. The words that were replaced are kept in
 * `HotelIssueEdit` — one row per field, old value, new value, who and when — and
 * are served with the incident, so a technician who is on the way with the old
 * description can be shown that it changed, and what it said before.
 *
 * (This replaces an earlier rule that refused any edit once a technician had
 * accepted the incident. That rule protected a description from being rewritten
 * underneath a repair; the audit row now protects it without stopping the desk
 * from correcting a wrong room number while the repair is under way.)
 */
export async function updateIssue(
  id: string,
  input: UpdateIssueInput,
  actor: Actor,
  clock: Clock = getClock(),
): Promise<IssueDetail> {
  if (actor.role !== 'RECEPTIONIST' && actor.role !== 'ADMIN') {
    throw ApiError.forbidden('Chỉ lễ tân hoặc Admin mới sửa được báo cáo sự cố.');
  }
  const issue = await loadIssue(id);
  assertBranchAccess(issue, actor);
  if (issue.status === 'COMPLETED') {
    throw ApiError.conflict('Không thể sửa sự cố đã hoàn thành.', { status: issue.status });
  }

  const supplied = (Object.keys(input) as (keyof UpdateIssueInput)[]).filter(
    (key) => input[key] !== undefined,
  );
  if (supplied.length === 0) throw ApiError.validation('Cần ít nhất một trường để cập nhật.');
  const touchesArea = supplied.some((key) => key !== 'description' && key !== 'category');

  const next: Partial<Record<(typeof EDITABLE_ISSUE_FIELDS)[number], string | null>> = {};

  if (input.description !== undefined) {
    const d = input.description.trim();
    if (d.length === 0) throw ApiError.validation('Vui lòng nhập mô tả sự cố.');
    next.description = d;
  }

  if (!issue.areaCategory && input.areaCategory === undefined) {
    /*
      A LEGACY REPORT (filed before the structured form) has no area and was
      never asked for one; it is never given one by a partial edit. Only the
      free-form room number and the fault type it always had can change.
    */
    if (touchesArea && input.roomNumber === undefined) {
      throw ApiError.validation('Vui lòng chọn khu vực.');
    }
    if (input.roomNumber !== undefined) next.roomNumber = input.roomNumber?.trim() || null;
    if (input.category !== undefined) next.category = input.category;
  } else if (touchesArea || input.category !== undefined) {
    // Merge over what is stored, then let the area table decide what is valid.
    const area = normaliseArea({
      areaCategory: input.areaCategory ?? issue.areaCategory!,
      roomNumber: input.roomNumber !== undefined ? input.roomNumber : issue.roomNumber,
      floorNumber: input.floorNumber !== undefined ? input.floorNumber : issue.floorNumber,
      areaSubtype: input.areaSubtype !== undefined ? input.areaSubtype : issue.areaSubtype,
      locationDetail: input.locationDetail !== undefined ? input.locationDetail : issue.locationDetail,
    });
    Object.assign(next, area);
    next.category = AREA_FIELDS[area.areaCategory].category
      ? input.category !== undefined
        ? input.category
        : issue.category
      : null;
  }

  const changes: { field: string; oldValue: string | null; newValue: string | null }[] = [];
  const data: Prisma.HotelIssueUpdateInput = {};
  for (const field of EDITABLE_ISSUE_FIELDS) {
    if (!(field in next)) continue;
    const before = (issue[field] ?? null) as string | null;
    const after = next[field] ?? null;
    if (before === after) continue;
    (data as Record<string, unknown>)[field] = after;
    changes.push({ field, oldValue: before, newValue: after });
  }
  // Re-saving an untouched form is a no-op, not an audit row saying "x → x".
  if (changes.length === 0) return issue;

  const now = clock.now();
  await prisma.$transaction([
    prisma.hotelIssue.update({ where: { id }, data }),
    prisma.hotelIssueEdit.createMany({
      data: changes.map((c) => ({
        issueId: id,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        actorUserId: actor.id,
        actorNameSnapshot: actor.fullName,
        createdAt: now,
      })),
    }),
  ]);
  return loadIssue(id);
}

export interface AcceptIssueInput {
  technicianName: string;
  technicianPhone: string;
}

/**
 * NEW → IN_PROGRESS. Technical accepts the job and names who is doing it.
 *
 * WHY THE WHERE-CLAUSE CARRIES THE EXPECTED STATUS
 *
 * `updateMany ... where: { id, status: 'NEW' }` is a conditional write: the
 * database decides, atomically, whether the transition was legal. Two technicians
 * pressing "Tiếp nhận" on the same incident at the same moment therefore produce
 * one winner and one clear 409, instead of the second silently overwriting the
 * first's technician name. Reading the row and then updating it — which is what
 * the old `setIssueStatus` did — leaves exactly that race open.
 */
export async function acceptIssue(
  id: string,
  input: AcceptIssueInput,
  actor: Actor,
  clock: Clock = getClock(),
): Promise<IssueDetail> {
  assertTechnicalActor(actor);

  const technicianName = input.technicianName.trim();
  const technicianPhone = input.technicianPhone.trim();
  if (!technicianName) throw ApiError.validation('Vui lòng nhập họ và tên người sửa.');
  if (!technicianPhone) throw ApiError.validation('Vui lòng nhập số điện thoại người sửa.');

  const issue = await loadIssue(id);
  const now = clock.now();

  /*
    THE ATTEMPT ROW IS WRITTEN IN THE SAME TRANSACTION AS THE TRANSITION.

    Not afterwards, and not derived from the incident's columns later: accepting
    OVERWRITES `technicianName`, `technicianPhone` and `acceptedAt`, so a second
    acceptance after a failed first one would destroy exactly the evidence the
    attempt table exists to keep. Writing the row here means attempt 1 is already
    permanent before attempt 2 can touch the columns.
  */
  try {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.hotelIssue.updateMany({
        where: { id, status: 'NEW' },
        data: {
          status: 'IN_PROGRESS',
          acceptedByUserId: actor.id,
          acceptedByNameSnapshot: actor.fullName,
          acceptedAt: now,
          technicianName,
          technicianPhone,
        },
      });
      if (count === 0) {
        throw ApiError.conflict('Sự cố này không còn ở trạng thái chờ tiếp nhận.', {
          status: issue.status,
        });
      }

      // Counted from what is already stored, inside the transaction, so two
      // acceptances cannot both decide they are number 2.
      const previous = await tx.technicalRepairAttempt.count({ where: { issueId: id } });
      await tx.technicalRepairAttempt.create({
        data: {
          issueId: id,
          attemptNumber: previous + 1,
          technicianUserId: actor.id,
          technicianNameSnapshot: technicianName,
          technicianPhone,
          acceptedByNameSnapshot: actor.fullName,
          acceptedAt: now,
        },
      });
    });
  } catch (error) {
    // Either unique index refusing a second live attempt — the same race, seen
    // from the database instead of from the status check.
    if (
      error instanceof PrismaNS.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      (String(error.meta?.target ?? '').includes(ONE_OPEN_ATTEMPT) ||
        String(error.meta?.target ?? '').includes('attemptNumber'))
    ) {
      throw ApiError.conflict('Sự cố này vừa được người khác tiếp nhận.', { status: 'IN_PROGRESS' });
    }
    throw error;
  }

  const updated = await loadIssue(id);
  await notifyReporterStatus(updated, 'IN_PROGRESS');
  return updated;
}

/**
 * IN_PROGRESS → COMPLETED. Reachable ONLY from IN_PROGRESS, which is what
 * guarantees a completed incident always names the technician who did the work.
 */
export async function completeIssue(
  id: string,
  actor: Actor,
  clock: Clock = getClock(),
): Promise<IssueDetail> {
  assertTechnicalActor(actor);

  const issue = await loadIssue(id);
  const now = clock.now();

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.hotelIssue.updateMany({
      where: { id, status: 'IN_PROGRESS' },
      data: {
        status: 'COMPLETED',
        completedByUserId: actor.id,
        completedByNameSnapshot: actor.fullName,
        completedAt: now,
      },
    });
    if (count === 0) {
      throw ApiError.conflict(
        issue.status === 'COMPLETED'
          ? 'Sự cố này đã hoàn thành trước đó.'
          : 'Cần tiếp nhận sự cố trước khi hoàn thành.',
        { status: issue.status },
      );
    }
    await recordAttemptOutcome(tx, id, 'COMPLETED', null, now, issue);
  });

  const updated = await loadIssue(id);
  await notifyReporterStatus(updated, 'COMPLETED');
  return updated;
}

/**
 * Records the outcome of the work that was in progress.
 *
 * GUARDED ON `outcomeAt: null`, so the outcome is written exactly once: an
 * attempt that somebody else has already closed is left exactly as they closed
 * it rather than being restamped with a second, later outcome.
 *
 * WHY IT FALLS BACK TO CREATING A ROW
 *
 * Incidents that were already IN_PROGRESS when this table was introduced have no
 * attempt row — the migration deliberately backfilled none. Their technician,
 * phone and acceptance time live ONLY on the incident's own columns, and
 * `cannotRepairIssue` clears exactly those columns. Closing "nothing" and then
 * clearing them destroyed the only record that the work had ever happened: who
 * went to the room, how to reach them, and how long they had been on it.
 *
 * So when there is no open attempt but the incident says somebody accepted it,
 * the row is created from those columns and closed in the same write. That is
 * not inventing history — every value in it was already recorded, by the
 * acceptance that set them. What the migration refuses to invent is an attempt
 * for an incident nobody has worked; this is the opposite case.
 *
 * `accepted` is passed in rather than re-read, because the caller has already
 * loaded the incident and the columns are about to change underneath it.
 */
async function recordAttemptOutcome(
  tx: Prisma.TransactionClient,
  issueId: string,
  outcome: 'COMPLETED' | 'CANNOT_REPAIR',
  reason: string | null,
  at: Date,
  accepted: {
    technicianName: string | null;
    technicianPhone: string | null;
    acceptedByNameSnapshot: string | null;
    acceptedByUserId: number | null;
    acceptedAt: Date | null;
  },
): Promise<void> {
  const { count } = await tx.technicalRepairAttempt.updateMany({
    where: { issueId, outcomeAt: null },
    data: { outcome, outcomeAt: at, reason },
  });
  if (count > 0) return;

  // Nothing open. Only worth recording if the incident actually names somebody —
  // otherwise there is genuinely no work to record and no columns to lose.
  if (!accepted.acceptedAt || !accepted.technicianName) return;

  const previous = await tx.technicalRepairAttempt.count({ where: { issueId } });
  await tx.technicalRepairAttempt.create({
    data: {
      issueId,
      attemptNumber: previous + 1,
      technicianUserId: accepted.acceptedByUserId,
      technicianNameSnapshot: accepted.technicianName,
      // Phone is NOT NULL on the attempt; an old row could in principle lack it,
      // and an em dash records "not known" rather than refusing to save the rest.
      technicianPhone: accepted.technicianPhone ?? '—',
      acceptedByNameSnapshot: accepted.acceptedByNameSnapshot,
      acceptedAt: accepted.acceptedAt,
      outcome,
      outcomeAt: at,
      reason,
    },
  });
}

export interface CannotRepairInput {
  reason: string;
}

/**
 * IN_PROGRESS → NEW. "Không sửa được".
 *
 * WHAT THIS IS NOT: A CANCELLATION. The incident is still broken and still needs
 * somebody, so it goes back to the queue rather than to a dead state — and it
 * goes back carrying a flag (`needsRework`) that distinguishes it from a report
 * nobody has looked at yet.
 *
 * WHY THE INCIDENT'S TECHNICIAN COLUMNS ARE CLEARED
 *
 * This looks like erasing the technician, and it is the opposite. Those columns
 * are the CURRENT assignment: leaving them set would put a named technician and
 * an acceptance time on an incident whose status says nobody has picked it up —
 * which reads, on every screen and in the PDF, as "Bảo is working on this" when
 * Bảo has gone. Worse, the next `acceptIssue` overwrites them anyway, so keeping
 * them here would preserve the first attempt only until somebody made a second.
 *
 * The attempt row written by `acceptIssue` already holds the name, the phone,
 * the acceptance time, the failure time and the reason, permanently and
 * immutably. Clearing the columns moves the fact to the place that keeps it.
 */
export async function cannotRepairIssue(
  id: string,
  input: CannotRepairInput,
  actor: Actor,
  clock: Clock = getClock(),
): Promise<IssueDetail> {
  assertTechnicalActor(actor);

  // Trimmed BEFORE the check: an incident cannot go back to the queue with a
  // reason of three spaces.
  const reason = input.reason.trim();
  if (!reason) throw ApiError.validation('Vui lòng nhập lý do không sửa được.');

  const issue = await loadIssue(id);
  const now = clock.now();

  await prisma.$transaction(async (tx) => {
    /*
      THE INCIDENT IS UPDATED FIRST, AND THE ATTEMPT SECOND — THE SAME ORDER AS
      `completeIssue`.

      It used to be the other way round, so that the attempt could be closed
      while the incident's columns still held the assignment. That created an
      AB-BA deadlock: two technicians acting on one incident at the same instant,
      one pressing "Hoàn thành" and the other "Không sửa được", took the two row
      locks in opposite orders. PostgreSQL aborts one with 40P01, which is not a
      P2002 and is handled nowhere — so the loser got a 500 instead of the 409
      the guard is there to produce.

      The values the attempt needs come from `issue`, loaded before the
      transaction, so taking the locks in this order costs nothing.
    */
    const { count } = await tx.hotelIssue.updateMany({
      where: { id, status: 'IN_PROGRESS' },
      data: {
        status: 'NEW',
        acceptedByUserId: null,
        acceptedByNameSnapshot: null,
        acceptedAt: null,
        technicianName: null,
        technicianPhone: null,
      },
    });
    if (count === 0) {
      throw ApiError.conflict(
        issue.status === 'COMPLETED'
          ? 'Sự cố này đã hoàn thành, không thể trả lại hàng đợi.'
          : 'Cần tiếp nhận sự cố trước khi báo không sửa được.',
        { status: issue.status },
      );
    }

    // Written from the snapshot taken before the columns were cleared, so an
    // incident accepted before this table existed keeps its technician.
    await recordAttemptOutcome(tx, id, 'CANNOT_REPAIR', reason, now, issue);
  });

  const updated = await loadIssue(id);
  await notifyReporterCannotRepair(updated, reason);
  return updated;
}

/**
 * The reporter is told their incident came BACK, and why.
 *
 * Deliberately not folded into `notifyReporterStatus`: that function names a
 * status, and "your incident is NEW again" is not a status the reporter can act
 * on. What they need is that somebody went, could not fix it, and it is queued
 * again — so this says that instead.
 */
async function notifyReporterCannotRepair(issue: IssueDetail, reason: string): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { id: issue.reportedByUserId, active: true },
    select: { id: true },
  });
  if (!user) return;
  await prisma.notification.create({
    data: {
      userId: issue.reportedByUserId,
      title: 'Sự cố chưa sửa được, đang chờ xử lý lại',
      body: `${describeLocation(issue)} — ${reason}`,
    },
  });
}

async function notifyReporterStatus(issue: IssueDetail, status: IssueStatus): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { id: issue.reportedByUserId, active: true },
    select: { id: true },
  });
  if (!user) return;
  const title = status === 'IN_PROGRESS' ? 'Sự cố đang được xử lý' : 'Sự cố đã hoàn thành';
  await prisma.notification.create({
    data: { userId: issue.reportedByUserId, title, body: describeLocation(issue) },
  });
}

export interface ListIssuesFilter {
  branchId?: number;
  status?: IssueStatus;
  areaCategory?: IssueAreaCategory;
  /**
   * Half-open [from, to) over `createdAt` — the instant the incident was
   * REPORTED. Not an acceptance or completion date: "how many incidents came up
   * between the 17th and the 20th" is a question about when they happened, and
   * counting by completion would move an incident into the period somebody
   * happened to finish it in.
   */
  from?: Date;
  to?: Date;
  /**
   * "Tồn đọng hiện tại" — everything not finished, whenever it was reported.
   *
   * DELIBERATELY IGNORES THE DATE RANGE, and that is the whole point of it: the
   * question it answers is "what still needs doing right now?", and an incident
   * reported three weeks ago and still open is the most important answer to it —
   * exactly the one a report scoped to this week would hide.
   */
  outstanding?: boolean;
  skip: number;
  take: number;
}

/**
 * Lists issues newest-first.
 *
 * VISIBILITY, BY ROLE:
 *   RECEPTIONIST  their own branch only, and a client-sent branchId is IGNORED
 *                 rather than refused — the scope is not theirs to choose.
 *   TECHNICAL     all eight branches, optionally narrowed by `branchId`.
 *   ADMIN         all eight branches, optionally narrowed by `branchId`.
 */
export async function listIssues(actor: Actor, filter: ListIssuesFilter): Promise<{ issues: IssueDetail[]; total: number }> {
  const where: Prisma.HotelIssueWhereInput = {};
  if (actor.role === 'RECEPTIONIST') {
    where.branchId = actor.branchId ?? -1; // -1 never matches → an unassigned receptionist sees nothing
  } else if (filter.branchId !== undefined) {
    where.branchId = filter.branchId;
  }
  if (filter.status) where.status = filter.status;
  if (filter.areaCategory) where.areaCategory = filter.areaCategory;

  if (filter.outstanding) {
    // Overrides an explicit status rather than intersecting with it: "tồn đọng"
    // IS a status set, and `outstanding + status=COMPLETED` is a contradiction
    // that would silently return nothing.
    where.status = { in: ['NEW', 'IN_PROGRESS'] };
  } else if (filter.from || filter.to) {
    where.createdAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lt: filter.to } : {}),
    };
  }

  const [total, issues] = await prisma.$transaction([
    prisma.hotelIssue.count({ where }),
    prisma.hotelIssue.findMany({ where, include: ISSUE_INCLUDE, orderBy: { createdAt: 'desc' }, skip: filter.skip, take: filter.take }),
  ]);
  return { issues, total };
}

export async function getIssue(id: string, actor: Actor): Promise<IssueDetail> {
  const issue = await loadIssue(id);
  assertBranchAccess(issue, actor);
  return issue;
}

/** Authorises an issue-photo request and returns what the file endpoint needs. */
export async function authorizeIssuePhoto(id: string, actor: Actor): Promise<{ storedFileName: string; mimeType: string }> {
  const issue = await prisma.hotelIssue.findUnique({
    where: { id },
    select: { photoStoredName: true, photoMimeType: true, branchId: true },
  });
  if (!issue || !issue.photoStoredName) throw ApiError.notFound('Không tìm thấy ảnh.');
  if (actor.role === 'RECEPTIONIST' && issue.branchId !== actor.branchId) throw ApiError.branchAccessDenied();
  return { storedFileName: issue.photoStoredName, mimeType: issue.photoMimeType ?? 'image/jpeg' };
}
