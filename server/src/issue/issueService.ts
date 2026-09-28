import type {
  InspectionResult,
  IssueAreaCategory,
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
import { AREA_FIELDS, describeLocation, normaliseArea, type AreaInput } from './issueArea';
import { activeIssueWhere, archivedIssueWhere } from '../reception/completionArchive';
import {
  INSPECTION_RESULT_LABELS,
  inspectionEnabled,
  issueLifecycle,
  outstandingStatuses,
  stageWhere,
  type IssueStage,
} from './issueLifecycle';

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
  attempts: { orderBy: { attemptNumber: 'asc' } },
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
    /** "Nguyên nhân" as this attempt's technician determined it, if they did. */
    cause: attempt.cause,
    /** "Kết quả sửa chữa" — what was done. */
    result: attempt.result,
    /**
     * The Technical Manager's verdict on THIS attempt, or null — not yet
     * inspected, or made before inspection existed.
     */
    inspection: attempt.inspectionResult
      ? {
          result: attempt.inspectionResult,
          resultLabel: INSPECTION_RESULT_LABELS[attempt.inspectionResult],
          inspectedByName: attempt.inspectedByNameSnapshot,
          inspectedAt: attempt.inspectedAt ? attempt.inspectedAt.toISOString() : null,
          /** Optional note on a pass; the required reason on a fail. */
          note: attempt.inspectionNote,
        }
      : null,
    durationSeconds: seconds,
    /** Formatted HERE so the screen and the exported PDF cannot disagree. */
    durationLabel: formatDuration(seconds),
  };
}

export type SerializedAttempt = ReturnType<typeof serializeAttempt>;

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
  const lifecycle = issueLifecycle(issue);

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
    /** "Nguyên nhân" as the receptionist reported it — often empty. */
    reportedCause: issue.cause,
    photoUrl: issue.photoStoredName ? issuePhotoUrl(issue.id) : null,
    status: issue.status,
    /** Whether screens should show anything about "Nghiệm thu" at all. */
    inspectionEnabled: inspectionEnabled(),
    ...lifecycle,
    reportedBy: actorView(issue.reportedBy),
    /** The reporting ACCOUNT, as it was named then — kept for audit. */
    reportedByName: issue.reportedByNameSnapshot ?? issue.reportedBy?.fullName ?? null,
    /**
     * "Người báo" as a person reads it: the receptionist ON THE SHIFT that
     * reported it, else the account's name. Composed here so no screen parses
     * "test (Đức)" back apart.
     */
    reporterName:
      issue.shiftSession?.receptionistName ??
      issue.reportedByNameSnapshot ??
      issue.reportedBy?.fullName ??
      null,
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
    cannotRepairCount,
    /**
     * BACK IN THE QUEUE AFTER SOMEBODY TRIED — a failed inspection or a
     * "Không sửa được".
     *
     * The operational difference between "nobody has looked at this yet" and
     * "somebody already worked this" is the whole point of both flows, and
     * `status` alone cannot express it — both are NEW. This is the flag the
     * queue reads to say "Cần sửa lại".
     */
    needsRework: lifecycle.stage === 'REWORK',

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
 * other roles: ADMIN watches every branch, and TECHNICAL and TECHNICAL_MANAGER
 * work every branch, because one maintenance team serves all eight properties.
 */
function assertBranchAccess(issue: IssueDetail, actor: Actor): void {
  if (actor.role === 'RECEPTIONIST' && issue.branchId !== actor.branchId) {
    throw ApiError.branchAccessDenied();
  }
}

/** The ONLY role that may move an incident through the repair workflow. */
export function assertTechnicalActor(actor: Actor): void {
  if (actor.role !== 'TECHNICAL') {
    throw ApiError.forbidden('Chỉ bộ phận kỹ thuật mới xử lý được sự cố.');
  }
}

