import type {
  InspectionResult,
  IssueAreaCategory,
  IssueAreaSubtype,
  IssueCategory,
  IssueSeverity,
  IssueStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { Prisma as PrismaNS } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { parseCompletionVerdict, verdictWhere } from '../completion/verdict';
import { issuePeriodWhere, type ReportPeriod } from '../reception/businessDate';
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
  type NormalisedArea,
} from './issueArea';
import { activeIssueWhere, archivedIssueWhere } from '../reception/completionArchive';
import {
  assertBranchInScope,
  branchScopeOf,
  isReceptionSupervisor,
  isTechnicalAssigner,
  scopeIncludes,
  scopedBranchFilter,
  supervisorSourceLabel,
} from '../auth/branchScope';
import { catalogFloor, catalogRoom } from '../room/branchRooms';
import { notifyOperational } from '../push/pushService';
import { DEFAULT_SEVERITY, SEVERITY_FIRST, SEVERITY_LABELS, parseSeverity, prioritise, severityLabel } from './severity';
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
// `managedBranchIds` is a Quản lý lễ tân's scope (see auth/branchScope.ts).
type Actor = {
  id: number;
  role: UserRole;
  branchId: number | null;
  fullName: string;
  managedBranchIds?: readonly number[];
};

/**
 * WHO SEES WHICH INCIDENTS — one predicate, applied IN THE DATABASE by every read.
 *
 *   RECEPTIONIST        its own branch.
 *   ADMIN, TỔNG QUẢN LÝ every branch (optionally narrowed by the request).
 *   QUẢN LÝ LỄ TÂN      its assigned branches only.
 *   QUẢN LÝ KỸ THUẬT    its assigned branches only (every incident there).
 *   TECHNICAL           ONLY its own work: incidents assigned to it now, and the
 *                       ones it accepted, attempted or was ever assigned — its
 *                       personal history. NOT inferred from branch visibility.
 *   anyone else         refused.
 */
export function issueVisibilityWhere(actor: Actor, requestedBranchId?: number): Prisma.HotelIssueWhereInput {
  switch (actor.role) {
    case 'RECEPTIONIST':
      return { branchId: actor.branchId ?? -1 };
    case 'ADMIN':
    case 'RECEPTION_GENERAL_MANAGER':
    case 'RECEPTION_MANAGER':
    case 'TECHNICAL_MANAGER':
      return scopedBranchFilter(actor, requestedBranchId);
    case 'TECHNICAL':
      return {
        ...(requestedBranchId !== undefined ? { branchId: requestedBranchId } : {}),
        OR: technicianHistoryWhere(actor.id),
      };
    default:
      throw ApiError.forbidden('Bạn không có quyền xem sự cố.');
  }
}

/**
 * "XÓA" IS A VOID. A deleted incident keeps its row, attempts, assignments and
 * stages — the history and every reference to it — and leaves the operational
 * world: every list, count, queue, duplicate check and report reads through this.
 */
export const LIVE_ISSUE = { voidedAt: null } satisfies Prisma.HotelIssueWhereInput;

/** Everything a technician has touched: assigned now, accepted, attempted, or ever assigned. */
export function technicianHistoryWhere(userId: number): Prisma.HotelIssueWhereInput[] {
  return [
    { assignedTechnicianUserId: userId },
    { acceptedByUserId: userId },
    { completedByUserId: userId },
    { attempts: { some: { technicianUserId: userId } } },
    { assignments: { some: { technicianUserId: userId } } },
  ];
}

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
  /// Oldest first: what a receptionist corrected after the report was filed.
  edits: { orderBy: { createdAt: 'asc' } },
  shiftSession: { select: { id: true, shiftType: true, receptionistName: true } },
  /// Oldest first: every assignment and reassignment.
  assignments: { orderBy: { createdAt: 'asc' } },
  /// Oldest first: the repair, stage by stage ("Giai đoạn 1", "Giai đoạn 2", …).
  stages: { orderBy: { stageNumber: 'asc' } },
  /// The likely-repeat link: the earlier completed incident and who finished it.
  repeatOf: {
    select: {
      id: true,
      description: true,
      createdAt: true,
      completedAt: true,
      completedByNameSnapshot: true,
      attempts: {
        where: { outcome: 'COMPLETED' },
        orderBy: { attemptNumber: 'desc' },
        take: 1,
        select: { technicianNameSnapshot: true, outcomeAt: true },
      },
      // What was done last time, stage by stage — read when the fault comes back.
      stages: {
        orderBy: { stageNumber: 'asc' },
        select: { stageNumber: true, workDone: true, nextWork: true, completedAt: true, technicianNameSnapshot: true, final: true },
      },
    },
  },
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

/** The words for an edited column, so the screen never prints a raw column name. */
const EDIT_FIELD_LABELS: Record<string, string> = {
  description: 'Mô tả sự cố',
  areaCategory: 'Khu vực',
  roomNumber: 'Số phòng',
  floorNumber: 'Số tầng',
  areaSubtype: 'Loại vị trí',
  locationDetail: 'Vị trí cụ thể',
  category: 'Loại sự cố',
  severity: 'Mức độ',
};