/**
 * The ONLY role that may judge a repair — "Quản lý kỹ thuật".
 *
 * Not the technician (nobody signs off their own work), and not the Admin, who
 * monitors every incident but does not stand in the room to check the door
 * closes. Enforced here as well as on the route, so no other path reaches it.
 */
export function assertInspector(actor: Actor): void {
  if (actor.role !== 'TECHNICAL_MANAGER') {
    throw ApiError.forbidden('Chỉ quản lý kỹ thuật mới nghiệm thu được sự cố.');
  }
}

/** Trimmed text, or null when nothing but whitespace was sent. */
function optionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export interface CreateIssueInput extends AreaInput {
  branchId?: number;
  category?: IssueCategory | null;
  description: string;
  /** "Nguyên nhân", if Reception already knows it. Optional. */
  cause?: string | null;
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
      // Kept exactly as reported. A technician's later determination is stored
      // on their attempt, never written over this.
      cause: optionalText(input.cause),
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
  roomNumber?: string | null;
  category?: IssueCategory;
  description?: string;
}

/**
 * Edits a report. Only the reporting side (own branch) may edit, and only while
 * the issue is still NEW — once an Admin accepts it, edits are refused.
 */
export async function updateIssue(id: string, input: UpdateIssueInput, actor: Actor): Promise<IssueDetail> {
  const issue = await loadIssue(id);
  assertBranchAccess(issue, actor);
  if (issue.status !== 'NEW') {
    throw ApiError.conflict('Không thể sửa báo cáo sau khi Admin đã tiếp nhận.', { status: issue.status });
  }
  /*
    AND NOT AFTER SOMEBODY HAS ALREADY WORKED IT.

    A "Không sửa được" puts the incident back to NEW, which would otherwise
    re-open the reporter's edit rights on a report a technician has already been
    to — letting the description be rewritten underneath an attempt that was made
    against the old one. Once there is history, the report is a record.
  */
  if (issue.attempts.length > 0) {
    throw ApiError.conflict('Không thể sửa báo cáo đã có người tiếp nhận xử lý.', {
      attempts: issue.attempts.length,
    });
  }
  const data: Prisma.HotelIssueUpdateInput = {};
  if (input.roomNumber !== undefined) data.roomNumber = input.roomNumber?.trim() ? input.roomNumber.trim() : null;
  if (input.category !== undefined) data.category = input.category;
  if (input.description !== undefined) {
    const d = input.description.trim();
    if (d.length === 0) throw ApiError.validation('Vui lòng nhập mô tả sự cố.');
    data.description = d;
  }
  await prisma.hotelIssue.update({ where: { id }, data });
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

/** Why a transition found the incident somewhere other than where it expected. */
function finishedMessage(status: IssueStatus): string | null {
  if (status === 'COMPLETED') return 'Sự cố này đã hoàn thành trước đó.';
  if (status === 'AWAITING_INSPECTION') return 'Sự cố này đã hoàn thành, đang chờ nghiệm thu.';
  return null;
}

export interface CompleteIssueInput {
  /**
   * "Nguyên nhân" as the technician determined it. Optional: when they leave it
   * empty the cause already on file (reported, or an earlier attempt's) stands.
   */
  cause?: string | null;
  /**
   * "Kết quả sửa chữa" — what was done. Required while inspection is active (it
   * is what gets inspected); optional while it is dormant, when "Hoàn thành" is
   * the single press it has always been.
   */
  result?: string | null;
}

/**
 * IN_PROGRESS → AWAITING_INSPECTION. "Hoàn thành".
 *
 * Reachable ONLY from IN_PROGRESS, which is what guarantees a finished repair
 * always names the technician who did the work. The server stamps the moment —
 * the timer stops here, not when the manager gets round to inspecting it — and
 * the incident is NOT closed: it waits for "Quản lý kỹ thuật" to pass it.
 */
export async function completeIssue(
  id: string,
  input: CompleteIssueInput,
  actor: Actor,
  clock: Clock = getClock(),
): Promise<IssueDetail> {
  assertTechnicalActor(actor);

  // Trimmed BEFORE the check: "   " is not a description of a repair.
  const result = optionalText(input.result);
  if (!result && inspectionEnabled()) throw ApiError.validation('Vui lòng nhập kết quả sửa chữa.');
  const cause = optionalText(input.cause);

  const issue = await loadIssue(id);
  const now = clock.now();

  /*
    A VERDICT NEEDS A REPAIR RECORD TO BE STAMPED ON.

    Normally there is one: the attempt "Tiếp nhận" opened, or — for an incident
    accepted before attempts existed — the one its own acceptance columns
    describe. An incident left IN_PROGRESS by the old workflow with NO acceptance
    time on file has neither, and cannot get one without inventing when the
    repair began. Sending it to "Chờ nghiệm thu" would strand it there for good:
    inspection would have nothing to judge, and no other transition accepts that
    status. So it closes as it did before inspection existed, and its inspection
    reads "Chưa có dữ liệu" — true, and not invented.
  */
  const inspectable =
    inspectionEnabled() && (issue.attempts.some((a) => a.outcomeAt === null) || issue.acceptedAt !== null);

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.hotelIssue.updateMany({
      where: { id, status: 'IN_PROGRESS' },
      data: {
        status: inspectable ? 'AWAITING_INSPECTION' : 'COMPLETED',
        completedByUserId: actor.id,
        completedByNameSnapshot: actor.fullName,
        completedAt: now,
      },
    });
    if (count === 0) {
      throw ApiError.conflict(
        finishedMessage(issue.status) ?? 'Cần tiếp nhận sự cố trước khi hoàn thành.',
        { status: issue.status },
      );
    }
    await recordAttemptOutcome(tx, id, 'COMPLETED', null, now, issue, { cause, result });
  });

  const updated = await loadIssue(id);
  if (inspectable) await notifyInspectors(updated);
  else await notifyReporterStatus(updated, 'COMPLETED');
  return updated;
}

/**
 * "Nguyên nhân" while the repair is under way — the technician found it and
 * says so before they have finished.
 *
 * WRITTEN TO THE OPEN ATTEMPT, never to the incident: the incident keeps what
 * Reception reported, and this is the technician's determination on THIS
 * attempt. Guarded on the attempt still being open AND the incident still being
 * IN_PROGRESS, in one conditional write, so a finished repair's cause cannot be
 * edited after the fact from here.
 */
export async function updateRepairCause(
  id: string,
  input: { cause: string },
  actor: Actor,
): Promise<IssueDetail> {
  assertTechnicalActor(actor);
  const cause = input.cause.trim();
  if (!cause) throw ApiError.validation('Vui lòng nhập nguyên nhân.');

  const issue = await loadIssue(id);
  const { count } = await prisma.technicalRepairAttempt.updateMany({
    where: { issueId: id, outcomeAt: null, issue: { status: 'IN_PROGRESS' } },
    data: { cause },
  });
  if (count > 0) return loadIssue(id);

  /*
    No open attempt on an incident that IS being repaired: one accepted before
    attempts existed. Its acceptance columns already describe the attempt, so it
    is opened from them — the same rule `recordAttemptOutcome` applies — and the
    cause goes on it. The partial unique index keeps this to one open attempt
    even if two saves race.
  */
  const legacy = issue.status === 'IN_PROGRESS' ? legacyAttemptData(issue) : null;
  if (!legacy) {
    throw ApiError.conflict(
      issue.status === 'IN_PROGRESS'
        ? 'Sự cố này được tiếp nhận trước khi có lịch sử sửa chữa, không có lần sửa để ghi nguyên nhân.'
        : 'Chỉ cập nhật được nguyên nhân khi sự cố đang sửa.',
      { status: issue.status },
    );
  }
  try {
    await prisma.$transaction(async (tx) => {
      // Re-read inside the transaction: a completion that landed since the load
      // must not gain an open attempt after the fact.
      const current = await tx.hotelIssue.findUnique({ where: { id }, select: { status: true } });
      if (current?.status !== 'IN_PROGRESS') {
        throw ApiError.conflict('Chỉ cập nhật được nguyên nhân khi sự cố đang sửa.', { status: current?.status });
      }
      const previous = await tx.technicalRepairAttempt.count({ where: { issueId: id } });
      await tx.technicalRepairAttempt.create({
        data: { issueId: id, attemptNumber: previous + 1, ...legacy, cause },
      });
    });
  } catch (error) {
    if (error instanceof PrismaNS.PrismaClientKnownRequestError && error.code === 'P2002') {
      // Somebody opened it a moment ago; write the cause on that one.
      await prisma.technicalRepairAttempt.updateMany({
        where: { issueId: id, outcomeAt: null },
        data: { cause },
      });
    } else {
      throw error;
    }
  }
  return loadIssue(id);
}