/** An enum-valued column's old/new value, as a person reads it. */
function editValueLabel(field: string, value: string | null): string | null {
  if (value === null) return null;
  if (field === 'areaCategory') return ISSUE_AREA_LABELS[value as keyof typeof ISSUE_AREA_LABELS] ?? value;
  if (field === 'areaSubtype') {
    return ISSUE_AREA_SUBTYPE_LABELS[value as keyof typeof ISSUE_AREA_SUBTYPE_LABELS] ?? value;
  }
  if (field === 'category') return ISSUE_CATEGORY_LABELS[value as IssueCategory] ?? value;
  if (field === 'severity') return SEVERITY_LABELS[value as IssueSeverity] ?? value;
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
    /** "Mức độ"; null ("Chưa phân mức") only on incidents reported before it existed. */
    severity: issue.severity,
    severityLabel: severityLabel(issue.severity),
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
    /** Every correction made after the report was filed, oldest first. */
    edits: issue.edits.map(serializeIssueEdit),
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

    /** Who holds the job NOW (null: unassigned, or waiting to be reassigned). */
    assignedTechnician: issue.assignedTechnicianUserId
      ? { id: issue.assignedTechnicianUserId, name: issue.assignedTechnicianNameSnapshot ?? '—' }
      : null,
    assignedAt: issue.assignedAt ? issue.assignedAt.toISOString() : null,
    assignedByName: issue.assignedByNameSnapshot,
    /** Every assignment, oldest first — reassignments name who had it before. */
    assignments: issue.assignments.map((a) => ({
      id: a.id,
      technicianId: a.technicianUserId,
      technicianName: a.technicianNameSnapshot,
      previousTechnicianName: a.previousTechnicianNameSnapshot,
      reassigned: a.previousTechnicianUserId !== null,
      assignedByName: a.assignedByNameSnapshot,
      assignedByRole: a.assignedByRole,
      createdAt: a.createdAt.toISOString(),
      /** "Chuyển về chờ giao kỹ thuật": who took it back, and when. */
      returnedAt: a.returnedAt ? a.returnedAt.toISOString() : null,
      returnedByName: a.returnedByNameSnapshot,
    })),
    ...assignmentState(issue, cannotRepairCount),
    /** The repair, stage by stage, oldest first — never overwritten. */
    stages: issue.stages.map(serializeStage),
    /**
     * The stage under way while the repair is being worked ("Giai đoạn N đang
     * thực hiện") — the next number after the stages already finished.
     */
    currentStageNumber: issue.status === 'IN_PROGRESS' ? issue.stages.length + 1 : null,
    /** "Đúng" / "Sai" from "Hoàn thành" — null before it, and on older completions. */
    reportVerdict: issue.reportVerdict,
    incorrectReason: issue.incorrectReason,
    /** "Xóa": the void, as the journal records one. */
    voided: issue.voidedAt !== null,
    voidedAt: issue.voidedAt ? issue.voidedAt.toISOString() : null,
    voidedByName: issue.voidedByNameSnapshot,
    voidReason: issue.voidReason,
    /** The reporter's role, and "Admin tạo" when a supervisor filed it. */
    reportedByRole: issue.reportedByRole,
    sourceLabel: supervisorSourceLabel(issue.reportedByRole),
    /**
     * "Báo lại sau lần hoàn thành trước" — the earlier completed incident at the
     * same room with the same fault, when there is one. A neutral fact.
     */
    repeatOf: issue.repeatOf
      ? {
          id: issue.repeatOf.id,
          description: issue.repeatOf.description,
          reportedAt: issue.repeatOf.createdAt.toISOString(),
          completedAt: issue.repeatOf.completedAt ? issue.repeatOf.completedAt.toISOString() : null,
          technicianName:
            issue.repeatOf.attempts[0]?.technicianNameSnapshot ?? issue.repeatOf.completedByNameSnapshot ?? null,
          /** What was done last time, stage by stage. */
          stages: issue.repeatOf.stages.map((st) => ({
            stageNumber: st.stageNumber,
            workDone: st.workDone,
            nextWork: st.nextWork,
            completedAt: st.completedAt.toISOString(),
            technicianName: st.technicianNameSnapshot,
            final: st.final,
          })),
        }
      : null,

    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
  };
}

/** One repair stage, as every screen and export reads it. */
export function serializeStage(stage: IssueDetail['stages'][number]) {
  return {
    id: stage.id,
    stageNumber: stage.stageNumber,
    technicianName: stage.technicianNameSnapshot,
    startedAt: stage.startedAt.toISOString(),
    completedAt: stage.completedAt.toISOString(),
    workDone: stage.workDone,
    nextWork: stage.nextWork,
    final: stage.final,
  };
}

/**
 * WHERE THE JOB STANDS, in the assignment model's own words — one state, so no
 * screen assembles it from four columns and gets it slightly wrong.
 */
export type AssignmentState =
  | 'UNASSIGNED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'AWAITING_REASSIGNMENT'
  | 'AWAITING_INSPECTION'
  | 'COMPLETED';

export const ASSIGNMENT_STATE_LABELS: Record<AssignmentState, string> = {
  UNASSIGNED: 'Chưa giao kỹ thuật',
  ASSIGNED: 'Đã giao — chờ tiếp nhận',
  IN_PROGRESS: 'Đang sửa',
  AWAITING_REASSIGNMENT: 'Không sửa được — chờ giao lại',
  AWAITING_INSPECTION: 'Chờ nghiệm thu',
  COMPLETED: 'Đã hoàn thành',
};

function assignmentState(
  issue: Pick<IssueDetail, 'status' | 'assignedTechnicianUserId' | 'attempts'>,
  cannotRepairCount: number,
): { assignmentState: AssignmentState; assignmentStateLabel: string } {
  let state: AssignmentState;
  if (issue.status === 'COMPLETED') state = 'COMPLETED';
  else if (issue.status === 'AWAITING_INSPECTION') state = 'AWAITING_INSPECTION';
  else if (issue.status === 'IN_PROGRESS') state = 'IN_PROGRESS';
  else if (issue.assignedTechnicianUserId !== null) state = 'ASSIGNED';
  else if (cannotRepairCount > 0 && issue.attempts.at(-1)?.outcome === 'CANNOT_REPAIR') {
    state = 'AWAITING_REASSIGNMENT';
  } else state = 'UNASSIGNED';
  return { assignmentState: state, assignmentStateLabel: ASSIGNMENT_STATE_LABELS[state] };
}

async function loadIssue(id: string): Promise<IssueDetail> {
  const issue = await prisma.hotelIssue.findUnique({ where: { id }, include: ISSUE_INCLUDE });
  // A deleted ("Xóa") incident is gone from every operational action.
  if (!issue || issue.voidedAt) throw ApiError.notFound('Không tìm thấy báo cáo sự cố.');
  return issue;
}

/**
 * ONE INCIDENT, through the same predicate every list uses (`issueVisibilityWhere`).
 *
 * Evaluated in the database, so a technician asking for an incident that was
 * never theirs is refused exactly as a receptionist asking for another branch's —
 * the two can never drift into two different rules.
 */
async function assertVisible(issue: IssueDetail, actor: Actor): Promise<void> {
  const visible = await prisma.hotelIssue.count({
    where: { AND: [{ id: issue.id }, issueVisibilityWhere(actor)] },
  });
  if (visible === 0) throw ApiError.branchAccessDenied();
}

/**
 * THE TECHNICIAN WORKS ONLY ITS OWN JOB. Assigned to it (to accept), or accepted
 * by it (to finish, record a cause, or give it back) — nothing inferred from a
 * branch, and nothing another technician holds.
 */