export interface InspectIssueInput {
  result: InspectionResult;
  /** Optional on a pass; REQUIRED on a fail — it is the rework instruction. */
  note?: string | null;
}

/**
 * AWAITING_INSPECTION → COMPLETED ("Nghiệm thu đạt")
 *                     → NEW       ("Không đạt / Yêu cầu sửa lại").
 *
 * THE VERDICT IS STAMPED ON THE ATTEMPT IT JUDGES, and that attempt is otherwise
 * left exactly as the technician closed it: its outcome, cause and result stay
 * what they were. A failed inspection does not rewrite the repair — it records
 * that the repair was not good enough, and why.
 *
 * A FAIL SENDS THE INCIDENT BACK TO THE QUEUE, like "Không sửa được": NEW, with
 * the current-assignment columns cleared. The next "Tiếp nhận" then opens a NEW
 * attempt (Lần 2), so the first repair, its inspection and the second repair are
 * three separate, permanent facts rather than one row edited three times.
 *
 * Both outcomes are conditional writes on AWAITING_INSPECTION, so two managers
 * judging the same repair at once produce one verdict and one 409.
 */
export async function inspectIssue(
  id: string,
  input: InspectIssueInput,
  actor: Actor,
  clock: Clock = getClock(),
): Promise<IssueDetail> {
  assertInspector(actor);
  if (!inspectionEnabled()) {
    // Dormant: the code is here for the day it is switched on, and until then
    // no verdict may change an incident's state.
    throw ApiError.forbidden('Chức năng nghiệm thu chưa được kích hoạt.');
  }

  const note = optionalText(input.note);
  if (input.result === 'FAILED' && !note) {
    throw ApiError.validation('Vui lòng nhập lý do không đạt.');
  }

  const issue = await loadIssue(id);
  const now = clock.now();

  await prisma.$transaction(async (tx) => {
    // The incident first, then the attempt — the lock order every other
    // transition uses, so no pair of them can deadlock.
    const { count } = await tx.hotelIssue.updateMany({
      where: { id, status: 'AWAITING_INSPECTION' },
      data:
        input.result === 'PASSED'
          ? { status: 'COMPLETED' }
          : {
              status: 'NEW',
              acceptedByUserId: null,
              acceptedByNameSnapshot: null,
              acceptedAt: null,
              technicianName: null,
              technicianPhone: null,
              completedByUserId: null,
              completedByNameSnapshot: null,
              completedAt: null,
            },
    });
    if (count === 0) {
      throw ApiError.conflict(
        issue.status === 'COMPLETED'
          ? 'Sự cố này đã được nghiệm thu trước đó.'
          : 'Sự cố này chưa ở trạng thái chờ nghiệm thu.',
        { status: issue.status },
      );
    }

    const judged = await tx.technicalRepairAttempt.findFirst({
      where: { issueId: id, outcome: 'COMPLETED', inspectionResult: null },
      orderBy: { attemptNumber: 'desc' },
      select: { id: true },
    });
    const stamped = judged
      ? await tx.technicalRepairAttempt.updateMany({
          where: { id: judged.id, inspectionResult: null },
          data: {
            inspectionResult: input.result,
            inspectedByUserId: actor.id,
            inspectedByNameSnapshot: actor.fullName,
            inspectedAt: now,
            inspectionNote: note,
          },
        })
      : { count: 0 };
    // Rolls the status change back with it: a verdict with nothing to attach
    // to is not recorded as if it had been.
    if (stamped.count === 0) {
      throw ApiError.conflict('Không tìm thấy lần sửa chờ nghiệm thu.', { status: issue.status });
    }
  });

  const updated = await loadIssue(id);
  if (input.result === 'PASSED') {
    await notifyReporterStatus(updated, 'COMPLETED');
  } else {
    await notifyTechniciansRework(updated, note!);
  }
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
 *
 * `findings` is the technician's cause and result, written with the outcome in
 * the same statement — they describe this attempt and no other.
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
  findings: { cause: string | null; result: string | null } = { cause: null, result: null },
): Promise<void> {
  const { count } = await tx.technicalRepairAttempt.updateMany({
    where: { issueId, outcomeAt: null },
    data: {
      outcome,
      outcomeAt: at,
      reason,
      result: findings.result,
      // An empty cause at completion leaves the one recorded during the repair
      // ("Cập nhật nguyên nhân") in place rather than wiping it.
      ...(findings.cause !== null ? { cause: findings.cause } : {}),
    },
  });
  if (count > 0) return;

  // Nothing open. Only worth recording if the incident says when somebody took
  // it on — otherwise there is genuinely no work to record and no columns to lose.
  const legacy = legacyAttemptData(accepted);
  if (!legacy) return;

  const previous = await tx.technicalRepairAttempt.count({ where: { issueId } });
  await tx.technicalRepairAttempt.create({
    data: {
      issueId,
      attemptNumber: previous + 1,
      ...legacy,
      outcome,
      outcomeAt: at,
      reason,
      cause: findings.cause,
      result: findings.result,
    },
  });
}

/**
 * The attempt an incident accepted BEFORE attempts existed already describes,
 * rebuilt from its own columns — or null when it records no acceptance at all.
 *
 * Every value comes from what the acceptance wrote. The acceptance TIME is the
 * one thing that cannot be stood in for: without it there is no honest start to
 * the repair, so there is no attempt. A missing name or phone is recorded as
 * "—" (not known) rather than borrowed from somebody else.
 */
function legacyAttemptData(accepted: {
  technicianName: string | null;
  technicianPhone: string | null;
  acceptedByNameSnapshot: string | null;
  acceptedByUserId: number | null;
  acceptedAt: Date | null;
}) {
  if (!accepted.acceptedAt) return null;
  return {
    technicianUserId: accepted.acceptedByUserId,
    technicianNameSnapshot: accepted.technicianName ?? '—',
    // Phone is NOT NULL on the attempt; an old row could in principle lack it.
    technicianPhone: accepted.technicianPhone ?? '—',
    acceptedByNameSnapshot: accepted.acceptedByNameSnapshot,
    acceptedAt: accepted.acceptedAt,
  };
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
        issue.status === 'COMPLETED' || issue.status === 'AWAITING_INSPECTION'
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

/**
 * A finished repair is work waiting for "Quản lý kỹ thuật", so every active one
 * is told. The reporter is NOT told yet: to them the incident is done when it
 * passes inspection, and a "hoàn thành" that is later failed would be a promise
 * the hotel took back.
 */
async function notifyInspectors(issue: IssueDetail): Promise<void> {
  const managers = await prisma.user.findMany({
    where: { role: 'TECHNICAL_MANAGER', active: true },
    select: { id: true },
  });
  if (managers.length === 0) return;
  await prisma.notification.createMany({
    data: managers.map((m) => ({
      userId: m.id,
      title: 'Sự cố chờ nghiệm thu',
      body: `${describeLocation(issue)} — ${issue.branch.address}`,
    })),
  });
}

/** A failed inspection is work for Bộ phận kỹ thuật again — with the reason. */
async function notifyTechniciansRework(issue: IssueDetail, reason: string): Promise<void> {
  const technicians = await prisma.user.findMany({
    where: { role: 'TECHNICAL', active: true },
    select: { id: true },
  });
  if (technicians.length === 0) return;
  await prisma.notification.createMany({
    data: technicians.map((t) => ({
      userId: t.id,
      title: 'Sự cố cần sửa lại',
      body: `${describeLocation(issue)} — ${reason}`,
    })),
  });
}

export interface ListIssuesFilter {
  branchId?: number;
  status?: IssueStatus;
  /** Narrower than `status`: tells a fresh report from one sent back. */
  stage?: IssueStage;
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
  /**
   * The 12-hour completion rule (`completionArchive.ts`), by the server clock:
   * 'active' = outstanding at any age, or finished and reported < 12 hours ago;
   * 'archive' = finished and reported ≥ 12 hours ago ("Hoàn thành vấn đề").
   * Like `outstanding`, it ignores the period.
   */
  scope?: 'active' | 'archive';
  /**
   * Half-open [completedFrom, completedTo) over `completedAt` — the instant the
   * technician finished the repair. Technical's "Đã hoàn thành" asks "what did
   * we finish this week?", which is a question about completion, not report.
   * Intersects with everything above; an unfinished incident never matches.
   */
  completedFrom?: Date;
  completedTo?: Date;
  now?: Date;
  skip: number;
  take: number;
}

/**
 * Lists issues newest-first.
 *
 * VISIBILITY, BY ROLE:
 *   RECEPTIONIST       their own branch only, and a client-sent branchId is
 *                      IGNORED rather than refused — the scope is not theirs.
 *   TECHNICAL          all eight branches, optionally narrowed by `branchId`.
 *   TECHNICAL_MANAGER  all eight branches, optionally narrowed by `branchId`.
 *   ADMIN              all eight branches, optionally narrowed by `branchId`.
 */
export async function listIssues(actor: Actor, filter: ListIssuesFilter): Promise<{ issues: IssueDetail[]; total: number }> {
  let where: Prisma.HotelIssueWhereInput = {};
  if (actor.role === 'RECEPTIONIST') {
    where.branchId = actor.branchId ?? -1; // -1 never matches → an unassigned receptionist sees nothing
  } else if (filter.branchId !== undefined) {
    where.branchId = filter.branchId;
  }
  if (filter.status) where.status = filter.status;
  if (filter.stage) where = { ...where, ...stageWhere(filter.stage) };
  if (filter.areaCategory) where.areaCategory = filter.areaCategory;

  if (filter.scope) {
    const now = filter.now ?? getClock().now();
    delete where.status;
    delete where.attempts;
    where = { ...where, AND: [filter.scope === 'active' ? activeIssueWhere(now) : archivedIssueWhere(now)] };
    /*
      A PERIOD NARROWS THE SCOPE, it never replaces it: "Hoàn thành vấn đề" by
      the days the incidents were REPORTED on. The 12-hour rule above still
      decides eligibility; this only intersects with it.
    */
    if (filter.from || filter.to) {
      where.createdAt = {
        ...(filter.from ? { gte: filter.from } : {}),
        ...(filter.to ? { lt: filter.to } : {}),
      };
    }
  } else if (filter.outstanding) {
    // Overrides an explicit status rather than intersecting with it: "tồn đọng"
    // IS a status set, and `outstanding + status=COMPLETED` is a contradiction
    // that would silently return nothing.
    where.status = { in: outstandingStatuses() };
    delete where.attempts;
  } else if (filter.from || filter.to) {
    where.createdAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lt: filter.to } : {}),
    };
  }
  if (filter.completedFrom || filter.completedTo) {
    where.completedAt = {
      ...(filter.completedFrom ? { gte: filter.completedFrom } : {}),
      ...(filter.completedTo ? { lt: filter.completedTo } : {}),
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