function assertOwnJob(issue: IssueDetail, actor: Actor, phase: 'accept' | 'work'): void {
  const mine =
    phase === 'accept'
      ? issue.assignedTechnicianUserId === actor.id
      : issue.acceptedByUserId === actor.id || issue.assignedTechnicianUserId === actor.id;
  if (!mine) {
    throw ApiError.forbidden(
      phase === 'accept'
        ? 'Sự cố này chưa được giao cho bạn.'
        : 'Sự cố này không do bạn phụ trách.',
    );
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
  /** "Mức độ" — Trung bình when omitted. */
  severity?: IssueSeverity;
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
  let branchId: number | null;
  if (actor.role === 'RECEPTIONIST') {
    branchId = actor.branchId;
  } else if (isReceptionSupervisor(actor.role)) {
    // A supervisor names ONE branch of its scope — never "all", never another's.
    branchId = assertBranchInScope(actor, input.branchId);
  } else {
    throw ApiError.forbidden('Bạn không có quyền báo cáo sự cố.');
  }
  if (branchId == null) {
    throw ApiError.validation('Thiếu chi nhánh cho báo cáo sự cố.');
  }
  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch) throw ApiError.validation('Chi nhánh không hợp lệ.');

  // Always mandatory, and trimmed FIRST so "   " is rejected like "".
  const description = input.description.trim();
  if (description.length === 0) throw ApiError.validation('Vui lòng nhập mô tả sự cố.');

  // The area decides which location columns are required, and drops the rest;
  // a room must then be one of THIS branch's rooms (the room catalog).
  const area = normaliseArea(input);
  if (area.roomNumber) area.roomNumber = catalogRoom(branch.code, area.roomNumber);
  if (area.floorNumber) area.floorNumber = catalogFloor(branch.code, area.floorNumber);
  const category = AREA_FIELDS[area.areaCategory].category ? input.category ?? null : null;
  // "Báo lại sau lần hoàn thành trước": the same place and fault, finished recently.
  const repeatOf = await findRecentCompletion(incidentKeyWhere(branchId, area, category));

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
      category,
      severity: input.severity === undefined ? DEFAULT_SEVERITY : parseSeverity(input.severity),
      description,
      // Kept exactly as reported. A technician's later determination is stored
      // on their attempt, never written over this.
      cause: optionalText(input.cause),
      status: 'NEW',
      reportedByUserId: actor.id,
      reportedByNameSnapshot: actor.fullName,
      reportedByRole: actor.role,
      repeatOfIssueId: repeatOf?.id ?? null,
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

/** How far back a completed repair counts as "the previous time" for a repeat. */
export const REPEAT_WINDOW_DAYS = 90;

/**
 * "THE SAME PROBLEM" — ONE STRUCTURED KEY, for the duplicate warning and the
 * repeat link alike: the branch, the area, that area's own location field (the
 * catalog room, the catalog floor, the lobby fixture) and the fault type when
 * the area has one. Never the free text ("Vị trí cụ thể", "Sự cố", "Nguyên
 * nhân") — those are shown beside a match, never used to find one.
 */
export function incidentKeyWhere(
  branchId: number,
  area: Pick<NormalisedArea, 'areaCategory' | 'roomNumber' | 'floorNumber' | 'areaSubtype'>,
  category: IssueCategory | null,
): Prisma.HotelIssueWhereInput {
  const rules = AREA_FIELDS[area.areaCategory];
  return {
    // A deleted incident is neither a duplicate nor a repeat.
    ...LIVE_ISSUE,
    branchId,
    areaCategory: area.areaCategory,
    ...(rules.roomNumber ? { roomNumber: area.roomNumber } : {}),
    ...(rules.floorNumber ? { floorNumber: area.floorNumber } : {}),
    ...(rules.areaSubtype ? { areaSubtype: area.areaSubtype } : {}),
    ...(rules.category && category ? { category } : {}),
  };
}

/**
 * The most recent completed incident with the same key — the deterministic
 * repeat rule: same place, same fault, finished within `REPEAT_WINDOW_DAYS`.
 * No text matching, no scoring.
 */
async function findRecentCompletion(
  key: Prisma.HotelIssueWhereInput,
  now: Date = getClock().now(),
): Promise<{ id: string } | null> {
  const since = new Date(now.getTime() - REPEAT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return prisma.hotelIssue.findFirst({
    where: { ...key, status: { in: ['COMPLETED', 'AWAITING_INSPECTION'] }, completedAt: { gte: since } },
    orderBy: { completedAt: 'desc' },
    select: { id: true },
  });
}

/**
 * "IS THIS ALREADY REPORTED?" — for the report form's warning, never a block.
 *
 * `open`: incidents at the same room (and fault type, when given) that nobody
 * has finished — the likely duplicates. `recent`: the ones finished within the
 * repeat window — a new report would be a repeat of these. Read through the
 * caller's own visibility, so a supervisor sees only its branches.
 */
export async function findSimilarIssues(
  actor: Actor,
  q: {
    branchId?: number;
    /** Defaults to "Phòng" — the form's first and most common area. */
    areaCategory?: IssueAreaCategory;
    roomNumber?: string;
    floorNumber?: string;
    areaSubtype?: IssueAreaSubtype;
    category?: IssueCategory;
  },
): Promise<{ open: IssueDetail[]; recent: IssueDetail[] }> {
  const branchId = actor.role === 'RECEPTIONIST' ? actor.branchId ?? -1 : q.branchId;
  if (branchId === undefined) throw ApiError.validation('Vui lòng chọn chi nhánh.');
  const areaCategory = q.areaCategory ?? 'ROOM';
  const rules = AREA_FIELDS[areaCategory];
  // The key's own location field must be there — "every room" is not a match.
  const location = {
    roomNumber: q.roomNumber?.trim() || null,
    floorNumber: q.floorNumber?.trim() || null,
    areaSubtype: q.areaSubtype ?? null,
  };
  if ((rules.roomNumber && !location.roomNumber) || (rules.floorNumber && !location.floorNumber) || (rules.areaSubtype && !location.areaSubtype)) {
    return { open: [], recent: [] };
  }
  const base: Prisma.HotelIssueWhereInput = {
    AND: [issueVisibilityWhere(actor, actor.role === 'RECEPTIONIST' ? undefined : branchId)],
    ...incidentKeyWhere(branchId, { areaCategory, ...location }, q.category ?? null),
  };
  const since = new Date(getClock().now().getTime() - REPEAT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [open, recent] = await Promise.all([
    prisma.hotelIssue.findMany({
      where: { ...base, status: { in: outstandingStatuses() } },
      include: ISSUE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.hotelIssue.findMany({
      where: { ...base, status: { in: ['COMPLETED', 'AWAITING_INSPECTION'] }, completedAt: { gte: since } },
      include: ISSUE_INCLUDE,
      orderBy: { completedAt: 'desc' },
      take: 3,
    }),
  ]);
  return { open, recent };
}

/**
 * A new incident notifies the people who DECIDE who repairs it: every active
 * Admin and Tổng quản lý lễ tân, and the Quản lý lễ tân of that branch.
 * Technicians are NOT told of every report any more — a technician sees only
 * what is assigned to them, and is told at assignment (`assignIssue`).
 */
async function notifyNewIssue(branchAddress: string, issue: IssueDetail): Promise<void> {
  const recipients = await prisma.user.findMany({
    where: {
      active: true,
      OR: [
        { role: { in: ['ADMIN', 'RECEPTION_GENERAL_MANAGER'] } },
        { role: 'RECEPTION_MANAGER', branchAssignments: { some: { branchId: issue.branchId } } },
        // The Quản lý kỹ thuật of that branch assigns the repair.
        { role: 'TECHNICAL_MANAGER', branchAssignments: { some: { branchId: issue.branchId } } },
      ],
    },
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
  /** "Mức độ" — corrected by whoever may correct the report, and audited. */
  severity?: IssueSeverity;
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
  'severity',
] as const;

/**
 * "SỬA VẤN ĐỀ" — corrects what a report says, without touching how it has gone.
 *
 * WHO: the reception of the incident's own branch, and the Admin. Bộ phận kỹ
 * thuật works incidents, it does not rewrite them, and no other role reports
 * them at all.
 *
 * WHEN: while the incident is open — NEW or IN_PROGRESS, and after a "Không sửa
 * được" too. A finished incident (COMPLETED, or awaiting inspection) is a closed
 * record and is refused.
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
  if (actor.role !== 'RECEPTIONIST' && !isReceptionSupervisor(actor.role)) {
    throw ApiError.forbidden('Chỉ lễ tân hoặc quản lý mới sửa được báo cáo sự cố.');
  }
  const issue = await loadIssue(id);
  await assertVisible(issue, actor);
  // Only an incident somebody can still act on is corrected: once the technician
  // has finished it (awaiting inspection included) the record is what was signed off.
  if (issue.status !== 'NEW' && issue.status !== 'IN_PROGRESS') {
    throw ApiError.conflict('Không thể sửa sự cố đã hoàn thành.', { status: issue.status });
  }

  const supplied = (Object.keys(input) as (keyof UpdateIssueInput)[]).filter(
    (key) => input[key] !== undefined,
  );
  if (supplied.length === 0) throw ApiError.validation('Cần ít nhất một trường để cập nhật.');
  const touchesArea = supplied.some((key) => key !== 'description' && key !== 'category' && key !== 'severity');

  const next: Partial<Record<(typeof EDITABLE_ISSUE_FIELDS)[number], string | null>> = {};

  if (input.severity !== undefined) next.severity = parseSeverity(input.severity);

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

  // A CHANGED room must be one of the branch's rooms; an untouched legacy room
  // (typed before the catalog existed) is never re-judged by a correction.
  if (next.roomNumber && next.roomNumber !== issue.roomNumber) {
    next.roomNumber = catalogRoom(issue.branch.code, next.roomNumber);
  }
  if (next.floorNumber && next.floorNumber !== issue.floorNumber) {
    next.floorNumber = catalogFloor(issue.branch.code, next.floorNumber);
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

/**
 * "GIAO KỸ THUẬT" — give an incident to one technician, or move it to another.
 *
 * WHO: the Admin (every branch), a Tổng quản lý lễ tân (every branch) and a Quản
 * lý lễ tân (its branches) — checked against the incident's branch, not taken
 * from the request.
 *
 * WHEN: while the incident waits (NEW) — unassigned, assigned but not yet
 * accepted, or back after "Không sửa được". A job a technician has already
 * accepted is theirs until they finish it or give it back; reassigning it
 * underneath them would leave an open repair attempt with nobody on it.
 *
 * NOTHING IS OVERWRITTEN THAT MATTERS: the incident's `assigned…` columns are
 * the current assignment, and a `HotelIssueAssignment` row keeps this one —
 * with the previous technician when it is a reassignment — permanently.
 */
export async function assignIssue(
  id: string,
  input: { technicianUserId: number },
  actor: Actor,
  clock: Clock = getClock(),
): Promise<IssueDetail> {
  const [updated] = await assignIssues([id], input, actor, clock);
  return updated!;
}

/**
 * "GIAO KỸ THUẬT" FOR SEVERAL INCIDENTS AT ONCE — a room's chosen subset.
 *
 * Exactly the incidents named, never their room-mates: the dialog lists every
 * waiting incident of the room and the assigner ticks the ones to give. Every
 * incident is checked by the single-incident rule (scope, still waiting, not
 * already this technician's) BEFORE anything is written, then all of them are
 * assigned in ONE transaction — guarded per row on the state that was judged —
 * so the batch lands whole or not at all. One notification names them together.
 */
export async function assignIssues(
  ids: readonly string[],
  input: { technicianUserId: number },
  actor: Actor,
  clock: Clock = getClock(),
): Promise<IssueDetail[]> {
  if (!isTechnicalAssigner(actor.role)) {
    throw ApiError.forbidden('Chỉ Admin, quản lý lễ tân hoặc quản lý kỹ thuật mới giao được kỹ thuật.');
  }
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw ApiError.validation('Vui lòng chọn ít nhất một sự cố.');
  const issues = await Promise.all(unique.map((id) => loadIssue(id)));
  const scope = branchScopeOf(actor);
  for (const issue of issues) {
    if (!scopeIncludes(scope, issue.branchId)) throw ApiError.branchAccessDenied();
    if (issue.status !== 'NEW') {
      throw ApiError.conflict(
        issue.status === 'IN_PROGRESS'
          ? 'Kỹ thuật đang sửa sự cố này, không thể giao lại.'
          : 'Sự cố đã hoàn thành, không thể giao kỹ thuật.',
        { status: issue.status, issueId: issue.id },
      );
    }
  }
  const technician = await prisma.user.findFirst({
    where: { id: input.technicianUserId, role: 'TECHNICAL', active: true },
    select: { id: true, fullName: true },
  });
  if (!technician) throw ApiError.validation('Kỹ thuật viên không hợp lệ hoặc đã ngừng hoạt động.');
  const already = issues.find((i) => i.assignedTechnicianUserId === technician.id);
  if (already) {
    throw ApiError.conflict(
      issues.length === 1
        ? 'Sự cố đã được giao cho kỹ thuật viên này.'
        : `"${already.description}" đã được giao cho kỹ thuật viên này. Bỏ chọn sự cố đó rồi giao lại.`,
    );
  }

  const now = clock.now();
  await prisma.$transaction(async (tx) => {
    for (const issue of issues) {
      // Guarded on the state that was judged above: a technician accepting at the
      // same instant, or another manager reassigning, wins cleanly or loses with a 409.
      const { count } = await tx.hotelIssue.updateMany({
        where: { id: issue.id, ...LIVE_ISSUE, status: 'NEW', assignedTechnicianUserId: issue.assignedTechnicianUserId },
        data: {
          assignedTechnicianUserId: technician.id,
          assignedTechnicianNameSnapshot: technician.fullName,
          assignedAt: now,
          assignedByUserId: actor.id,
          assignedByNameSnapshot: actor.fullName,
        },
      });
      if (count === 0) throw ApiError.conflict('Sự cố vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
      await tx.hotelIssueAssignment.create({
        data: {
          issueId: issue.id,
          technicianUserId: technician.id,
          technicianNameSnapshot: technician.fullName,
          previousTechnicianUserId: issue.assignedTechnicianUserId,
          previousTechnicianNameSnapshot: issue.assignedTechnicianNameSnapshot,
          assignedByUserId: actor.id,
          assignedByNameSnapshot: actor.fullName,
          assignedByRole: actor.role,
          createdAt: now,
        },
      });
    }
  });

  const updated = await Promise.all(unique.map((id) => loadIssue(id)));
  await notifyAssigned(updated, technician.id, now);
  return updated;
}

/**
 * "Công việc kỹ thuật mới" — ONE notice per assignment, to the one technician:
 * "CN 8 · Phòng 206 · Nước nóng" for one incident, "CN 8 · Phòng 206 · 3 vấn đề
 * cần xử lý" for a room's batch, "CN 8 · 3 vấn đề cần xử lý" across places.
 * Shown in the bell and pushed to the technician's devices; keyed by the
 * assignment itself, so it exists once however the request is retried.
 */
async function notifyAssigned(issues: IssueDetail[], technicianUserId: number, assignedAt: Date): Promise<void> {
  const first = issues[0]!;
  const branch = `CN ${first.branch.branchNumber}`;
  // A room is just "Phòng 206"; any other place keeps its full one-line name.
  const place = (i: IssueDetail) =>
    (i.areaCategory === 'ROOM' || !i.areaCategory) && i.roomNumber ? `Phòng ${i.roomNumber}` : describeLocation(i);
  const places = new Set(issues.map(place));
  const what = (i: IssueDetail) =>
    i.category ? ISSUE_CATEGORY_LABELS[i.category] : i.description.length > 40 ? `${i.description.slice(0, 40)}…` : i.description;
  const body =
    issues.length === 1
      ? `${branch} · ${place(first)} · ${what(first)}`
      : places.size === 1
        ? `${branch} · ${place(first)} · ${issues.length} vấn đề cần xử lý`
        : `${branch} · ${issues.length} vấn đề cần xử lý`;
  const ids = issues.map((i) => i.id).sort();
  await notifyOperational([
    {
      userId: technicianUserId,
      kind: 'TECHNICAL_ASSIGNED',
      title: 'Công việc kỹ thuật mới',
      body,
      link: '/app/technical/new',
      dedupeKey: `TECHNICAL_ASSIGNED:${technicianUserId}:${ids[0]}+${ids.length}:${assignedAt.toISOString()}`,
    },
  ]);
}

/**
 * WHO MAY DELETE AN INCIDENT OR TAKE IT BACK FROM A TECHNICIAN: Reception of its
 * branch, and the supervisors (Admin, the two reception managers, Quản lý kỹ
 * thuật) inside their scope. Checked here, on every request — a visible button
 * is never the permission.
 */
function assertIssueManager(issue: IssueDetail, actor: Actor): void {
  if (actor.role === 'RECEPTIONIST') {
    if (actor.branchId !== issue.branchId) throw ApiError.branchAccessDenied();
    return;
  }
  if (isTechnicalAssigner(actor.role)) {
    if (!scopeIncludes(branchScopeOf(actor), issue.branchId)) throw ApiError.branchAccessDenied();
    return;
  }
  throw ApiError.forbidden('Bạn không có quyền thực hiện thao tác này với sự cố.');
}

/**
 * "CHUYỂN VỀ CHỜ GIAO KỸ THUẬT" — an assigned incident the technician has not
 * accepted goes back to the waiting queue. The assignment row stays (who was
 * given it, by whom, when) and is marked as taken back; the incident can be
 * given again. Once accepted, the technician owns the open repair and gives it
 * back with "Không sửa được" — the attempt then records why.
 */
export async function unassignIssue(id: string, actor: Actor, clock: Clock = getClock()): Promise<IssueDetail> {
  const issue = await loadIssue(id);
  assertIssueManager(issue, actor);
  if (issue.status !== 'NEW' || issue.assignedTechnicianUserId === null) {
    throw ApiError.conflict(
      issue.status === 'IN_PROGRESS'
        ? 'Kỹ thuật đã tiếp nhận sự cố này; kỹ thuật viên trả lại bằng "Không sửa được".'
        : issue.status === 'NEW'
          ? 'Sự cố chưa được giao kỹ thuật.'
          : 'Sự cố đã hoàn thành.',
      { status: issue.status },
    );
  }
  const technicianUserId = issue.assignedTechnicianUserId;
  const now = clock.now();
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.hotelIssue.updateMany({
      where: { id, ...LIVE_ISSUE, status: 'NEW', assignedTechnicianUserId: technicianUserId },
      data: {
        assignedTechnicianUserId: null,
        assignedTechnicianNameSnapshot: null,
        assignedAt: null,
        assignedByUserId: null,
        assignedByNameSnapshot: null,
      },
    });
    if (count === 0) throw ApiError.conflict('Sự cố vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
    const current = await tx.hotelIssueAssignment.findFirst({
      where: { issueId: id, technicianUserId, returnedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (current) {
      await tx.hotelIssueAssignment.update({
        where: { id: current.id },
        data: { returnedAt: now, returnedByUserId: actor.id, returnedByNameSnapshot: actor.fullName },
      });
    }
  });
  await prisma.notification.create({
    data: {
      userId: technicianUserId,
      title: 'Sự cố đã được chuyển về chờ giao',
      body: `${describeLocation(issue)} — ${issue.branch.address}: ${issue.description}. Thực hiện bởi ${actor.fullName}.`,
    },
  });
  return loadIssue(id);
}

/**
 * "XÓA" — an open incident leaves every operational list, as a journal entry is
 * voided: the row, its attempts, assignments, stages and edits stay for the
 * record; the journal entries that point at it are voided with it, so the
 * facility journal and the incident never disagree. A finished incident is
 * history and is not deleted.
 */
export async function voidIssue(
  id: string,
  input: { reason?: string | null },
  actor: Actor,
  clock: Clock = getClock(),
): Promise<void> {
  const issue = await loadIssue(id);
  assertIssueManager(issue, actor);
  if (issue.status !== 'NEW' && issue.status !== 'IN_PROGRESS') {
    throw ApiError.conflict('Sự cố đã hoàn thành, không thể xóa.', { status: issue.status });
  }
  const reason = optionalText(input.reason);
  if (reason && reason.length > 1000) throw ApiError.validation('Lý do quá dài.');
  const now = clock.now();
  const holder = issue.acceptedByUserId ?? issue.assignedTechnicianUserId;
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.hotelIssue.updateMany({
      where: { id, ...LIVE_ISSUE, status: { in: ['NEW', 'IN_PROGRESS'] } },
      data: { voidedAt: now, voidedByUserId: actor.id, voidedByNameSnapshot: actor.fullName, voidReason: reason },
    });
    if (count === 0) throw ApiError.conflict('Sự cố vừa được thay đổi ở nơi khác. Vui lòng tải lại.');
    await tx.receptionOperationalReport.updateMany({
      where: { voidedAt: null, facility: { is: { issueId: id } } },
      data: {
        voidedAt: now,
        voidedByUserId: actor.id,
        voidedByNameSnapshot: actor.fullName,
        voidReason: reason ?? 'Sự cố đã bị xóa',
      },
    });
  });
  // The technician holding it is told it is gone, not left looking for it.
  if (holder !== null) {
    await prisma.notification.create({
      data: {
        userId: holder,
        title: 'Sự cố đã bị xóa',
        body: `${describeLocation(issue)} — ${issue.branch.address}: ${issue.description}. Xóa bởi ${actor.fullName}.`,
      },
    });
  }
}

/** The active technicians an incident can be given to — full names, never usernames. */
export async function listAssignableTechnicians(): Promise<{ id: number; fullName: string }[]> {
  return prisma.user.findMany({
    where: { role: 'TECHNICAL', active: true },
    select: { id: true, fullName: true },
    orderBy: { fullName: 'asc' },
  });
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
  // Only the job assigned to THIS technician can be accepted by them.
  assertOwnJob(issue, actor, 'accept');
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
        // Still NEW, and still assigned to this technician — a reassignment that
        // landed a moment ago wins, and this acceptance gets the 409.
        where: { id, status: 'NEW', assignedTechnicianUserId: actor.id },
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
   * the single press it has always been. With "Đúng" this is "Cách xử lý (nếu có)".
   */
  result?: string | null;
  /** "Đúng" / "Sai" — required, the rule every "Hoàn thành" shares. */
  verdict?: 'CORRECT' | 'INCORRECT' | null;
  /** "Lý do báo cáo sai" — required with "Sai". */
  incorrectReason?: string | null;
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

  /*
    "ĐÚNG" OR "SAI" FIRST — the shared rule. "Sai" closes the incident with its
    reason (there is no repair to inspect); "Đúng" carries "Cách xử lý (nếu có)"
    as the repair result, required only while inspection is active.
  */
  const verdict = parseCompletionVerdict({ verdict: input.verdict, resolution: input.result, incorrectReason: input.incorrectReason });
  const incorrect = verdict.reportVerdict === 'INCORRECT';
  const result = incorrect ? `Báo cáo sai: ${verdict.incorrectReason}` : verdict.resolution;
  if (!result && inspectionEnabled()) throw ApiError.validation('Vui lòng nhập kết quả sửa chữa.');
  const cause = optionalText(input.cause);

  const issue = await loadIssue(id);
  assertOwnJob(issue, actor, 'work');
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
    !incorrect &&
    inspectionEnabled() &&
    (issue.attempts.some((a) => a.outcomeAt === null) || issue.acceptedAt !== null);

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.hotelIssue.updateMany({
      where: { id, status: 'IN_PROGRESS' },
      data: {
        status: inspectable ? 'AWAITING_INSPECTION' : 'COMPLETED',
        completedByUserId: actor.id,
        completedByNameSnapshot: actor.fullName,
        completedAt: now,
        reportVerdict: verdict.reportVerdict,
        incorrectReason: verdict.incorrectReason,
      },
    });
    if (count === 0) {
      throw ApiError.conflict(
        finishedMessage(issue.status) ?? 'Cần tiếp nhận sự cố trước khi hoàn thành.',
        { status: issue.status },
      );
    }
    await recordAttemptOutcome(tx, id, 'COMPLETED', null, now, issue, { cause, result });
    // "Đã xử lý xong": the final stage, after any recorded before it.
    await createStage(tx, issue, actor, now, { workDone: result ?? 'Đã xử lý xong', nextWork: null, final: true });
  });

  const updated = await loadIssue(id);
  if (inspectable) await notifyInspectors(updated);
  else await notifyReporterStatus(updated, 'COMPLETED');
  return updated;
}

/** When the next stage began: the previous stage's end, or the current acceptance. */
function nextStageStart(issue: IssueDetail, now: Date): Date {
  const open = issue.attempts.find((a) => a.outcomeAt === null);
  const accepted = open?.acceptedAt ?? issue.acceptedAt ?? null;
  const last = issue.stages.at(-1)?.completedAt ?? null;
  if (accepted && last) return accepted > last ? accepted : last;
  return last ?? accepted ?? now;
}

/** Writes the next stage, numbered in order; a racing second write gets a clean 409. */
async function createStage(
  tx: Prisma.TransactionClient,
  issue: IssueDetail,
  actor: Actor,
  now: Date,
  stage: { workDone: string; nextWork: string | null; final: boolean },
): Promise<void> {
  const stageNumber = (await tx.technicalRepairStage.count({ where: { issueId: issue.id } })) + 1;
  try {
    await tx.technicalRepairStage.create({
      data: {
        issueId: issue.id,
        stageNumber,
        technicianUserId: actor.id,
        technicianNameSnapshot: actor.fullName,
        startedAt: nextStageStart(issue, now),
        completedAt: now,
        ...stage,
      },
    });
  } catch (error) {
    if (error instanceof PrismaNS.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw ApiError.conflict('Giai đoạn này vừa được ghi nhận. Vui lòng tải lại.');
    }
    throw error;
  }
}

export interface RepairStageInput {
  /** "Công việc hoàn thành" in this stage. */
  workDone: string;
  /** "Các công việc cần xử lý tiếp". */
  nextWork: string;
}

/**
 * "ĐANG TRONG QUÁ TRÌNH THEO DÕI THÊM" — the current stage is finished, the
 * repair is NOT: the stage is recorded (numbered after the ones before it) and
 * the incident stays "Đang sửa" for the next stage. Only the technician holding
 * the job, only while it is being worked.
 */
export async function recordRepairStage(
  id: string,
  input: RepairStageInput,
  actor: Actor,
  clock: Clock = getClock(),
): Promise<IssueDetail> {
  assertTechnicalActor(actor);
  const workDone = optionalText(input.workDone);
  const nextWork = optionalText(input.nextWork);
  if (!workDone) throw ApiError.validation('Vui lòng nhập công việc đã hoàn thành.');
  if (!nextWork) throw ApiError.validation('Vui lòng nhập các công việc cần xử lý tiếp.');
  if (workDone.length > 2000 || nextWork.length > 2000) throw ApiError.validation('Nội dung quá dài.');

  const issue = await loadIssue(id);
  assertOwnJob(issue, actor, 'work');
  if (issue.status !== 'IN_PROGRESS') {
    throw ApiError.conflict(finishedMessage(issue.status) ?? 'Cần tiếp nhận sự cố trước khi ghi nhận giai đoạn.', {
      status: issue.status,
    });
  }
  const now = clock.now();
  await prisma.$transaction(async (tx) => {
    // Still being worked — a completion that landed a moment ago wins.
    const still = await tx.hotelIssue.count({ where: { id, status: 'IN_PROGRESS' } });
    if (still === 0) throw ApiError.conflict('Sự cố vừa được cập nhật ở nơi khác. Vui lòng tải lại.');
    await createStage(tx, issue, actor, now, { workDone, nextWork, final: false });
  });
  return loadIssue(id);
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
  assertOwnJob(issue, actor, 'work');
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
  assertOwnJob(issue, actor, 'work');
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
        /*
          THE ASSIGNMENT IS RELEASED: the incident now waits for an Admin or a
          Quản lý lễ tân to give it to someone ("Không sửa được — chờ giao lại").
          Who tried and why stays on the attempt row; who had it stays in
          `HotelIssueAssignment`. Nothing about the failed attempt is lost.
        */
        assignedTechnicianUserId: null,
        assignedTechnicianNameSnapshot: null,
        assignedAt: null,
        assignedByUserId: null,
        assignedByNameSnapshot: null,
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
  await notifySupervisorsReassign(updated, reason);
  return updated;
}

/** The people who can give the job to someone else are told it came back. */
async function notifySupervisorsReassign(issue: IssueDetail, reason: string): Promise<void> {
  const recipients = await prisma.user.findMany({
    where: {
      active: true,
      OR: [
        { role: { in: ['ADMIN', 'RECEPTION_GENERAL_MANAGER'] } },
        { role: 'RECEPTION_MANAGER', branchAssignments: { some: { branchId: issue.branchId } } },
      ],
    },
    select: { id: true },
  });
  if (recipients.length === 0) return;
  await prisma.notification.createMany({
    data: recipients.map((r) => ({
      userId: r.id,
      title: 'Sự cố không sửa được — cần giao lại',
      body: `${describeLocation(issue)} — ${issue.branch.address}: ${reason}`,
    })),
  });
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

/**
 * A failed inspection is work again — for the technician it is still ASSIGNED to
 * (the assignment is kept on a fail), or, when nobody holds it, for nobody here:
 * the supervisors see it waiting in their own lists.
 */
async function notifyTechniciansRework(issue: IssueDetail, reason: string): Promise<void> {
  if (issue.assignedTechnicianUserId === null) return;
  const technicians = await prisma.user.findMany({
    where: { id: issue.assignedTechnicianUserId, role: 'TECHNICAL', active: true },
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
  /** 'UNASSIGNED': waiting incidents nobody holds — the supervisors' to-do list. */
  assignment?: 'UNASSIGNED';
  /** Who holds it now, or worked it (the technical report's "Kỹ thuật viên"). */
  technicianUserId?: number;
  roomNumber?: string;
  floorNumber?: string;
  category?: IssueCategory;
  /**
   * THE SHARED REPORT PERIOD (business dates and an optional shift), resolved by
   * `resolveReportPeriod`. Replaces `from`/`to` when given: an incident filed on
   * Ca C of the 2nd at 01:30 on the 3rd is the 2nd's, like the journal.
   */
  period?: ReportPeriod;
  /** "Hoàn thành vấn đề → Vấn đề báo cáo đúng / sai". */
  verdict?: 'CORRECT' | 'INCORRECT';
  /** "Mức độ" — one level; every level (and "Chưa phân mức") when absent. */
  severity?: IssueSeverity;
  now?: Date;
  skip: number;
  take: number;
}

/**
 * A TECHNICIAN'S QUEUES ARE THEIR OWN. Within the visibility above, each stage
 * narrows to the technician's part in it: waiting = assigned to them, in progress
 * = accepted by them, finished = finished by them. Without a stage the list is
 * their whole personal history (assigned, attempted, reassigned away).
 */
export function technicianStageWhere(userId: number, stage: IssueStage | undefined): Prisma.HotelIssueWhereInput {
  switch (stage) {
    case 'WAITING':
    case 'REWORK':
      return { assignedTechnicianUserId: userId };
    case 'IN_PROGRESS':
      return { acceptedByUserId: userId };
    case 'AWAITING_INSPECTION':
    case 'COMPLETED':
      return { completedByUserId: userId };
    default:
      return {};
  }
}

/**
 * Lists issues newest-first.
 *
 * VISIBILITY, BY ROLE: `issueVisibilityWhere` — a receptionist its branch (a
 * client-sent branchId is IGNORED, the scope is not theirs), a supervisor its
 * scope, a technician only its own work, the technical manager everything.
 */
export async function listIssues(actor: Actor, filter: ListIssuesFilter): Promise<{ issues: IssueDetail[]; total: number }> {
  let where: Prisma.HotelIssueWhereInput = {
    AND: [issueVisibilityWhere(actor, actor.role === 'RECEPTIONIST' ? undefined : filter.branchId), LIVE_ISSUE],
  };
  if (filter.period) (where.AND as Prisma.HotelIssueWhereInput[]).push(issuePeriodWhere(filter.period));
  if (filter.verdict) (where.AND as Prisma.HotelIssueWhereInput[]).push(verdictWhere(filter.verdict));
  if (actor.role === 'TECHNICAL') {
    (where.AND as Prisma.HotelIssueWhereInput[]).push(technicianStageWhere(actor.id, filter.stage));
  }
  if (filter.assignment === 'UNASSIGNED') {
    (where.AND as Prisma.HotelIssueWhereInput[]).push({ status: 'NEW', assignedTechnicianUserId: null });
  }
  if (filter.technicianUserId !== undefined) {
    (where.AND as Prisma.HotelIssueWhereInput[]).push({ OR: technicianHistoryWhere(filter.technicianUserId) });
  }
  if (filter.roomNumber) where.roomNumber = filter.roomNumber;
  if (filter.floorNumber) where.floorNumber = filter.floorNumber;
  if (filter.category) where.category = filter.category;
  if (filter.severity) where.severity = filter.severity;
  if (filter.status) where.status = filter.status;
  if (filter.stage) where = { ...where, ...stageWhere(filter.stage) };
  if (filter.areaCategory) where.areaCategory = filter.areaCategory;

  if (filter.scope) {
    const now = filter.now ?? getClock().now();
    delete where.status;
    delete where.attempts;
    // APPENDED to AND, never assigned over it: AND already carries the visibility
    // clause, and replacing it would widen the list to every branch.
    where = {
      ...where,
      AND: [
        ...(where.AND as Prisma.HotelIssueWhereInput[]),
        filter.scope === 'active' ? activeIssueWhere(now) : archivedIssueWhere(now),
      ],
    };
    /*
      A PERIOD NARROWS THE SCOPE, it never replaces it: "Hoàn thành vấn đề" by
      the days the incidents were REPORTED on. The 12-hour rule above still
      decides eligibility; this only intersects with it.
    */
    if (!filter.period && (filter.from || filter.to)) {
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
  } else if (!filter.period && (filter.from || filter.to)) {
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

  /*
    THE DEFAULT ORDER PUTS WHAT NEEDS ATTENTION FIRST. A queue of unresolved work
    is ordered by level in the database (Cao → Trung bình → Thấp → Chưa phân
    mức, newest first within one), so its pages keep that order. A mixed list
    (the active board, a report period) keeps its newest-first page and then
    lifts its unresolved incidents to the top by level. Completed lists and the
    archive keep their date order untouched.
  */
  const order = issueListOrder(filter);
  const [total, rows] = await prisma.$transaction([
    prisma.hotelIssue.count({ where }),
    prisma.hotelIssue.findMany({
      where,
      include: ISSUE_INCLUDE,
      orderBy: order === 'OPEN_ONLY' ? [...SEVERITY_FIRST] : { createdAt: 'desc' },
      skip: filter.skip,
      take: filter.take,
    }),
  ]);
  const unresolved = new Set<IssueStatus>(outstandingStatuses());
  const issues =
    order === 'MIXED'
      ? prioritise(rows, (i) => unresolved.has(i.status), (i) => i.severity, (i) => i.createdAt)
      : rows;
  return { issues, total };
}

/**
 * Which order a list is read in: only unresolved work (by level, in the
 * database), finished work only (by date), or a mix (by level, then date).
 */
function issueListOrder(filter: ListIssuesFilter): 'OPEN_ONLY' | 'HISTORY' | 'MIXED' {
  const finished = new Set<string>(['COMPLETED', 'AWAITING_INSPECTION']);
  if (
    filter.scope === 'archive' ||
    filter.verdict ||
    filter.completedFrom ||
    filter.completedTo ||
    (filter.status && finished.has(filter.status)) ||
    (filter.stage && finished.has(filter.stage))
  ) {
    return 'HISTORY';
  }
  if (filter.outstanding || filter.assignment === 'UNASSIGNED' || filter.status || filter.stage) return 'OPEN_ONLY';
  return 'MIXED';
}

export async function getIssue(id: string, actor: Actor): Promise<IssueDetail> {
  const issue = await loadIssue(id);
  await assertVisible(issue, actor);
  return issue;
}

/** Authorises an issue-photo request and returns what the file endpoint needs. */
export async function authorizeIssuePhoto(id: string, actor: Actor): Promise<{ storedFileName: string; mimeType: string }> {
  const issue = await prisma.hotelIssue.findUnique({
    where: { id },
    select: { photoStoredName: true, photoMimeType: true, branchId: true },
  });
  if (!issue || !issue.photoStoredName) throw ApiError.notFound('Không tìm thấy ảnh.');
  // The same visibility as the incident itself — a technician sees its own jobs' photos.
  const visible = await prisma.hotelIssue.count({ where: { AND: [{ id }, issueVisibilityWhere(actor)] } });
  if (visible === 0) throw ApiError.branchAccessDenied();
  return { storedFileName: issue.photoStoredName, mimeType: issue.photoMimeType ?? 'image/jpeg' };
}
