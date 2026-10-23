/**
 * THE RECEPTION OPERATIONAL JOURNAL — "Báo cáo vấn đề".
 *
 * WHAT MAKES THIS DIFFERENT FROM A SET OF FORMS
 *
 * Every record here belongs to a SHIFT. Not to a user, not to a day — to the
 * specific eight or twelve hours one named person was standing at one branch's
 * desk. That is the whole accountability model: the branch, the shift, the shift
 * type and the receptionist's name are read from the actor's OPEN SESSION and
 * written onto the row by the server, and the request body is never consulted
 * for any of them. A browser cannot claim to be a different employee, a
 * different branch or a different shift, because it is never asked.
 *
 * WHY A CLOSED SHIFT CANNOT WRITE
 *
 * `requireOpenSession` refuses with SHIFT_CHECK_IN_REQUIRED. Once "Kết thúc ca"
 * closes the session there is no open one, so the next record cannot attach to
 * the shift that just ended — it waits for the next receptionist to check in and
 * attaches to theirs. That is what stops a shift's journal from continuing to
 * grow after the person who owned it went home.
 *
 * NOTHING IS DELETED, AND FINANCIAL ROWS ARE NOT EVEN HIDDEN
 *
 * A wrong record is CORRECTED — the new value goes on the row, the old one goes
 * into `ReceptionReportAudit`, and both are visible to the Admin — or VOIDED,
 * which drops it out of every total while leaving it fully readable with the
 * reason, the person and the instant attached. There is no code path in this
 * file, or in the routes above it, that calls `delete` on a report.
 */
import type { HotelDeliveryDepartment, IssueSeverity, Prisma, PrismaClient, ReportDepartment, ReportVerdict, ShiftType, UserRole } from '@prisma/client';
import { Prisma as PrismaNS } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { parseCompletionVerdict, verdictWhere, type CompletionVerdictInput } from '../completion/verdict';
import { journalPeriodWhere, sessionsForBusinessDates, type ReportPeriod } from './businessDate';
import { getClock, hcmDateOnly, hcmWallClockToUtc, type Clock } from '../lib/clock';
import { requireOpenSession, type ShiftActor } from '../shift/shiftService';
import { shiftBoundaries, shiftBusinessDate, shiftDefinition, shiftWindowLabel } from '../shift/shiftTypes';
import { ISSUE_INCLUDE, createIssue, serializeIssue, type CreateIssueInput, type IssueDetail } from '../issue/issueService';
import { describeLocation } from '../issue/issueArea';
import { DEFAULT_SEVERITY, SEVERITY_LABELS, parseSeverity, prioritise, severityLabel } from '../issue/severity';
import {
  ACTIVE_PAGE_SIZE,
  ARCHIVE_PAGE_SIZE,
  ARCHIVABLE_CATEGORIES,
  activeJournalWhere,
  archiveCutoff,
  archivedJournalWhere,
} from './completionArchive';
import {
  CATEGORY_LABELS,
  DELIVERY_DEPARTMENTS,
  DELIVERY_DEPARTMENT_LABELS,
  HOTEL_DELIVERY_TITLE,
  EXPENSE_SOURCE,
  MAX_REVIEW_COUNT,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  PAYMENT_SOURCES,
  ROOM_SERVICE_LABELS,
  ROOM_SERVICE_PRICE_LABEL,
  formatVnd,
  isRevenueService,
} from './reportTypes';
import { isArchived } from './deliveryLifecycle';
import {
  ALLOCATION_COLUMN,
  allocationColumns,
  allocationsOf,
  describeAllocations,
  methodAmounts,
  type Allocation,
  type PaymentMoneyColumns,
} from './paymentAllocation';
import {
  assertBranchInScope,
  branchScopeOf,
  isReceptionSupervisor,
  scopeIncludes,
  scopedBranchFilter,
  supervisorSourceLabel,
} from '../auth/branchScope';
import { assertCan, can } from '../auth/capabilities';
import { roleLabel } from '../auth/roleLabels';
import { NO_HISTORY } from './lateEntryText';
import { placeLabel } from '../housekeeping/workAreas';

/**
 * The journal's actor: a receptionist on shift, or a reception SUPERVISOR
 * (Admin, Quản lý lễ tân, Tổng quản lý lễ tân) acting on a branch in its scope.
 */
export type ReportActor = ShiftActor & { managedBranchIds?: readonly number[] };

/**
 * BỘ PHẬN BUỒNG PHÒNG'S OWN "BÁO CÁO VẤN ĐỀ" — the same journal, the same forms
 * and the same completion, kept apart by `originDepartment`: a housekeeping
 * record is never in Reception's lists, totals or exports, and Reception's are
 * never in Housekeeping's. The writer's role decides the department; the
 * request never does.
 */
export function isHousekeepingReporter(role: UserRole): boolean {
  return role === 'HOUSEKEEPING' || role === 'HOUSEKEEPING_MANAGER';
}

/**
 * What Bộ phận buồng phòng records in the journal (VII, the private reports, is
 * its own model). "Dịch vụ phòng, KPI" is Reception's only — its money and KPI
 * are the desk's.
 */
export const HOUSEKEEPING_REPORT_CATEGORIES = ['GUEST_REQUEST', 'FACILITY_ISSUE', 'HOTEL_DELIVERY'] as const;

const DEPARTMENT_LABELS: Record<ReportDepartment, string> = { RECEPTION: 'Lễ tân', HOUSEKEEPING: 'Buồng phòng' };

/**
 * WHO IS WRITING, AND ON WHICH SHIFT — resolved on the server, never read from
 * the request.
 *
 * A receptionist writes on their OPEN shift, exactly as before. A supervisor has
 * no shift of their own: a record they CREATE joins the branch's open shift when
 * there is one (so the desk sees it in its journal, marked "Admin tạo"), and is
 * shift-less otherwise; a CORRECTION they make carries no shift at all. Either
 * way the row names them and their role, so the audit never confuses the two.
 */
interface WriterContext {
  shiftSessionId: string | null;
  shiftType: ShiftType | null;
  name: string;
}

async function receptionistWriter(
  actor: ReportActor,
  client: PrismaClient | Prisma.TransactionClient,
): Promise<WriterContext & { branchId: number }> {
  const session = await requireOpenSession(actor, client);
  return {
    branchId: session.branchId,
    shiftSessionId: session.id,
    shiftType: session.shiftType,
    name: session.receptionistName,
  };
}

/** The writer of a correction, void or completion on an existing record. */
async function correctionWriter(
  actor: ReportActor,
  client: PrismaClient | Prisma.TransactionClient,
): Promise<WriterContext> {
  if (actor.role === 'RECEPTIONIST') return receptionistWriter(actor, client);
  return { shiftSessionId: null, shiftType: null, name: actor.fullName };
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export const REPORT_INCLUDE = {
  branch: { select: { id: true, code: true, hotelName: true, address: true, branchNumber: true } },
  createdBy: { select: { id: true, fullName: true } },
  voidedBy: { select: { id: true, fullName: true } },
  shiftSession: {
    select: {
      id: true,
      shiftType: true,
      receptionistName: true,
      startedAt: true,
      closedAt: true,
      // "Thêm ca": a shift added afterwards — shown on its heading.
      backfilledByNameSnapshot: true,
      backfilledByRole: true,
      backfilledAt: true,
      backfillReason: true,
    },
  },
  payment: true,
  guestRequest: { include: { completedBy: { select: { id: true, fullName: true } } } },
  /*
    The LIVE incident, read through the reference — never a copy of it. The
    journal shows the status Bộ phận kỹ thuật has it in right now, which is the
    only status worth showing.
  */
  facility: { include: { issue: { include: ISSUE_INCLUDE } } },
  complaint: { include: { completedBy: { select: { id: true, fullName: true } } } },
  roomService: true,
  delivery: true,
  /// Oldest first: a correction history reads forwards.
  audits: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.ReceptionOperationalReportInclude;

export type ReportDetail = Prisma.ReceptionOperationalReportGetPayload<{
  include: typeof REPORT_INCLUDE;
}>;

function person(u: { id: number; fullName: string } | null) {
  return u ? { id: u.id, fullName: u.fullName } : null;
}

/**
 * "Nội dung" of a guest request — what the guest asked for.
 *
 * A request recorded under the current form carries it in `note`. An older one
 * said it with "Ký gửi" (and perhaps a note beside it), so both are read, in
 * that order, rather than the older rows showing an empty content cell. Nothing
 * is rewritten: this is how a row is READ, not what it stores.
 */
export function requestContent(row: { itemType: string | null; note: string | null }): string {
  return [row.itemType, row.note]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' — ');
}

/**
 * A one-line description of a record, for the journal's "TÓM TẮT" column.
 *
 * Built HERE rather than in React so the journal, the Admin list and the export
 * summarise a row identically. It never invents information: every part of it is
 * a field that is on the row.
 */
export function reportSummary(row: ReportDetail, hidesGuest = false): string {
  if (row.payment) {
    const who = row.payment.guestName?.trim() || row.payment.roomNumber?.trim() || 'Khách';
    const used = allocationsOf(row.payment);
    return used.length > 0
      ? `${who} · ${describeAllocations(used)}`
      : `${who} · ${PAYMENT_METHOD_LABELS[row.payment.method]} ${formatVnd(row.payment.amount)}`;
  }
  if (row.guestRequest) {
    const state = row.guestRequest.completedAt ? 'đã hoàn thành' : 'đã tiếp nhận';
    // A legacy row leads with its short "Ký gửi", as it always did; a current
    // one with the content itself.
    const what = row.guestRequest.itemType?.trim() || row.guestRequest.note?.trim() || 'Yêu cầu';
    // Bộ phận buồng phòng never reads the guest; nobody reads "null" for a guest not yet named.
    if (hidesGuest) return `${what} · ${state}`;
    return `${what} · ${row.guestRequest.guestName ?? 'Chưa xác định khách'} · ${state}`;
  }
  if (row.facility) {
    const issue = row.facility.issue;
    // The same one-line place description every incident screen uses, so the
    // journal names a room exactly as the Technical queue does.
    return `${describeLocation(issue)} · ${issue.description}`;
  }
  if (row.complaint) {
    // `location` is legacy and null on every report recorded since.
    return [row.complaint.guestName, row.complaint.location, row.complaint.description]
      .filter((part) => Boolean(part?.trim()))
      .join(' · ');
  }
  if (row.roomService) {
    const s = row.roomService;
    // A review has no price to state; its counts are what it records.
    const what =
      s.serviceType === 'REVIEW'
        ? `Tripadvisor ${s.tripadvisorCount ?? 0} · Google ${s.googleCount ?? 0}`
        : formatVnd(s.price);
    return `${ROOM_SERVICE_LABELS[s.serviceType]} · ${s.guestName} · ${what}`;
  }
  if (row.delivery) {
    return `${DELIVERY_DEPARTMENT_LABELS[row.delivery.department]} · ${row.delivery.itemName} · SL ${row.delivery.quantity}`;
  }
  return CATEGORY_LABELS[row.category];
}

/** The guest's identity, kept from Bộ phận buồng phòng in a correction's trail too. */
const GUEST_FIELDS = new Set(['guestName', 'ezCode']);

export function serializeReportAudit(row: ReportDetail['audits'][number], hidesGuest = false) {
  const hidden = hidesGuest && row.field !== null && GUEST_FIELDS.has(row.field);
  return {
    id: row.id,
    action: row.action,
    field: row.field,
    oldValue: hidden ? null : row.oldValue,
    newValue: hidden ? null : row.newValue,
    reason: row.reason,
    actor: { id: row.actorUserId, name: row.actorNameSnapshot },
    actorRole: row.actorRole,
    actorRoleLabel: roleLabel(row.actorRole),
    shiftType: row.actorShiftType,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeReport(row: ReportDetail, now: Date = getClock().now(), viewerRole?: UserRole) {
  // Bộ phận buồng phòng records what it saw; who the guest is stays Reception's to know.
  const hidesGuest = viewerRole === 'HOUSEKEEPING' || viewerRole === 'HOUSEKEEPING_MANAGER';
  return {
    id: row.id,
    category: row.category,
    categoryLabel: CATEGORY_LABELS[row.category],
    branchId: row.branchId,
    branch: row.branch,
    shiftSessionId: row.shiftSessionId,
    shiftType: row.shiftType,
    shiftName: row.shiftType ? shiftDefinition(row.shiftType).name : null,
    shiftWindow: row.shiftType ? shiftWindowLabel(row.shiftType) : null,
    /**
     * The day the SHIFT belongs to, from the session — never from this row's
     * own timestamp, which would file a 02:15 entry on Ca C under the wrong
     * date. A row with no session (pre-shift data) has no shift to take a day
     * from, so it falls back to its own HCM date rather than to nothing.
     */
    shiftDate:
      row.shiftSession && row.shiftType
        ? shiftBusinessDate(row.shiftType, row.shiftSession.startedAt)
        : hcmDateOnly(row.createdAt),
    /** Who was ON the shift, as they checked in — the session's own record. */
    shiftReceptionistName: row.shiftSession?.receptionistName ?? null,
    /**
     * Has the shift pressed "Kết thúc ca"? Only a closed shift is part of the
     * official report for its business date; an open one can still change.
     */
    shiftClosed: row.shiftSession ? row.shiftSession.closedAt !== null : false,
    /** "Ca thêm bù": the shift was added afterwards with "Thêm ca" — by whom, when, why. */
    shiftBackfill: serializeShiftBackfill(row.shiftSession),
    createdBy: person(row.createdBy),
    /** The name the SHIFT recorded — not the account's current one. */
    createdByName: row.createdByNameSnapshot,
    /** The creator's role at creation; null on older rows (all Reception). */
    createdByRole: row.createdByRole,
    /**
     * "Admin tạo" / "Quản lý lễ tân tạo" — set when a supervisor entered the
     * record, null for the desk's own. Text, so it never relies on a colour.
     */
    sourceLabel:
      row.originDepartment === 'HOUSEKEEPING'
        ? `${row.createdByRole === 'HOUSEKEEPING_MANAGER' ? 'Quản lý buồng phòng' : 'Buồng phòng'} · ${row.createdByNameSnapshot}`
        : supervisorSourceLabel(row.createdByRole),
    /** Which department's journal — "Lễ tân" or "Buồng phòng". */
    originDepartment: row.originDepartment,
    departmentLabel: DEPARTMENT_LABELS[row.originDepartment],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    summary: reportSummary(row, hidesGuest),

    voided: row.voidedAt !== null,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    voidedBy: person(row.voidedBy),
    voidedByName: row.voidedByNameSnapshot,
    voidReason: row.voidReason,
    /** "Xóa bởi Quản lý lễ tân …" — null on rows voided before the role was kept. */
    voidedByRole: row.voidedByRole,
    voidedByRoleLabel: roleLabel(row.voidedByRole),
    /**
     * "Nhập bù": entered after its shift by a manager, for the receptionist
     * named in `createdBy`. `createdAt` is when it was entered; `shiftDate` and
     * the shift are the original ones.
     */
    lateEntry: row.enteredByUserId
      ? {
          enteredBy: { id: row.enteredByUserId, name: row.enteredByNameSnapshot ?? NO_HISTORY },
          enteredByRole: row.enteredByRole,
          enteredByRoleLabel: roleLabel(row.enteredByRole),
          reason: row.lateEntryReason,
          enteredAt: row.createdAt.toISOString(),
        }
      : null,

    payment: row.payment
      ? serializePayment(row.payment)
      : null,

    /** The housekeeping work item it was reported from, if any. */
    taskId: row.taskId,
    guestRequest: row.guestRequest
      ? {
          guestName: hidesGuest ? null : row.guestRequest.guestName,
          ezCode: hidesGuest ? null : row.guestRequest.ezCode,
          /** "Nội dung" as read — the note, or a legacy row's "Ký gửi" and note. */
          content: requestContent(row.guestRequest),
          note: row.guestRequest.note,
          /** Legacy: asked for until the form became name, Mã EZ and content. */
          itemType: row.guestRequest.itemType,
          roomNumber: row.guestRequest.roomNumber,
          completed: row.guestRequest.completedAt !== null,
          completedBy: person(row.guestRequest.completedBy),
          completedByName: row.guestRequest.completedByNameSnapshot,
          completedAt: row.guestRequest.completedAt
            ? row.guestRequest.completedAt.toISOString()
            : null,
          completedShiftType: row.guestRequest.completedShiftType,
          completedShiftName: row.guestRequest.completedShiftType
            ? shiftDefinition(row.guestRequest.completedShiftType).name
            : null,
          resolution: row.guestRequest.resolution,
          reportVerdict: row.guestRequest.reportVerdict,
          incorrectReason: row.guestRequest.incorrectReason,
          /** "Mức độ"; null (with "Chưa phân mức") only on requests recorded before it existed. */
          severity: row.guestRequest.severity,
          severityLabel: severityLabel(row.guestRequest.severity),
        }
      : null,

    facility: row.facility
      ? { issueId: row.facility.issueId, issue: serializeIssue(row.facility.issue, now) }
      : null,

    complaint: row.complaint
      ? {
          guestName: row.complaint.guestName,
          ezCode: row.complaint.ezCode,
          description: row.complaint.description,
          /** Legacy "Số phòng / Khác" — null on every report recorded since. */
          location: row.complaint.location,
          completed: row.complaint.completedAt !== null,
          completedBy: person(row.complaint.completedBy),
          completedByName: row.complaint.completedByNameSnapshot,
          completedAt: row.complaint.completedAt ? row.complaint.completedAt.toISOString() : null,
          completedShiftType: row.complaint.completedShiftType,
          completedShiftName: row.complaint.completedShiftType
            ? shiftDefinition(row.complaint.completedShiftType).name
            : null,
          /** "Hướng xử lý (nếu có)". */
          resolution: row.complaint.resolution,
          reportVerdict: row.complaint.reportVerdict,
          incorrectReason: row.complaint.incorrectReason,
          severity: row.complaint.severity,
          severityLabel: severityLabel(row.complaint.severity),
        }
      : null,

    roomService: row.roomService
      ? {
          serviceType: row.roomService.serviceType,
          serviceTypeLabel: ROOM_SERVICE_LABELS[row.roomService.serviceType],
          guestName: row.roomService.guestName,
          ezCode: row.roomService.ezCode,
          roomClass: row.roomService.roomClass,
          fromRoomClass: row.roomService.fromRoomClass,
          toRoomClass: row.roomService.toRoomClass,
          nights: row.roomService.nights,
          price: row.roomService.price,
          note: row.roomService.note,
          /** "Review" only — null on every other service. */
          tripadvisorCount: row.roomService.tripadvisorCount,
          googleCount: row.roomService.googleCount,
          /** False for "Review": a count, never revenue. */
          countsAsRevenue: isRevenueService(row.roomService.serviceType),
          /** Legacy fields, no longer asked for; kept readable on older rows. */
          phone: row.roomService.phone,
          roomNumber: row.roomService.roomNumber,
          serviceName: row.roomService.serviceName,
        }
      : null,

    delivery: row.delivery
      ? {
          department: row.delivery.department,
          departmentLabel: DELIVERY_DEPARTMENT_LABELS[row.delivery.department],
          itemName: row.delivery.itemName,
          quantity: row.delivery.quantity,
          note: row.delivery.note,
          /** Born completed — submitting the form is the hand-over. */
          status: 'COMPLETED' as const,
          statusLabel: 'Đã hoàn thành',
          completedAt: row.delivery.completedAt.toISOString(),
          /**
           * Past the 12-hour rule, so it is listed under "Hoàn thành vấn đề"
           * rather than in the active table. Derived from `now` on every read.
           */
          archived: isArchived(row.delivery.completedAt, now),
          title: HOTEL_DELIVERY_TITLE,
        }
      : null,

    audits: row.audits.map((a) => serializeReportAudit(a, hidesGuest)),
  };
}

/**
 * A payment as every screen and export reads it — ONE row, whatever number of
 * methods paid it. The money columns are already split by method so the screen,
 * the PDF and the XLSX cannot disagree about which column holds what.
 */
function serializePayment(p: NonNullable<ReportDetail['payment']>) {
  const amounts = methodAmounts(p);
  const used = allocationsOf(p);
  return {
    ezCode: p.ezCode,
    source: p.source,
    guestName: p.guestName,
    roomNumber: p.roomNumber,
    /** The primary method (the largest allocation). */
    method: p.method,
    methodLabel: PAYMENT_METHOD_LABELS[p.method],
    /** "Tổng tiền thu". */
    amount: p.amount,
    /** Every method used, in the selector's order — one entry per method. */
    allocations: used.map((a) => ({ method: a.method, label: PAYMENT_METHOD_LABELS[a.method], amount: a.amount })),
    /*
      "Công nợ" AS THE COLUMN REPORTS IT: the debt allocation, plus the legacy
      `receivable` column an older row carried beside its cash. Both are summed
      here, once, so the screen, the PDF and the XLSX read one number.
    */
    receivable: paymentDebt(p),
    expense: p.expense,
    note: p.note,
    cash: amounts.CASH,
    transfer: amounts.TRANSFER,
    card: amounts.CARD,
    debt: amounts.DEBT,
  };
}

/** The debt a payment row reports: its debt allocation, plus any legacy column. */
export function paymentDebt(p: PaymentMoneyColumns & { receivable: number }): number {
  return p.receivable + methodAmounts(p).DEBT;
}

export type SerializedReport = ReturnType<typeof serializeReport>;

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

/**
 * THE BRANCH FILTER, in one place.
 *
 * A receptionist sees their OWN branch and nothing else. `?? -1` rather than
 * omitting the clause: a branchless account must match no rows, and leaving the
 * key out would widen the query to every branch — the precise shape of the hole
 * the handover-notes route shipped with, which is why it is written this way
 * here from the start.
 *
 * THE SUPERVISORS ARE NAMED EXPLICITLY, and everyone else is refused rather
 * than falling through. Bộ phận kỹ thuật works incidents across all eight
 * branches, which makes "not a receptionist" a dangerously close neighbour of
 * "sees everything". A supervisor sees its `branchScope` — every branch for the
 * Admin and the Tổng quản lý lễ tân, the assigned ones for a Quản lý lễ tân —
 * narrowed to what the request asked for, and a branch outside it is refused.
 */
export function reportVisibilityWhere(
  actor: ReportActor,
  filter: { branchId?: number; branchIds?: readonly number[]; department?: ReportDepartment } = {},
): Prisma.ReceptionOperationalReportWhereInput {
  // Reception follows its branch's records of BOTH departments — Housekeeping's
  // are marked as such and stay Housekeeping's to act on (`loadOwn`).
  if (actor.role === 'RECEPTIONIST') {
    return { branchId: actor.branchId ?? -1 };
  }
  if (isReceptionSupervisor(actor.role)) {
    // The Admin's housekeeping view narrows to that department's records.
    const housekeepingOnly = actor.role === 'ADMIN' && filter.department === 'HOUSEKEEPING';
    return { ...scopedBranchFilter(actor, filter.branchIds ?? filter.branchId), ...(housekeepingOnly ? { originDepartment: 'HOUSEKEEPING' as const } : {}) };
  }
  // Quản lý buồng phòng: its branch's housekeeping records. A housekeeper: its own.
  if (actor.role === 'HOUSEKEEPING_MANAGER') {
    return { branchId: actor.branchId ?? -1, originDepartment: 'HOUSEKEEPING' };
  }
  if (actor.role === 'HOUSEKEEPING') {
    return { createdByUserId: actor.id, originDepartment: 'HOUSEKEEPING' };
  }
  throw ApiError.forbidden('Bạn không có quyền xem báo cáo vận hành lễ tân.');
}

/**
 * WHAT IS STILL OPEN, BY CATEGORY AND DEPARTMENT — the menu's per-category
 * counts. Guest requests and service-quality reports not yet completed
 * ("Đã tiếp nhận"), live, inside exactly the reader's own visibility (the rule
 * every list uses), each counted once under the department that recorded it.
 */
export async function countOpenReports(actor: ReportActor, client: PrismaClient = prisma) {
  const visible = reportVisibilityWhere(actor);
  const count = (where: Prisma.ReceptionOperationalReportWhereInput) =>
    client.receptionOperationalReport.count({ where: { AND: [visible, { voidedAt: null }, where] } });
  const openRequest = { category: 'GUEST_REQUEST' as const, guestRequest: { is: { completedAt: null } } };
  const [requestReception, requestHousekeeping, complaint] = await Promise.all([
    count({ ...openRequest, originDepartment: 'RECEPTION' }),
    count({ ...openRequest, originDepartment: 'HOUSEKEEPING' }),
    count({ category: 'CUSTOMER_COMPLAINT', complaint: { is: { completedAt: null } } }),
  ]);
  return { guestRequest: { reception: requestReception, housekeeping: requestHousekeeping }, complaint };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * The largest amount any money field will accept, in whole đồng.
 *
 * THIS IS THE COLUMN'S REAL CAPACITY, NOT A PREFERENCE.
 *
 * `amount`, `receivable`, `expense`, `price` and `openingCash` are Prisma `Int`,
 * which is PostgreSQL `INTEGER` — signed 32-bit, topping out at 2.147.483.647.
 * This constant was originally 9.999.999.999, which validation accepted and the
 * database then refused: the insert died inside the driver with "Unable to fit
 * integer value '9999999999' into an INT4", and the receptionist got a 500 with
 * no idea which field was at fault. A limit the storage cannot honour is not a
 * limit, it is a crash with extra steps.
 *
 * SO THE CEILING NOW MATCHES THE COLUMN, and an over-large amount is refused
 * cleanly with a message naming the field.
 *
 * THE REPORT IS NOT WHY. `operationalPdf.ts` sizes its money columns for
 * 9.999.999.999 — comfortably more than this — and asserts at import that its
 * own ceiling is at least this one. Raising this constant is therefore safe from
 * the report's point of view; it would need the COLUMNS widened to `BigInt`
 * first, which is a schema change and a decision about money, not about layout.
 *
 * 2.147.483.647 ₫ is roughly US$84,000 in a single front-desk transaction.
 */
export const MAX_VND = 2_147_483_647;

/**
 * A money field, as the database must hold it: a non-negative whole number of
 * đồng.
 *
 * REJECTS RATHER THAN COERCES. `Number("3.000.000")` is NaN and
 * `Number("300000abc")` is NaN, but `Number("")` is 0 and `Number(" 5 ")` is 5 —
 * so a blank amount would quietly become a zero-đồng payment. Everything that is
 * not already an integer is refused here, and the route's zod schema refuses the
 * string forms before that, so a formatted "3.150.000 ₫" never reaches storage.
 */
export function assertMoney(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw ApiError.validation(`${label} phải là số tiền hợp lệ.`);
  }
  if (value < 0) throw ApiError.validation(`${label} không được âm.`);
  if (value > MAX_VND) throw ApiError.validation(`${label} vượt quá giới hạn cho phép.`);
  return value;
}

function required(value: string | undefined | null, label: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw ApiError.validation(`Vui lòng nhập ${label}.`);
  return trimmed;
}

function optional(value: string | undefined | null): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
}

/* ------------------------------------------------------------------ *
 * Creating
 * ------------------------------------------------------------------ */

/**
 * "Nguồn", as a new entry must carry it: one of `PAYMENT_SOURCES`.
 *
 * REQUIRED. A walk-in is "Walking", not a blank — a blank cannot be told apart
 * from a receptionist who forgot. Anything outside the list is refused rather
 * than stored; see the list's own comment for why it is closed.
 */
function assertSource(value: string | undefined | null): string {
  const source = optional(value);
  if (source === null) throw ApiError.validation('Vui lòng chọn nguồn.');
  if (!(PAYMENT_SOURCES as readonly string[]).includes(source)) {
    throw ApiError.validation(`Nguồn không hợp lệ. Chọn một trong: ${PAYMENT_SOURCES.join(', ')}.`);
  }
  return source;
}

/**
 * "CHI TIỀN" AS A SOURCE — a pure cash outflow, and nothing else.
 *
 * The row records money PAID OUT at the desk: `expense` carries it (the column
 * the drawer already subtracts, always cash), and there is no "Thu tiền" — a
 * payout that also claimed to collect money would be the ambiguous mixed state
 * this rule exists to refuse. So: amount 0, no legacy debt, method CASH (the
 * drawer is the only place an expense can come from), expense above zero.
 * The accounting itself is unchanged — `cashService` already sums `expense`.
 */
function assertExpenseRow(row: { method: string; amount: number; receivable: number; expense: number }): void {
  if (row.expense <= 0) throw ApiError.validation('Vui lòng nhập số tiền chi.');
  if (row.amount !== 0 || row.receivable !== 0) {
    throw ApiError.validation('Giao dịch "Chi tiền" chỉ ghi số tiền chi, không ghi số tiền thu.');
  }
  if (row.method !== 'CASH') {
    throw ApiError.validation('Giao dịch "Chi tiền" luôn là tiền mặt.');
  }
}

/** The most methods one transaction can carry: each of the four, once. */
const MAX_ALLOCATIONS = PAYMENT_METHODS.length;

/**
 * "PHƯƠNG THỨC THANH TOÁN" — the allocations of ONE transaction, validated.
 *
 * Each method at most once (a second "Tiền mặt" line is refused, never merged
 * silently into a figure nobody typed), every amount a whole non-negative number
 * of đồng, and together EXACTLY the "Tổng tiền thu". The browser checks the same
 * sum before it lets anyone press Lưu; this is the check that counts.
 */
export function parseAllocations(raw: unknown, total: number): Allocation[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw ApiError.validation('Vui lòng chọn ít nhất một phương thức thanh toán.');
  }
  if (raw.length > MAX_ALLOCATIONS) throw ApiError.validation('Mỗi phương thức chỉ được chọn một lần.');
  const seen = new Set<string>();
  const allocations = raw.map((item) => {
    const entry = (item ?? {}) as { method?: unknown; amount?: unknown };
    const method = assertMethod(entry.method);
    if (seen.has(method)) throw ApiError.validation('Mỗi phương thức chỉ được chọn một lần.');
    seen.add(method);
    return { method, amount: assertMoney(entry.amount, PAYMENT_METHOD_LABELS[method]) };
  });
  const sum = allocations.reduce((n, a) => n + a.amount, 0);
  if (sum !== total) {
    throw ApiError.validation(
      `Tổng các phương thức (${formatVnd(sum)}) phải bằng tổng tiền thu (${formatVnd(total)}).`,
    );
  }
  return allocations;
}

/** A new payment's money fields, with the "Chi tiền" rule applied. */
function paymentMoney(p: PaymentInput) {
  const source = assertSource(p.source);
  if (source === EXPENSE_SOURCE) {
    const row = {
      method: 'CASH' as const,
      amount: assertMoney(p.amount ?? 0, 'Thu tiền'),
      receivable: assertMoney(p.receivable ?? 0, 'Công nợ'),
      expense: assertMoney(p.expense ?? 0, 'Chi tiền'),
    };
    assertExpenseRow(row);
    // A payout collects nothing: every allocation is zero.
    return { source, ...row, ...allocationColumns([{ method: 'CASH', amount: 0 }]) };
  }
  const amount = assertMoney(p.amount, 'Tổng tiền thu');
  /*
    ONE TRANSACTION, ONE ROW. The older single-method body ({ method, amount })
    is the one-allocation case of the same thing, so both shapes land here.
  */
  const allocations = parseAllocations(p.allocations ?? [{ method: p.method, amount }], amount);
  return {
    source,
    amount,
    ...allocationColumns(allocations),
    receivable: assertMoney(p.receivable ?? 0, 'Công nợ'),
    expense: assertMoney(p.expense ?? 0, 'Chi tiền'),
  };
}

/** A new record's "Mức độ": the one it names, or Trung bình. */
function newSeverity(raw: unknown): IssueSeverity {
  return raw === undefined || raw === null ? DEFAULT_SEVERITY : parseSeverity(raw);
}

/** The longest stay one "Bán phòng" or "Upgrade" row may record. */
export const MAX_NIGHTS = 365;

/** "Số đêm": a whole number of nights, at least one. */
function assertNights(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw ApiError.validation('Số đêm phải là số nguyên từ 1 trở lên.');
  }
  if (value > MAX_NIGHTS) throw ApiError.validation(`Số đêm không được vượt quá ${MAX_NIGHTS}.`);
  return value;
}

export interface PaymentInput {
  ezCode?: string;
  source?: string;
  guestName?: string;
  /** The single method of the older body; `allocations` replaces it. */
  method?: 'CASH' | 'TRANSFER' | 'CARD' | 'DEBT';
  /** "Tổng tiền thu" — the whole transaction, whatever paid it. */
  amount: number;
  /** "Phương thức thanh toán" — one line per method, summing to `amount`. */
  allocations?: { method: 'CASH' | 'TRANSFER' | 'CARD' | 'DEBT'; amount: number }[];
  /** LEGACY second column; the form no longer sends it. */
  receivable?: number;
  expense?: number;
  /** "Ghi chú". */
  note?: string;
}

/** The largest quantity one delivery row may record. */
export const MAX_DELIVERY_QUANTITY = 100_000;

/** Bộ phận, Tên hàng hóa, Số lượng and an optional note. */
export interface DeliveryInput {
  department: HotelDeliveryDepartment;
  itemName: string;
  quantity: number;
  note?: string;
}

function assertDepartment(value: unknown): HotelDeliveryDepartment {
  if (typeof value === 'string' && (DELIVERY_DEPARTMENTS as readonly string[]).includes(value)) {
    return value as HotelDeliveryDepartment;
  }
  throw ApiError.validation('Vui lòng chọn bộ phận.');
}

/** "Số lượng": a number, whole, at least 1. Free text is refused, not coerced. */
export function assertQuantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw ApiError.validation('Số lượng phải là số nguyên từ 1 trở lên.');
  }
  if (value > MAX_DELIVERY_QUANTITY) {
    throw ApiError.validation(`Số lượng không được vượt quá ${MAX_DELIVERY_QUANTITY}.`);
  }
  return value;
}

/** Tên khách, Mã EZ and "Nội dung" (`note`) — the whole of the current form. */
export interface GuestRequestInput {
  /** Reception's; Bộ phận buồng phòng never sends one. */
  guestName?: string;
  ezCode?: string;
  /** Optional: the room or area — kept from the work item when the request was made from one. */
  roomNumber?: string;
  note: string;
  /** "Mức độ" — Trung bình when omitted. */
  severity?: IssueSeverity;
}

export interface FacilityInput {
  issueId: string;
}

/** Tên khách, Mã EZ and Mô tả. */
export interface ComplaintInput {
  guestName: string;
  ezCode?: string;
  description: string;
  /** "Mức độ" — Trung bình when omitted. */
  severity?: IssueSeverity;
}

export interface RoomServiceInput {
  serviceType: 'ROOM_SALE' | 'UPGRADE' | 'SMOKING' | 'LAUNDRY' | 'OTHER' | 'REVIEW';
  guestName: string;
  ezCode?: string;
  roomClass?: string;
  fromRoomClass?: string;
  toRoomClass?: string;
  nights?: number;
  /** Required on every service but "Review", which is a count, not a sale. */
  price?: number;
  note?: string;
  /** "Review" only. */
  tripadvisorCount?: number;
  googleCount?: number;
}

/** A review count: a whole number from 0 up. Refused, never coerced. */
function assertReviewCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_REVIEW_COUNT) {
    throw ApiError.validation(`${label} phải là số nguyên từ 0 đến ${MAX_REVIEW_COUNT}.`);
  }
  return value;
}

/**
 * WHICH FIELDS EACH ROOM-SERVICE SUBTYPE MUST CARRY.
 *
 * Every subtype: Tên khách, Mã EZ, Tổng giá tiền, Ghi chú. On top of that, "Bán
 * phòng" requires Hạng phòng and Số đêm, "Upgrade" requires Từ / Tới hạng
 * phòng and Số đêm, and the other three ask for nothing more.
 *
 * A FIELD THE SUBTYPE DOES NOT ASK FOR IS NEVER STORED, whatever the request
 * carried — a "Giặt ủi" row cannot acquire a room class because a client sent
 * one. The legacy columns (SĐT, Số phòng, Loại hình) are left null on new rows.
 *
 * The same split as `issue/issueArea.ts`: this is the authority, the React form
 * only mirrors it. A form that validates itself is a form `curl` can skip, and
 * these rows end up in a financial report.
 */
export function normaliseRoomService(input: RoomServiceInput) {
  const who = {
    serviceType: input.serviceType,
    guestName: required(input.guestName, 'tên khách'),
    ezCode: optional(input.ezCode),
    phone: null,
    roomNumber: null,
    serviceName: null,
  };
  const none = { roomClass: null, fromRoomClass: null, toRoomClass: null, nights: null };
  const noCounts = { tripadvisorCount: null, googleCount: null };

  /*
    "REVIEW" IS A COUNT, NOT A SALE. Tên khách, Mã EZ and the two counts — no
    price (stored 0, never revenue), no note, no room fields. A row reporting
    no review at all is not a review record, so at least one count must be
    above zero.
  */
  if (input.serviceType === 'REVIEW') {
    const tripadvisorCount = assertReviewCount(input.tripadvisorCount ?? 0, 'Tripadvisor');
    const googleCount = assertReviewCount(input.googleCount ?? 0, 'Google');
    if (tripadvisorCount + googleCount === 0) {
      throw ApiError.validation('Vui lòng nhập số lượng review (Tripadvisor hoặc Google).');
    }
    return { ...who, ...none, price: 0, note: null, tripadvisorCount, googleCount };
  }

  const common = {
    ...who,
    ...noCounts,
    price: assertMoney(input.price, ROOM_SERVICE_PRICE_LABEL),
    note: optional(input.note),
  };

  switch (input.serviceType) {
    case 'ROOM_SALE':
      return {
        ...common,
        ...none,
        roomClass: required(input.roomClass, 'hạng phòng'),
        nights: assertNights(input.nights),
      };
    case 'UPGRADE':
      return {
        ...common,
        ...none,
        fromRoomClass: required(input.fromRoomClass, 'từ hạng phòng'),
        toRoomClass: required(input.toRoomClass, 'tới hạng phòng'),
        nights: assertNights(input.nights),
      };
    case 'SMOKING':
    case 'LAUNDRY':
    case 'OTHER':
      return { ...common, ...none };
  }
}

export type CreateReportInput =
  | { category: 'PAYMENT'; payment: PaymentInput }
  | { category: 'GUEST_REQUEST'; guestRequest: GuestRequestInput; taskId?: string }
  | { category: 'FACILITY_ISSUE'; facility: FacilityInput; taskId?: string }
  | { category: 'CUSTOMER_COMPLAINT'; complaint: ComplaintInput }
  | { category: 'ROOM_SERVICE'; roomService: RoomServiceInput }
  | { category: 'HOTEL_DELIVERY'; delivery: DeliveryInput };

/**
 * Create one journal entry.
 *
 * THE SHIFT IS RESOLVED FIRST AND THE REQUEST IS NEVER ASKED FOR IT. The session
 * decides the branch, the shift type, the employee and the employee's name; the
 * clock decides `createdAt`. What the caller supplies is only the content.
 */
export async function createReport(
  input: CreateReportInput & {
    /**
     * The TARGET BRANCH — read only for a supervisor, who must name exactly one
     * branch of its scope ("Tất cả" is never a target). A receptionist's branch
     * is its open shift's, and anything sent here is ignored.
     */
    branchId?: number;
  },
  actor: ReportActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<ReportDetail> {
  return (await createReports([input], { branchId: input.branchId }, actor, clock, client))[0]!;
}

/**
 * SEVERAL ENTRIES AT ONCE — "Dịch vụ phòng" for one guest who used several
 * services: one record per service, exactly as if each had been entered on its
 * own (same writer, same shift, same instant, same validation), so every table,
 * total and export reads them unchanged. ALL OR NONE: one transaction, so a
 * refused second service never leaves the first one recorded alone.
 */
export async function createReports(
  inputs: CreateReportInput[],
  target: { branchId?: number; confirmDuplicate?: boolean },
  actor: ReportActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<ReportDetail[]> {
  let writer: WriterContext & { branchId: number };
  if (actor.role === 'RECEPTIONIST') {
    writer = await receptionistWriter(actor, client);
  } else if (isReceptionSupervisor(actor.role)) {
    const branchId = assertBranchInScope(actor, target.branchId);
    const branch = await client.branch.findFirst({ where: { id: branchId, active: true }, select: { id: true } });
    if (!branch) throw ApiError.validation('Chi nhánh không hợp lệ hoặc đã ngừng hoạt động.');
    // The desk's open shift, if any: the record appears in its journal, marked.
    const open = await client.receptionShiftSession.findFirst({
      where: { branchId, closedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { id: true, shiftType: true },
    });
    writer = { branchId, shiftSessionId: open?.id ?? null, shiftType: open?.shiftType ?? null, name: actor.fullName };
  } else if (isHousekeepingReporter(actor.role)) {
    // A housekeeper's branch is its open shift's; a manager's, its own. Never the request's.
    if (actor.branchId === null) throw ApiError.conflict('Bạn cần "Vào ca" tại chi nhánh trước khi báo cáo.');
    const allowed: readonly string[] = HOUSEKEEPING_REPORT_CATEGORIES;
    if (inputs.some((i) => !allowed.includes(i.category))) {
      throw ApiError.forbidden('Bộ phận buồng phòng không ghi được loại báo cáo này.');
    }
    writer = { branchId: actor.branchId, shiftSessionId: null, shiftType: null, name: actor.fullName };
  } else {
    throw ApiError.forbidden('Bạn không có quyền ghi báo cáo vận hành.');
  }
  const now = clock.now();
  const base = {
    branchId: writer.branchId,
    shiftSessionId: writer.shiftSessionId,
    shiftType: writer.shiftType,
    createdByUserId: actor.id,
    createdByNameSnapshot: writer.name,
    createdByRole: actor.role,
    originDepartment: (isHousekeepingReporter(actor.role) ? 'HOUSEKEEPING' : 'RECEPTION') as ReportDepartment,
    createdAt: now,
  };

  return client.$transaction(async (tx) => {
    const created: ReportDetail[] = [];
    for (const input of inputs) {
      const task = 'taskId' in input && input.taskId ? await reportedTask(input.taskId, actor, writer.branchId, tx) : null;
      // After the item's own checks: whether it may be reported comes before whether it looks repeated.
      if (isHousekeepingReporter(actor.role) && !target.confirmDuplicate) await assertNotDuplicate(input, writer.branchId, now, tx);
      const data = await buildCreateData(input, { ...base, category: input.category, task }, tx);
      created.push(await tx.receptionOperationalReport.create({ data, include: REPORT_INCLUDE }));
    }
    return created;
  });
}

async function buildCreateData(
  input: CreateReportInput,
  base: {
    branchId: number;
    shiftSessionId: string | null;
    shiftType: ShiftType | null;
    createdByUserId: number;
    createdByNameSnapshot: string;
    createdByRole: UserRole;
    /** Reception's when absent. */
    originDepartment?: ReportDepartment;
    /** The work item it was reported from, checked, with its place in words. */
    task?: { id: string; place: string } | null;
    category: CreateReportInput['category'];
    createdAt: Date;
    /** "Nhập bù" only: the manager who actually entered it, and why. */
    lateEntry?: { userId: number; name: string; role: UserRole; reason: string };
  },
  client: PrismaClient | Prisma.TransactionClient,
): Promise<Prisma.ReceptionOperationalReportCreateInput> {
  const scalars = {
    ...(base.lateEntry
      ? {
          enteredBy: { connect: { id: base.lateEntry.userId } },
          enteredByNameSnapshot: base.lateEntry.name,
          enteredByRole: base.lateEntry.role,
          lateEntryReason: base.lateEntry.reason,
        }
      : {}),
    branch: { connect: { id: base.branchId } },
    ...(base.shiftSessionId ? { shiftSession: { connect: { id: base.shiftSessionId } } } : {}),
    shiftType: base.shiftType,
    createdBy: { connect: { id: base.createdByUserId } },
    createdByNameSnapshot: base.createdByNameSnapshot,
    createdByRole: base.createdByRole,
    originDepartment: base.originDepartment ?? 'RECEPTION',
    ...(base.task ? { task: { connect: { id: base.task.id } } } : {}),
    category: base.category,
    createdAt: base.createdAt,
  } satisfies Omit<Prisma.ReceptionOperationalReportCreateInput, 'category'> & {
    category: CreateReportInput['category'];
  };

  switch (input.category) {
    case 'PAYMENT': {
      const p = input.payment;
      return {
        ...scalars,
        payment: {
          // Số phòng is no longer asked for; new rows leave it null. Ghi chú is.
          create: {
            ezCode: optional(p.ezCode),
            guestName: optional(p.guestName),
            ...paymentMoney(p),
            note: optional(p.note),
          },
        },
      };
    }
    case 'GUEST_REQUEST': {
      /*
        Reception names the guest. Bộ phận buồng phòng writes only the content
        and "Mức độ" — never the guest, and no room is asked of it (the work
        item's place is kept when it reported from one). Reception adds the
        name and Mã EZ later (`setGuestIdentity`).
      */
      const housekeeping = base.originDepartment === 'HOUSEKEEPING';
      return {
        ...scalars,
        guestRequest: {
          // Recorded as "Đã tiếp nhận": the completion columns stay null until `completeReport` writes them.
          create: housekeeping
            ? {
                guestName: null,
                ezCode: null,
                roomNumber: base.task?.place ?? optional(input.guestRequest.roomNumber),
                note: required(input.guestRequest.note, 'nội dung'),
                severity: newSeverity(input.guestRequest.severity),
              }
            : {
                guestName: required(input.guestRequest.guestName, 'tên khách'),
                ezCode: optional(input.guestRequest.ezCode),
                note: required(input.guestRequest.note, 'nội dung'),
                severity: newSeverity(input.guestRequest.severity),
              },
        },
      };
    }
    case 'FACILITY_ISSUE': {
      /*
        THE INCIDENT MUST ALREADY EXIST, AND MUST BE THIS BRANCH'S.

        Reception reports a fault through the existing incident form, which
        creates the HotelIssue that Bộ phận kỹ thuật works from; this category
        then points the journal at it. Creating a second incident here — or
        letting a branch reference another branch's — is exactly the duplicate
        maintenance record the specification forbids.
      */
      const issue = await client.hotelIssue.findUnique({
        where: { id: input.facility.issueId },
        select: { id: true, branchId: true, voidedAt: true },
      });
      // A deleted ("Xóa") incident is not something the journal can point at.
      if (!issue || issue.voidedAt) throw ApiError.validation('Không tìm thấy sự cố được tham chiếu.');
      if (issue.branchId !== base.branchId) {
        throw ApiError.branchAccessDenied('Sự cố không thuộc chi nhánh của bạn.');
      }
      return { ...scalars, facility: { create: { issue: { connect: { id: issue.id } } } } };
    }
    case 'CUSTOMER_COMPLAINT':
      return {
        ...scalars,
        complaint: {
          // "Đã tiếp nhận" until completed; Số phòng / Khác is not asked for.
          create: {
            guestName: required(input.complaint.guestName, 'tên khách'),
            ezCode: optional(input.complaint.ezCode),
            description: required(input.complaint.description, 'mô tả'),
            severity: newSeverity(input.complaint.severity),
          },
        },
      };
    case 'ROOM_SERVICE':
      return { ...scalars, roomService: { create: normaliseRoomService(input.roomService) } };
    case 'HOTEL_DELIVERY':
      return {
        ...scalars,
        delivery: {
          /*
            BORN "ĐÃ HOÀN THÀNH": submitting the form is the hand-over, so the
            completion instant IS the creation instant. See
            `deliveryLifecycle.ts` for how the 12-hour rule reads it.
          */
          create: {
            department: assertDepartment(input.delivery.department),
            itemName: required(input.delivery.itemName, 'tên hàng hóa'),
            quantity: assertQuantity(input.delivery.quantity),
            note: optional(input.delivery.note),
            completedAt: base.createdAt,
          },
        },
      };
  }
}

/** How far back a possible duplicate is looked for. */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Case, spacing and punctuation do not make two reports different. */
const foldText = (v: string | null | undefined) =>
  (v ?? '').normalize('NFC').toLocaleLowerCase('vi').replace(/[\s\p{P}]+/gu, ' ').trim();

/**
 * "CÓ THỂ ĐÃ ĐƯỢC BÁO" — before Bộ phận buồng phòng records a guest request or a
 * delivery, the same branch's live records of the last 24 hours of that
 * category are compared on what the report IS (the same content; the same item
 * for the same department), whichever department wrote them. A match is
 * refused with POSSIBLE_DUPLICATE, saying only which department — never the
 * other record's content, guest or reporter — and the same report is accepted
 * once `confirmDuplicate` says it is a separate issue. Nothing is merged or deleted.
 * (Incidents have their own check by place: `/issues/similar`.)
 */
async function assertNotDuplicate(input: CreateReportInput, branchId: number, now: Date, client: PrismaClient | Prisma.TransactionClient) {
  const recent = { branchId, voidedAt: null, createdAt: { gte: new Date(now.getTime() - DUPLICATE_WINDOW_MS) } };
  let match: { report: { originDepartment: ReportDepartment } } | undefined;
  if (input.category === 'GUEST_REQUEST') {
    const key = foldText(input.guestRequest.note);
    if (!key) return;
    const rows = await client.guestRequestReport.findMany({ where: { report: recent }, select: { note: true, report: { select: { originDepartment: true } } } });
    match = rows.find((r) => foldText(r.note) === key);
  } else if (input.category === 'HOTEL_DELIVERY') {
    const key = foldText(input.delivery.itemName);
    const rows = await client.hotelDeliveryReport.findMany({
      where: { report: recent, department: input.delivery.department as never },
      select: { itemName: true, report: { select: { originDepartment: true } } },
    });
    match = rows.find((r) => foldText(r.itemName) === key);
  }
  if (!match) return;
  const other = match.report.originDepartment === 'RECEPTION';
  throw new ApiError(
    'POSSIBLE_DUPLICATE',
    other
      ? 'Bộ phận lễ tân có thể đã ghi nhận một báo cáo tương tự trong 24 giờ qua. Kiểm tra lại; nếu đây là việc khác, bấm “Vẫn gửi”.'
      : 'Bộ phận buồng phòng đã ghi nhận một báo cáo tương tự trong 24 giờ qua. Kiểm tra lại; nếu đây là việc khác, bấm “Vẫn gửi”.',
    { department: match.report.originDepartment },
  );
}

/**
 * THE WORK ITEM a Housekeeping report names ("+ Báo cáo vấn đề" on a room or
 * area): of the writer's branch, live; a housekeeper's own item (the manager's,
 * any of its branch). Its place in words is what the report then shows.
 */
async function reportedTask(taskId: string, actor: ReportActor, branchId: number, client: PrismaClient | Prisma.TransactionClient) {
  if (!isHousekeepingReporter(actor.role)) throw ApiError.validation('Chỉ báo cáo của Bộ phận buồng phòng mới gắn với công việc buồng phòng.');
  const task = await client.housekeepingRoomTask.findUnique({
    where: { id: taskId },
    select: { id: true, branchId: true, voidedAt: true, assigneeUserId: true, areaKind: true, roomNumber: true, floor: true },
  });
  if (!task || task.voidedAt || task.branchId !== branchId) throw ApiError.validation('Không tìm thấy công việc buồng phòng của chi nhánh.');
  if (actor.role === 'HOUSEKEEPING' && task.assigneeUserId !== actor.id) throw ApiError.forbidden('Công việc này không được giao cho bạn.');
  return { id: task.id, place: placeLabel(task.areaKind, task.areaKind === 'ROOM' ? task.roomNumber : null, task.floor) };
}

/**
 * "THÔNG TIN KHÁCH" — Reception names the guest of a request Bộ phận buồng
 * phòng recorded: its branch's desk, or a supervisor in scope (the Admin, any).
 * Only `guestName` and `ezCode` change; the reporter, content, department and
 * time never do. Each changed field writes an EDIT row to the record's history,
 * naming who did it; a request already withdrawn is refused.
 */
export async function setGuestIdentity(
  id: string,
  input: { guestName: string; ezCode?: string },
  actor: ReportActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<ReportDetail> {
  if (actor.role !== 'RECEPTIONIST' && !isReceptionSupervisor(actor.role)) throw ApiError.forbidden('Chỉ lễ tân mới nhập thông tin khách.');
  const row = await client.receptionOperationalReport.findUnique({ where: { id }, include: REPORT_INCLUDE });
  if (!row) throw ApiError.notFound('Không tìm thấy báo cáo.');
  const inScope = actor.role === 'RECEPTIONIST' ? row.branchId === actor.branchId : scopeIncludes(branchScopeOf(actor), row.branchId);
  if (!inScope) throw ApiError.branchAccessDenied('Báo cáo không thuộc chi nhánh của bạn.');
  if (row.originDepartment !== 'HOUSEKEEPING' || row.category !== 'GUEST_REQUEST' || !row.guestRequest) {
    throw ApiError.validation('Chỉ yêu cầu do Bộ phận buồng phòng ghi nhận mới cần nhập thông tin khách.');
  }
  if (row.voidedAt) throw ApiError.conflict('Báo cáo đã bị hủy.');
  const guestName = required(input.guestName, 'tên khách');
  const ezCode = optional(input.ezCode);
  const now = clock.now();
  const changes = [
    ['guestName', row.guestRequest.guestName, guestName],
    ['ezCode', row.guestRequest.ezCode, ezCode],
  ].filter(([, before, after]) => before !== after) as [string, string | null, string | null][];
  if (changes.length === 0) return row;
  return client.$transaction(async (tx) => {
    await tx.guestRequestReport.update({ where: { reportId: id }, data: { guestName, ezCode } });
    for (const [field, oldValue, newValue] of changes) {
      await tx.receptionReportAudit.create({
        data: {
          branchId: row.branchId,
          reportId: id,
          action: 'EDIT',
          field,
          oldValue,
          newValue,
          reason: 'Lễ tân nhập thông tin khách',
          actorUserId: actor.id,
          actorNameSnapshot: actor.fullName,
          actorRole: actor.role,
          createdAt: now,
        },
      });
    }
    return tx.receptionOperationalReport.findUniqueOrThrow({ where: { id }, include: REPORT_INCLUDE });
  });
}

/* ------------------------------------------------------------------ *
 * Listing
 * ------------------------------------------------------------------ */

export interface ListReportsFilter {
  branchId?: number;
  /** The Admin's choice of journal; every other role reads its own department's. */
  department?: ReportDepartment;
  /** Several branches at once (a supervisor's multi-branch report). */
  branchIds?: readonly number[];
  category?: CreateReportInput['category'];
  shiftSessionId?: string;
  /**
   * Only rows written on one of these shifts. This is how a BUSINESS DATE is
   * applied: the caller resolves the day to its sessions (`businessDate.ts`)
   * and the rows follow their shift, wherever their own timestamps fall. An
   * empty list matches nothing — a day with no shifts has no records.
   */
  shiftSessionIds?: string[];
  /**
   * Also include records with NO shift created inside this half-open window —
   * the supervisor-entered records made while no shift was open. They belong to
   * no shift, so the business date is their own HCM day; without this they
   * would be missing from every period report and export.
   */
  unshiftedWindow?: { from: Date; to: Date };
  /**
   * One shift was asked for: of the records with no shift, only Bộ phận buồng
   * phòng's — it works no reception shift, so a shift filter never hides it.
   */
  unshiftedHousekeepingOnly?: boolean;
  /** Half-open [from, to) instants, already resolved from HCM calendar days. */
  from?: Date;
  to?: Date;
  /** Voided rows are INCLUDED by default — they are part of the audit record. */
  includeVoided?: boolean;
  /** "Lịch sử xóa": ONLY the voided rows. */
  onlyVoided?: boolean;
  /** "Mức độ" — requests, complaints and facility entries of that level only. */
  severity?: IssueSeverity;
  take?: number;
}

export function reportWhere(
  actor: ReportActor,
  filter: ListReportsFilter,
): Prisma.ReceptionOperationalReportWhereInput {
  const where: Prisma.ReceptionOperationalReportWhereInput = reportVisibilityWhere(actor, filter);
  if (filter.category) where.category = filter.category;
  if (filter.shiftSessionId) where.shiftSessionId = filter.shiftSessionId;
  else if (filter.shiftSessionIds && filter.unshiftedWindow) {
    where.OR = [
      { shiftSessionId: { in: filter.shiftSessionIds } },
      {
        shiftSessionId: null,
        createdAt: { gte: filter.unshiftedWindow.from, lt: filter.unshiftedWindow.to },
        ...(filter.unshiftedHousekeepingOnly ? { originDepartment: 'HOUSEKEEPING' as const } : {}),
      },
    ];
  } else if (filter.shiftSessionIds) where.shiftSessionId = { in: filter.shiftSessionIds };
  if (filter.from || filter.to) {
    where.createdAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lt: filter.to } : {}),
    };
  }
  if (filter.includeVoided === false) where.voidedAt = null;
  if (filter.onlyVoided) where.voidedAt = { not: null };
  if (filter.severity) where.AND = [severityWhere(filter.severity)];
  return where;
}

/**
 * The records of one level. Only the three categories that carry one can match:
 * a facility entry by its incident's level — the journal points at the incident
 * and never holds a copy of it.
 */
export function severityWhere(severity: IssueSeverity): Prisma.ReceptionOperationalReportWhereInput {
  return {
    OR: [
      { guestRequest: { is: { severity } } },
      { complaint: { is: { severity } } },
      { facility: { is: { issue: { severity } } } },
    ],
  };
}

/** Whether a II / IV record still needs doing — not completed, not withdrawn. */
function journalOpen(row: ReportDetail): boolean {
  const detail = row.guestRequest ?? row.complaint;
  return detail !== null && detail.completedAt === null && row.voidedAt === null;
}

/**
 * II and IV in their default order: what still needs doing first, by level,
 * then what was finished, newest first (see `prioritise`). Other categories
 * are left in their order.
 */
export function prioritiseJournal(rows: ReportDetail[]): ReportDetail[] {
  return prioritise(
    rows,
    journalOpen,
    (r) => r.guestRequest?.severity ?? r.complaint?.severity ?? null,
    (r) => r.createdAt,
  );
}

export async function listReports(
  actor: ReportActor,
  filter: ListReportsFilter = {},
  client: PrismaClient = prisma,
): Promise<ReportDetail[]> {
  return client.receptionOperationalReport.findMany({
    where: reportWhere(actor, filter),
    include: REPORT_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: filter.take ?? 500,
  });
}

type ArchivableCategory = (typeof ARCHIVABLE_CATEGORIES)[number];

/**
 * One page per category of II and IV, newest first, with each category's full
 * count — so a screen that shows a page can say when there are more.
 */
async function pageByCategory(
  base: Prisma.ReceptionOperationalReportWhereInput,
  pageSize: number,
  client: PrismaClient,
): Promise<{ reports: ReportDetail[]; totals: Record<ArchivableCategory, number> }> {
  const perCategory = await Promise.all(
    ARCHIVABLE_CATEGORIES.map(async (category) => {
      const where = { AND: [base, { category }] };
      const [rows, total] = await Promise.all([
        client.receptionOperationalReport.findMany({
          where,
          include: REPORT_INCLUDE,
          orderBy: { createdAt: 'desc' },
          take: pageSize,
        }),
        client.receptionOperationalReport.count({ where }),
      ]);
      return { category, rows, total };
    }),
  );
  return {
    reports: perCategory.flatMap((c) => c.rows),
    totals: {
      GUEST_REQUEST: perCategory.find((c) => c.category === 'GUEST_REQUEST')?.total ?? 0,
      CUSTOMER_COMPLAINT: perCategory.find((c) => c.category === 'CUSTOMER_COMPLAINT')?.total ?? 0,
    },
  };
}

/**
 * II and IV as the desk sees them NOW — the branch's unfinished records and its
 * completions from the last 12 hours, whichever shift took them. See
 * `completionArchive.ts` for the rule. Withdrawn records are not here: they are
 * read in "Lịch sử xóa".
 */
export async function listActiveJournal(
  actor: ReportActor,
  now: Date,
  client: PrismaClient = prisma,
  severity?: IssueSeverity,
): Promise<{ reports: ReportDetail[]; totals: Record<ArchivableCategory, number> }> {
  const where = activeJournalWhere(reportVisibilityWhere(actor), now);
  const page = await pageByCategory(severity ? { AND: [where, severityWhere(severity)] } : where, ACTIVE_PAGE_SIZE, client);
  return { ...page, reports: prioritiseJournal(page.reports) };
}

/**
 * II and IV in "Hoàn thành vấn đề": completed and received at least 12 hours
 * ago. Newest first, a page per category, with each category's full count so a
 * screen can say when there are more.
 */
export async function listArchivedJournal(
  actor: ReportActor,
  now: Date,
  options: {
    /** The shared report period (business dates, shift); every archived record when absent. */
    period?: ReportPeriod | null;
    /** "Vấn đề báo cáo đúng" / "sai"; both when absent. */
    verdict?: ReportVerdict;
    /** A supervisor's one branch (inside its scope); a receptionist's is always its own. */
    branchId?: number;
    /** "Mức độ"; every level when absent. */
    severity?: IssueSeverity;
    /** The Admin's choice of journal (both departments when absent). */
    department?: ReportDepartment;
    /** "Loại vấn đề": one of the archived categories; both when absent. */
    category?: ArchivableCategory;
  } = {},
  client: PrismaClient = prisma,
): Promise<{ reports: ReportDetail[]; totals: Record<ArchivableCategory, number> }> {
  const where = archivedJournalWhere(reportVisibilityWhere(actor, { branchId: options.branchId, department: options.department }), now);
  return pageByCategory(
    {
      AND: [
        where,
        ...(options.period ? [journalPeriodWhere(options.period)] : []),
        ...(options.severity ? [severityWhere(options.severity)] : []),
        ...(options.category ? [{ category: options.category }] : []),
        ...(options.verdict
          ? [
              {
                OR: [
                  { guestRequest: { is: verdictWhere(options.verdict) } },
                  { complaint: { is: verdictWhere(options.verdict) } },
                ],
              },
            ]
          : []),
      ],
    },
    ARCHIVE_PAGE_SIZE,
    client,
  );
}

/**
 * BỘ PHẬN BUỒNG PHÒNG'S LIVE JOURNAL — its guest requests still open or
 * completed in the last 12 hours (after that, "Hoàn thành vấn đề"), newest first. Withdrawn records are not here. The Admin reads a branch's (or
 * every branch's) by asking for the department.
 */
export async function listHousekeepingJournal(
  actor: ReportActor,
  now: Date,
  options: { branchId?: number } = {},
  client: PrismaClient = prisma,
): Promise<ReportDetail[]> {
  const scope = reportVisibilityWhere(actor, { branchId: options.branchId, department: 'HOUSEKEEPING' });
  const rows = await client.receptionOperationalReport.findMany({
    where: {
      AND: [
        scope,
        { originDepartment: 'HOUSEKEEPING', voidedAt: null },
        { category: 'GUEST_REQUEST', OR: [{ guestRequest: { is: { completedAt: null } } }, { createdAt: { gt: archiveCutoff(now) } }] },
      ],
    },
    include: REPORT_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: ACTIVE_PAGE_SIZE,
  });
  return prioritiseJournal(rows);
}

/**
 * "MÃ EZ" → THE GUEST'S NAME, from the journal itself: the newest record the
 * reader may see that carries this Mã EZ and a name. KAS keeps no guest
 * register — the PMS does — so the journal is the one place a name was ever
 * typed against a code. Null when none was: the name is then typed.
 */
export async function guestByEz(
  actor: ReportActor,
  ezRaw: unknown,
  options: { branchId?: number } = {},
  client: PrismaClient = prisma,
): Promise<{ guestName: string; ezCode: string; recordedAt: string } | null> {
  const ezCode = typeof ezRaw === 'string' ? ezRaw.trim() : '';
  if (!ezCode || ezCode.length > 100) return null;
  const ez = { equals: ezCode, mode: 'insensitive' as const };
  const named = { not: null, notIn: [''] };
  const row = await client.receptionOperationalReport.findFirst({
    where: {
      AND: [
        reportVisibilityWhere(actor, { branchId: options.branchId }),
        { voidedAt: null },
        {
          OR: [
            { roomService: { is: { ezCode: ez } } },
            { guestRequest: { is: { ezCode: ez } } },
            { complaint: { is: { ezCode: ez } } },
            { payment: { is: { ezCode: ez, guestName: named } } },
          ],
        },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: {
      createdAt: true,
      roomService: { select: { guestName: true, ezCode: true } },
      guestRequest: { select: { guestName: true, ezCode: true } },
      complaint: { select: { guestName: true, ezCode: true } },
      payment: { select: { guestName: true, ezCode: true } },
    },
  });
  const detail = row?.roomService ?? row?.guestRequest ?? row?.complaint ?? row?.payment;
  const guestName = detail?.guestName?.trim();
  if (!row || !detail || !guestName) return null;
  return { guestName, ezCode: detail.ezCode ?? ezCode, recordedAt: row.createdAt.toISOString() };
}

export async function countReports(
  actor: ReportActor,
  filter: ListReportsFilter = {},
  client: PrismaClient = prisma,
): Promise<number> {
  return client.receptionOperationalReport.count({ where: reportWhere(actor, filter) });
}

/** How many rows each category holds — the Admin's convenience counters. */
export async function countByCategory(
  actor: ReportActor,
  filter: ListReportsFilter = {},
  client: PrismaClient = prisma,
): Promise<Record<CreateReportInput['category'], number>> {
  const grouped = await client.receptionOperationalReport.groupBy({
    by: ['category'],
    where: reportWhere(actor, filter),
    _count: { _all: true },
    orderBy: { category: 'asc' },
  });
  const counts: Record<CreateReportInput['category'], number> = {
    PAYMENT: 0,
    GUEST_REQUEST: 0,
    FACILITY_ISSUE: 0,
    CUSTOMER_COMPLAINT: 0,
    ROOM_SERVICE: 0,
    HOTEL_DELIVERY: 0,
  };
  for (const row of grouped) counts[row.category] = row._count._all;
  return counts;
}

/* ------------------------------------------------------------------ *
 * Correcting, voiding, accepting
 * ------------------------------------------------------------------ */

async function loadOwn(
  id: string,
  actor: ReportActor,
  client: PrismaClient | Prisma.TransactionClient,
): Promise<ReportDetail> {
  const row = await client.receptionOperationalReport.findUnique({
    where: { id },
    include: REPORT_INCLUDE,
  });
  if (!row) throw ApiError.notFound('Không tìm thấy báo cáo.');
  // Bộ phận buồng phòng: its own records (a manager, its branch's); never Reception's.
  if (isHousekeepingReporter(actor.role)) {
    const own = actor.role === 'HOUSEKEEPING_MANAGER' ? row.branchId === actor.branchId : row.createdByUserId === actor.id;
    if (row.originDepartment !== 'HOUSEKEEPING' || !own) throw ApiError.forbidden('Báo cáo không thuộc phạm vi của bạn.');
    return row;
  }
  // Reception touches Reception's records; only the Admin reaches both departments.
  if (row.originDepartment !== 'RECEPTION' && actor.role !== 'ADMIN') {
    throw ApiError.forbidden('Báo cáo này thuộc bộ phận khác.');
  }
  if (actor.role === 'RECEPTIONIST') {
    if (row.branchId !== actor.branchId) {
      throw ApiError.branchAccessDenied('Báo cáo không thuộc chi nhánh của bạn.');
    }
    return row;
  }
  /*
    A SUPERVISOR CORRECTS WITHIN ITS SCOPE — the same record, never a copy.

    The Admin was once refused here, to keep "who changed what" clean. That
    guarantee is kept by a different means now: every correction writes an audit
    row naming the actor (and a supervisor's carries no shift, so it can never be
    mistaken for the desk's own), and the record keeps its original creator,
    shift and instant untouched.
  */
  if (isReceptionSupervisor(actor.role)) {
    if (!scopeIncludes(branchScopeOf(actor), row.branchId)) {
      throw ApiError.branchAccessDenied('Báo cáo không thuộc phạm vi chi nhánh của bạn.');
    }
    return row;
  }
  throw ApiError.forbidden('Bạn không có quyền sửa báo cáo này.');
}

/** The fields each category allows a correction to touch. */
/**
 * The fields each category allows a correction to touch — the fields its
 * current form asks for. Legacy columns (a payment's room and note, a request's
 * "Ký gửi", a complaint's place, a room service's phone) are not correctable any
 * more, so an older row keeps them exactly as recorded.
 */
const EDITABLE: Record<CreateReportInput['category'], readonly string[]> = {
  // The money itself ("Tổng tiền thu" and its methods) is judged as a whole by
  // `correctPaymentMoney`, never field by field.
  PAYMENT: ['ezCode', 'source', 'guestName', 'receivable', 'expense', 'note'],
  // `resolution` is absent on purpose: it is written only by `completeReport`.
  GUEST_REQUEST: ['guestName', 'ezCode', 'note', 'severity'],
  /*
    A facility entry has NOTHING TO CORRECT. Its only field is the incident it
    points at, and pointing it somewhere else would not be a correction — it
    would be a different report. The wrong one is voided and a new one written.
  */
  FACILITY_ISSUE: [],
  CUSTOMER_COMPLAINT: ['guestName', 'ezCode', 'description', 'severity'],
  ROOM_SERVICE: [
    'guestName',
    'ezCode',
    'roomClass',
    'fromRoomClass',
    'toRoomClass',
    'nights',
    'price',
    'note',
    'tripadvisorCount',
    'googleCount',
  ],
  /*
    `completedAt` is absent on purpose, like a request's `resolution`: it is the
    hand-over instant and the archive clock runs from it, so a correction may
    change WHAT was delivered but never WHEN.
  */
  HOTEL_DELIVERY: ['department', 'itemName', 'quantity', 'note'],
};

/**
 * A room service's correctable fields depend on the SERVICE: a "Review" corrects
 * its guest and its two counts — never a price it does not have — and every
 * other service everything but the counts.
 */
function editableFields(current: ReportDetail): readonly string[] {
  const all = EDITABLE[current.category];
  if (current.category !== 'ROOM_SERVICE') return all;
  const review = current.roomService?.serviceType === 'REVIEW';
  const reviewFields = ['guestName', 'ezCode', 'tripadvisorCount', 'googleCount'];
  return review ? reviewFields : all.filter((f) => f !== 'tripadvisorCount' && f !== 'googleCount');
}

const COUNT_FIELDS: Record<string, string> = { tripadvisorCount: 'Tripadvisor', googleCount: 'Google' };

const MONEY_FIELDS = new Set(['amount', 'receivable', 'expense', 'price']);

function auditValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

export interface UpdateReportInput {
  payment?: Partial<PaymentInput>;
  guestRequest?: Partial<GuestRequestInput>;
  complaint?: Partial<ComplaintInput>;
  roomService?: Partial<RoomServiceInput>;
  delivery?: Partial<DeliveryInput>;
  /** Optional free-text justification, stored on every field row of this edit. */
  reason?: string;
}

/**
 * Correct a record, writing one audit row per changed field.
 *
 * THE OLD VALUE IS READ INSIDE THE TRANSACTION, from the row being changed, not
 * from anything the client sent. A correction that recorded a client-supplied
 * "old value" would let a browser rewrite what the record used to say, which is
 * the only thing an edit trail is for.
 *
 * FIELDS WHOSE VALUE DID NOT CHANGE WRITE NO ROW. Re-saving a form without
 * touching it must not manufacture an audit entry that says 300000 → 300000.
 */
export async function updateReport(
  id: string,
  patch: UpdateReportInput,
  actor: ReportActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<ReportDetail> {
  const now = clock.now();
  const current = await loadOwn(id, actor, client);
  if (current.voidedAt) {
    throw ApiError.conflict('Báo cáo đã bị hủy, không thể sửa.');
  }

  const writer = await correctionWriter(actor, client);
  const allowed = editableFields(current);
  if (allowed.length === 0) {
    throw ApiError.validation('Báo cáo này không có nội dung để sửa.');
  }

  /*
    THE BLOCK IS CHOSEN BY THE RECORD'S CATEGORY, not by whichever one the
    request happened to send.

    Falling back through `payment ?? guestRequest ?? complaint ?? roomService`
    reads the first block present, so `PATCH` on a payment carrying
    `{ complaint: { guestName } }` would have written that name onto the payment
    — the two share a column name. Harmless in intent and wrong in fact: a
    correction must change the thing it names.
  */
  const suppliedByCategory: Record<CreateReportInput['category'], Record<string, unknown> | undefined> = {
    PAYMENT: patch.payment as Record<string, unknown> | undefined,
    GUEST_REQUEST: patch.guestRequest as Record<string, unknown> | undefined,
    FACILITY_ISSUE: undefined,
    CUSTOMER_COMPLAINT: patch.complaint as Record<string, unknown> | undefined,
    ROOM_SERVICE: patch.roomService as Record<string, unknown> | undefined,
    HOTEL_DELIVERY: patch.delivery as Record<string, unknown> | undefined,
  };
  const supplied: Record<string, unknown> = suppliedByCategory[current.category] ?? {};

  /*
    A CORRECTION MADE FOR A RECEPTIONIST MUST SAY WHY. A Quản lý lễ tân / Tổng
    quản lý lễ tân changing a record the desk wrote (createdByRole RECEPTIONIST,
    or null on rows from before the role was kept — all of them the desk's) is
    refused without "Lý do sửa". The record keeps its creator; the reason, the
    manager and the instant go on every audit row of this edit.
  */
  const forReceptionist = current.createdByRole === null || current.createdByRole === 'RECEPTIONIST';
  const reason =
    forReceptionist && can(actor.role, 'reports.editRequiresReason')
      ? required(patch.reason, 'lý do sửa')
      : optional(patch.reason);

  /*
    THE OLD VALUE IS READ INSIDE THE TRANSACTION, AND THE UPDATE IS GUARDED BY IT.

    The read above (`loadOwn`) is for authorization and for the category; it is
    NOT what the audit trail is built from. Two receptionists correcting the same
    cash row from the same screen would otherwise both compute their "old value"
    from the row as they each loaded it: B saves 500.000 (audit 300.000 → 500.000),
    A then saves 900.000 and writes "300.000 → 900.000". The 500.000 that was
    actually overwritten appears nowhere, and the trail claims a change that never
    happened — the one thing an edit history exists to prevent.

    So the detail row is re-read here, the changes are computed from THAT, and the
    update carries the old values in its own WHERE clause. If anything moved in
    between, `count` is 0 and the correction is REFUSED rather than silently
    clobbering somebody else's. A financial correction is the wrong place to let
    the last writer win quietly.

    The same WHERE also carries `report.voidedAt: null`, which closes the other
    half of the race: an edit that arrives just after a void used to mutate the
    amount of a row that was already out of every total.
  */
  return client.$transaction(async (tx) => {
    const fresh = await tx.receptionOperationalReport.findUnique({
      where: { id },
      include: {
        payment: true,
        guestRequest: true,
        complaint: true,
        roomService: true,
        delivery: true,
      },
    });
    if (!fresh) throw ApiError.notFound('Không tìm thấy báo cáo.');
    if (fresh.voidedAt) throw ApiError.conflict('Báo cáo đã bị hủy, không thể sửa.');

    const detail = (fresh.payment ??
      fresh.guestRequest ??
      fresh.complaint ??
      fresh.roomService ??
      fresh.delivery) as
      | Record<string, unknown>
      | null;
    if (!detail) throw ApiError.validation('Báo cáo này không có nội dung để sửa.');

    const changes: { field: string; oldValue: string | null; newValue: string | null }[] = [];
    const data: Record<string, unknown> = {};
    /** The values the update expects to find — optimistic concurrency. */
    const guard: Record<string, unknown> = {};

    for (const field of allowed) {
      if (!(field in supplied)) continue;
      const raw = supplied[field];
      const before = detail[field] ?? null;
      const next = MONEY_FIELDS.has(field)
        ? assertMoney(raw, moneyLabel(field))
        : field in COUNT_FIELDS
          ? assertReviewCount(raw, COUNT_FIELDS[field]!)
          : field === 'severity'
          ? parseSeverity(raw)
          : field === 'method'
          ? assertMethod(raw)
          : field === 'department'
            ? assertDepartment(raw)
            : field === 'quantity'
              ? assertQuantity(raw)
              : field === 'nights'
                ? correctedNights(raw, (detail as { serviceType?: string }).serviceType)
                : normaliseText(field, raw, current.category);
      if (auditValue(before) === auditValue(next)) continue;
      /*
        A SOURCE IS CHECKED ONLY WHEN IT CHANGES. An older row typed "agoda.com"
        before the list was closed, or left it empty; correcting its amount must
        not force a change of source, and re-saving it untouched is skipped just
        above. A CHANGE must land inside the list — it cannot become empty.
      */
      if (field === 'source') assertSource(next as string | null);
      data[field] = next;
      guard[field] = before;
      // A level is audited in words ("Trung bình → Cao"), like every other value a person reads.
      const said = (v: unknown) => (field === 'severity' && v ? SEVERITY_LABELS[v as IssueSeverity] : auditValue(v));
      changes.push({ field, oldValue: said(before), newValue: said(next) });
    }

    if (current.category === 'PAYMENT' && fresh.payment) {
      correctPaymentMoney(fresh.payment, supplied, data, guard, changes);
    }

    if (changes.length === 0) return fresh.id;

    /*
      "CHI TIỀN" STAYS A PURE PAYOUT after the correction, and a row cannot drift
      into it half-way. Judged on the row AS IT WILL BE (stored values merged with
      the change), so moving a payment to "Chi tiền" must also zero its amount.
    */
    if (current.category === 'PAYMENT') {
      const stored = detail as { source: string | null; method: string; amount: number; receivable: number; expense: number };
      const after = { ...stored, ...(data as Partial<typeof stored>) };
      if (after.source === EXPENSE_SOURCE) {
        assertExpenseRow(after);
        for (const f of ['source', 'method', 'amount', 'receivable', 'expense'] as const) guard[f] = stored[f];
      }
    }

    /*
      A REVIEW KEEPS AT LEAST ONE REVIEW. The same rule as on creation: after
      the correction, Tripadvisor + Google must still be above zero — a Review
      row reporting no review at all is not a review record. The PAIR is judged,
      and both counts go into the guard, so two single-field corrections racing
      each other cannot zero one count each and both succeed.
    */
    if (Object.keys(data).some((f) => f in COUNT_FIELDS)) {
      const counts = detail as { tripadvisorCount?: number | null; googleCount?: number | null };
      const tripadvisor = (data.tripadvisorCount as number | undefined) ?? counts.tripadvisorCount ?? 0;
      const google = (data.googleCount as number | undefined) ?? counts.googleCount ?? 0;
      if (tripadvisor + google === 0) {
        throw ApiError.validation('Vui lòng nhập số lượng review (Tripadvisor hoặc Google).');
      }
      guard.tripadvisorCount = counts.tripadvisorCount ?? null;
      guard.googleCount = counts.googleCount ?? null;
    }

    const where = { reportId: id, ...guard, report: { is: { voidedAt: null } } };
    let changed = 0;
    switch (current.category) {
      case 'PAYMENT':
        changed = (await tx.receptionPayment.updateMany({ where, data })).count;
        break;
      case 'GUEST_REQUEST':
        changed = (await tx.guestRequestReport.updateMany({ where, data })).count;
        break;
      case 'CUSTOMER_COMPLAINT':
        changed = (await tx.customerComplaintReport.updateMany({ where, data })).count;
        break;
      case 'ROOM_SERVICE':
        changed = (await tx.roomServiceReport.updateMany({ where, data })).count;
        break;
      case 'HOTEL_DELIVERY':
        changed = (await tx.hotelDeliveryReport.updateMany({ where, data })).count;
        break;
      default:
        throw ApiError.validation('Báo cáo này không có nội dung để sửa.');
    }
    if (changed === 0) {
      throw ApiError.conflict('Báo cáo vừa được thay đổi ở nơi khác. Vui lòng tải lại và sửa lại.');
    }

    // One instant for the whole edit, so three changed fields read as one event.
    await tx.receptionReportAudit.createMany({
      data: changes.map((c) => ({
        branchId: current.branchId,
        reportId: id,
        shiftSessionId: writer.shiftSessionId,
        action: 'EDIT' as const,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        reason,
        actorUserId: actor.id,
        actorNameSnapshot: writer.name,
        actorShiftType: writer.shiftType,
        actorRole: actor.role,
        createdAt: now,
      })),
    });

    // Touch the root so `updatedAt` reflects the correction, not just the detail.
    await tx.receptionOperationalReport.update({ where: { id }, data: { updatedAt: now } });
    return fresh.id;
  }).then((reportId) =>
    /*
      Reloaded OUTSIDE the transaction, with the full include. Doing it inside
      would hold the transaction open across a large read for no benefit — the
      writes are already committed and consistent by then.
    */
    client.receptionOperationalReport.findUniqueOrThrow({
      where: { id: reportId },
      include: REPORT_INCLUDE,
    }),
  );
}

/**
 * THE MONEY OF A CORRECTED PAYMENT — "Tổng tiền thu" and its methods, judged
 * TOGETHER, so a correction can add a method, change an amount or remove one,
 * and the row still balances. Still one row: nothing here creates another.
 *
 * Audited as two readable lines, never as four column names: "amount" when the
 * total changed and "allocations" when the split did ("Tiền mặt 1.000.000 ₫ →
 * Tiền mặt 500.000 ₫ + Chuyển khoản 500.000 ₫"). The old values are the row's as
 * read inside the transaction — a legacy row's split is its one method — and
 * every stored money column goes into the guard.
 *
 * The older single-method body ({ method, amount }) still corrects a row paid
 * one way. A row paid several ways must be corrected by its allocations: a bare
 * new total could not say which method it belongs to.
 */
function correctPaymentMoney(
  stored: PaymentMoneyColumns,
  supplied: Record<string, unknown>,
  data: Record<string, unknown>,
  guard: Record<string, unknown>,
  changes: { field: string; oldValue: string | null; newValue: string | null }[],
): void {
  const touches = 'allocations' in supplied || 'method' in supplied || 'amount' in supplied;
  if (!touches) return;
  const before = allocationsOf(stored);
  let total: number;
  let next: Allocation[];
  if (supplied.allocations !== undefined) {
    total = supplied.amount !== undefined ? assertMoney(supplied.amount, 'Tổng tiền thu') : sumOf(supplied.allocations);
    next = parseAllocations(supplied.allocations, total);
  } else {
    total = supplied.amount !== undefined ? assertMoney(supplied.amount, 'Tổng tiền thu') : stored.amount;
    // A bare total cannot say which of several methods it belongs to — but a
    // zero total (the row becoming a "Chi tiền" payout) belongs to none.
    if (before.length > 1 && total !== 0) {
      throw ApiError.validation('Giao dịch có nhiều phương thức — hãy sửa số tiền của từng phương thức.');
    }
    const method = supplied.method !== undefined ? assertMethod(supplied.method) : stored.method;
    next = parseAllocations([{ method, amount: total }], total);
  }
  const columns = allocationColumns(next);
  const after = allocationsOf({ ...columns, amount: total });
  // One method before and after, the same one: only the total moved, and the
  // "amount" line says so — a second line repeating it would be noise.
  const sameSingleMethod =
    before.length <= 1 && after.length <= 1 && (before[0]?.method ?? stored.method) === (after[0]?.method ?? columns.method);
  const splitChanged = !sameSingleMethod && describeAllocations(before) !== describeAllocations(after);
  const methodChanged = columns.method !== stored.method;
  if (total === stored.amount && !splitChanged && !methodChanged) return;

  Object.assign(data, { amount: total, ...columns });
  guard.amount = stored.amount;
  guard.method = stored.method;
  for (const column of Object.values(ALLOCATION_COLUMN)) guard[column] = stored[column];
  if (total !== stored.amount) {
    changes.push({ field: 'amount', oldValue: auditValue(stored.amount), newValue: auditValue(total) });
  }
  if (splitChanged || methodChanged) {
    changes.push({ field: 'allocations', oldValue: describeAllocations(before), newValue: describeAllocations(after) });
  }
}

/** The sum of allocations as sent, for a body that names no total of its own. */
function sumOf(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.reduce((n: number, item) => n + (typeof item?.amount === 'number' ? item.amount : 0), 0);
}

function moneyLabel(field: string): string {
  if (field === 'amount') return 'Thu tiền';
  if (field === 'receivable') return 'Công nợ';
  if (field === 'expense') return 'Chi tiền';
  return 'Tổng giá tiền';
}

function assertMethod(raw: unknown): 'CASH' | 'TRANSFER' | 'CARD' | 'DEBT' {
  if (raw === 'CASH' || raw === 'TRANSFER' || raw === 'CARD' || raw === 'DEBT') return raw;
  throw ApiError.validation('Phương thức thanh toán không hợp lệ.');
}

/**
 * "Số đêm" on a correction: required on "Bán phòng" and "Upgrade", and never
 * settable on a subtype that does not have it.
 */
function correctedNights(raw: unknown, serviceType: string | undefined): number | null {
  if (serviceType === 'ROOM_SALE' || serviceType === 'UPGRADE') return assertNights(raw);
  throw ApiError.validation('Loại dịch vụ này không có số đêm.');
}

/** Which text fields may become empty, and which may not. */
const TEXT_REQUIRED: Record<string, string> = {
  guestName: 'tên khách',
  description: 'mô tả',
  itemName: 'tên hàng hóa',
  roomClass: 'hạng phòng',
  fromRoomClass: 'từ hạng phòng',
  toRoomClass: 'tới hạng phòng',
};

function normaliseText(
  field: string,
  raw: unknown,
  category: CreateReportInput['category'],
): string | null {
  const value = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : String(raw);
  /*
    A field is required only where the CATEGORY requires it. "guestName" is
    mandatory on a complaint and optional on a payment row — a walk-in paying
    cash may genuinely have no name recorded — so the rule follows the category
    rather than the column name alone.
  */
  // A request's "Nội dung" is what the request IS; it cannot be emptied.
  if (category === 'GUEST_REQUEST' && field === 'note') return required(value, 'nội dung');
  const label = TEXT_REQUIRED[field];
  const mandatory =
    label !== undefined &&
    !(category === 'PAYMENT' && field === 'guestName') &&
    // On a room service, only the fields that subtype actually asks for are
    // mandatory; the others are null by construction and stay that way.
    !(category === 'ROOM_SERVICE' && ROOM_SERVICE_OPTIONAL.has(field));
  if (mandatory) return required(value, label);
  return optional(value);
}

/**
 * Room-service fields that are null for most subtypes. Clearing one of them is a
 * legitimate correction ("this was not an upgrade after all"); the create path's
 * `normaliseRoomService` is what guarantees the right ones are present for the
 * subtype in the first place.
 */
const ROOM_SERVICE_OPTIONAL = new Set(['roomClass', 'fromRoomClass', 'toRoomClass']);

/**
 * VOID — withdraw a record from the totals, keep it on file.
 *
 * WHY THIS EXISTS INSTEAD OF DELETE
 *
 * "Xóa" on a financial row cannot mean "make it as if it never happened": the
 * cash it recorded either entered the drawer or it did not, and a row that can
 * be erased makes the drawer's balance unexplainable. So the row stays, every
 * total filters `voidedAt: null`, and the Admin sees who voided it and why.
 *
 * A REASON IS REQUIRED. A withdrawn financial row with no explanation is the
 * one an audit will always stop on.
 */
export async function voidReport(
  id: string,
  reason: string,
  actor: ReportActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<ReportDetail> {
  const trimmed = required(reason, 'lý do hủy');
  const now = clock.now();
  const current = await loadOwn(id, actor, client);
  if (current.voidedAt) throw ApiError.conflict('Báo cáo đã bị hủy trước đó.');
  const writer = await correctionWriter(actor, client);
  /*
    THE DESK'S "HỦY" IS NOT A DELETE RIGHT. A receptionist withdraws only what
    it entered ITSELF on the shift it is still working — a mistake caught before
    the drawer is counted and handed over. A colleague's record, a finished
    shift's (already reconciled) or a manager's late entry is deleted through
    the supervisors' audited "Xóa" ('reports.delete'), never from the desk.
  */
  if (!can(actor.role, 'reports.delete')) {
    if (
      !can(actor.role, 'reports.voidOwnShiftEntry') ||
      current.createdByUserId !== actor.id ||
      current.shiftSessionId === null ||
      current.shiftSessionId !== writer.shiftSessionId ||
      current.enteredByUserId !== null
    ) {
      throw ApiError.forbidden(
        'Lễ tân chỉ hủy được bản ghi do chính mình nhập trong ca đang làm. Bản ghi khác do quản lý lễ tân xóa.',
      );
    }
  }

  return client.$transaction(async (tx) => {
    /*
      GUARDED BY `voidedAt: null` IN THE WHERE CLAUSE, not by the read above.
      Two tabs pressing "Xóa" at the same moment would otherwise both pass the
      check and write two audit rows for one void.
    */
    const { count } = await tx.receptionOperationalReport.updateMany({
      where: { id, voidedAt: null },
      data: {
        voidedAt: now,
        voidedByUserId: actor.id,
        voidedByNameSnapshot: writer.name,
        voidReason: trimmed,
        voidedByRole: actor.role,
      },
    });
    if (count === 0) throw ApiError.conflict('Báo cáo đã bị hủy trước đó.');

    await tx.receptionReportAudit.create({
      data: {
        branchId: current.branchId,
        reportId: id,
        shiftSessionId: writer.shiftSessionId,
        action: 'VOID',
        reason: trimmed,
        actorUserId: actor.id,
        actorNameSnapshot: writer.name,
        actorShiftType: writer.shiftType,
        actorRole: actor.role,
        createdAt: now,
      },
    });

    return tx.receptionOperationalReport.findUniqueOrThrow({
      where: { id },
      include: REPORT_INCLUDE,
    });
  });
}

/**
 * "HOÀN THÀNH" — a second, separate actor on a guest request or a
 * service-quality report, and how they handled it.
 *
 * Both are "Đã tiếp nhận" from the moment they are recorded; this is the event
 * that makes them "Đã hoàn thành". It writes only the completion columns and
 * never touches the creation ones. A bag taken on Ca A and returned on Ca B has
 * two names on it afterwards, and the first one is still the answer to "who
 * took it?".
 *
 * THE VERDICT IS REQUIRED ("Đúng" / "Sai", `parseCompletionVerdict`, the rule
 * every "Hoàn thành" shares). "Đúng" takes an optional handling text ("Cách xử
 * lý / Hướng xử lý (nếu có)") — blank is stored as null, never a placeholder
 * sentence; "Sai" requires "Lý do báo cáo sai". The time, the person and the
 * shift are the server's; nothing in the request sets them.
 *
 * Guarded by `completedAt: null` and a live report in the update itself, so two
 * receptionists completing at once produce one completion, and a void racing a
 * completion cannot complete a withdrawn record.
 */
export async function completeReport(
  id: string,
  input: CompletionVerdictInput,
  actor: ReportActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<ReportDetail> {
  const verdict = parseCompletionVerdict(input);
  const now = clock.now();
  const current = await loadOwn(id, actor, client);
  const detail =
    current.category === 'GUEST_REQUEST'
      ? current.guestRequest
      : current.category === 'CUSTOMER_COMPLAINT'
        ? current.complaint
        : null;
  if (!detail) {
    throw ApiError.validation('Chỉ yêu cầu của khách và vấn đề chất lượng mới cần hoàn thành.');
  }
  if (current.voidedAt) throw ApiError.conflict('Báo cáo đã bị hủy.');
  if (detail.completedAt) throw ApiError.conflict('Bản ghi này đã được hoàn thành.');
  const writer = await correctionWriter(actor, client);

  const where = { reportId: id, completedAt: null, report: { is: { voidedAt: null } } };
  const data = {
    completedByUserId: actor.id,
    completedByNameSnapshot: writer.name,
    completedAt: now,
    completedShiftSessionId: writer.shiftSessionId,
    completedShiftType: writer.shiftType,
    resolution: verdict.resolution,
    reportVerdict: verdict.reportVerdict,
    incorrectReason: verdict.incorrectReason,
  };
  const { count } =
    current.category === 'GUEST_REQUEST'
      ? await client.guestRequestReport.updateMany({ where, data })
      : await client.customerComplaintReport.updateMany({ where, data });
  if (count === 0) throw ApiError.conflict('Bản ghi này đã được hoàn thành hoặc đã bị hủy.');

  return client.receptionOperationalReport.findUniqueOrThrow({
    where: { id },
    include: REPORT_INCLUDE,
  });
}

/* ------------------------------------------------------------------ *
 * "Lịch sử xóa" — the deleted records, for the people who may see them
 * ------------------------------------------------------------------ */

/**
 * THE DELETED RECORDS OF THE READER'S BRANCHES, newest deletion first.
 *
 * Reception sees its own branch's — the records its desk entered and the ones a
 * supervisor deleted there; a supervisor sees its scope (one branch of it when
 * asked). The record itself is the history: its creator, shift and business
 * date are untouched, and `voidedBy…` + the VOID audit row say who deleted it,
 * in what role, when and why. A period narrows by BUSINESS date, like every
 * other report screen.
 */
export async function listDeletedReports(
  actor: ReportActor,
  filter: { branchId?: number; category?: CreateReportInput['category']; period?: ReportPeriod | null },
  client: PrismaClient = prisma,
): Promise<ReportDetail[]> {
  assertCan(actor.role, 'reports.deletionHistory', 'Bạn không có quyền xem lịch sử xóa báo cáo.');
  const where: Prisma.ReceptionOperationalReportWhereInput = {
    AND: [
      reportVisibilityWhere(actor, { branchId: filter.branchId }),
      { voidedAt: { not: null } },
      ...(filter.category ? [{ category: filter.category }] : []),
      ...(filter.period ? [journalPeriodWhere(filter.period)] : []),
    ],
  };
  return client.receptionOperationalReport.findMany({
    where,
    include: REPORT_INCLUDE,
    orderBy: { voidedAt: 'desc' },
    take: 500,
  });
}

/* ------------------------------------------------------------------ *
 * "Lịch sử chỉnh sửa" — the corrections, for the people who may see them
 * ------------------------------------------------------------------ */

/**
 * THE AUDITED CORRECTIONS OF THE READER'S BRANCHES, newest first.
 *
 * Read from the trail every correction already writes — one EDIT row per
 * changed field, with the old and new value, who, in what role, when and why —
 * so nothing here is reconstructed: a record corrected before auditing existed
 * simply has no rows. Deletions (VOID) and late entries (LATE_ENTRY) are other
 * events and stay out; they have their own views. Scoped and narrowed exactly
 * like "Lịch sử xóa": the record's branch and its BUSINESS date.
 *
 * Returns the audit rows and, once each, the records they belong to.
 */
export async function listEditHistory(
  actor: ReportActor,
  filter: { branchId?: number; category?: CreateReportInput['category']; period?: ReportPeriod | null },
  client: PrismaClient = prisma,
): Promise<{ audits: ReportDetail['audits']; reports: ReportDetail[]; truncated: boolean }> {
  assertCan(actor.role, 'reports.editHistory', 'Bạn không có quyền xem lịch sử chỉnh sửa báo cáo.');
  const LIMIT = 1000;
  const reportWhere: Prisma.ReceptionOperationalReportWhereInput = {
    AND: [
      reportVisibilityWhere(actor, { branchId: filter.branchId }),
      ...(filter.category ? [{ category: filter.category }] : []),
      ...(filter.period ? [journalPeriodWhere(filter.period)] : []),
    ],
  };
  const audits = await client.receptionReportAudit.findMany({
    where: { action: 'EDIT', report: { is: reportWhere } },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: LIMIT + 1,
  });
  const truncated = audits.length > LIMIT;
  const page = audits.slice(0, LIMIT);
  const ids = [...new Set(page.map((a) => a.reportId).filter((x): x is string => x !== null))];
  const reports = await client.receptionOperationalReport.findMany({
    where: { id: { in: ids } },
    include: REPORT_INCLUDE,
  });
  return { audits: page, reports, truncated };
}

/* ------------------------------------------------------------------ *
 * "Nhập bù" — a record the receptionist missed, entered on its own shift
 * ------------------------------------------------------------------ */

/**
 * The categories `createLateReport` carries. A facility incident goes through
 * `createLateIncident` instead: the incident itself must be created (with its
 * own validation and lifecycle), and the journal entry points at it.
 */
const LATE_ENTRY_CATEGORIES: readonly CreateReportInput['category'][] = [
  'PAYMENT',
  'GUEST_REQUEST',
  'CUSTOMER_COMPLAINT',
  'ROOM_SERVICE',
  'HOTEL_DELIVERY',
];

/**
 * The FINISHED shifts of one business date at one branch of the manager's scope —
 * the only places a late entry can go. Each names the receptionist who worked
 * it, so the manager picks the shift and the person together and can never name
 * a receptionist who was not there.
 */
export async function lateEntrySessions(
  actor: ReportActor,
  params: { branchId: number; businessDate: string },
  client: PrismaClient = prisma,
) {
  assertCan(actor.role, 'reports.lateEntry', 'Bạn không có quyền nhập bù báo cáo.');
  const branchId = assertBranchInScope(actor, params.branchId);
  const sessions = await sessionsForBusinessDates(
    { from: params.businessDate, to: params.businessDate, branchId },
    client,
  );
  const users = await client.receptionShiftSession.findMany({
    where: { id: { in: sessions.map((s) => s.id) } },
    select: {
      id: true,
      userId: true,
      backfilledByNameSnapshot: true,
      backfilledByRole: true,
      backfilledAt: true,
      backfillReason: true,
    },
  });
  const userOf = new Map(users.map((u) => [u.id, u.userId]));
  const backfillOf = new Map(users.map((u) => [u.id, u]));
  return sessions
    .filter((s) => s.closedAt !== null)
    .map((s) => ({
      id: s.id,
      branchId: s.branchId,
      businessDate: s.businessDate,
      shiftType: s.shiftType,
      shiftName: shiftDefinition(s.shiftType).name,
      shiftWindow: shiftWindowLabel(s.shiftType),
      receptionist: { id: userOf.get(s.id) ?? null, name: s.receptionistName },
      startedAt: s.startedAt.toISOString(),
      closedAt: s.closedAt!.toISOString(),
      /** "Ca thêm bù": added afterwards with "Thêm ca" — by whom, when and why. */
      backfill: serializeShiftBackfill(backfillOf.get(s.id)),
    }));
}

/** A backfilled shift's stamp, or null for a shift opened by a real check-in. */
export function serializeShiftBackfill(
  row:
    | {
        backfilledByNameSnapshot: string | null;
        backfilledByRole: UserRole | null;
        backfilledAt: Date | null;
        backfillReason: string | null;
      }
    | null
    | undefined,
) {
  if (!row?.backfilledAt) return null;
  return {
    // Never guessed: a stamp without a name says so.
    backfilledByName: row.backfilledByNameSnapshot ?? 'Không có dữ liệu lịch sử',
    backfilledByRole: row.backfilledByRole,
    backfilledByRoleLabel: roleLabel(row.backfilledByRole),
    backfilledAt: row.backfilledAt.toISOString(),
    reason: row.backfillReason,
  };
}

/**
 * The receptionists a "Thêm ca" may name at one branch of the manager's scope:
 * the branch's active Reception accounts, by name. Nobody else can be chosen —
 * the server checks the same rule again when the shift is added.
 */
export async function lateEntryReceptionists(
  actor: ReportActor,
  params: { branchId: number },
  client: PrismaClient = prisma,
): Promise<{ id: number; fullName: string }[]> {
  assertCan(actor.role, 'reports.lateEntry', 'Bạn không có quyền nhập bù báo cáo.');
  const branchId = assertBranchInScope(actor, params.branchId);
  return client.user.findMany({
    where: { role: 'RECEPTIONIST', active: true, branchId },
    select: { id: true, fullName: true },
    orderBy: { fullName: 'asc' },
  });
}

export interface BackfillShiftInput {
  branchId: number;
  /** The shift's BUSINESS date, "YYYY-MM-DD" (Ca C of the 7th is the 7th's). */
  businessDate: string;
  shiftType: ShiftType;
  /** The receptionist who worked it — must be an active receptionist of the branch. */
  receptionistUserId: number;
  /** Why the shift is missing ("Lễ tân quên vào ca A"); required. */
  reason: string;
}

/**
 * "THÊM CA" — a shift the receptionist worked but never checked in to.
 *
 * The missing records of that shift need a shift to go on, and filing them on
 * another one would put them in the wrong drawer and under the wrong person.
 * So the SHIFT itself is added — historically, and only as context:
 *
 *   * at its NOMINAL window from `SHIFT_DEFINITIONS` (Ca C of the 7th runs
 *     22:00 on the 7th to 06:00 on the 8th), so it lands on that business date
 *     by the same arithmetic as every check-in;
 *   * already CLOSED at its nominal end: it never makes anyone "on shift",
 *     never answers "is this person checked in?" and changes no roster;
 *   * only once that shift is OVER — a shift still running is the
 *     receptionist's own to check in to;
 *   * for an ACTIVE RECEPTIONIST OF THAT BRANCH, never for whoever the request
 *     names; the manager who adds it comes from the session, never the body;
 *   * never twice: an existing session of the same receptionist, date and
 *     shift — or any of theirs overlapping it — refuses it, and the unique
 *     `backfillKey` refuses a second manager adding the same shift at once;
 *   * with a SHIFT_BACKFILL audit row carrying the required reason.
 *
 * Nothing else is created: no report, no zero payment, no opening cash. The
 * shift's records are then entered with the normal "Nhập bù" on it.
 */
export async function createBackfillShift(
  input: BackfillShiftInput,
  actor: ReportActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
) {
  assertCan(actor.role, 'reports.lateEntry', 'Bạn không có quyền thêm ca nhập bù.');
  const branchId = assertBranchInScope(actor, input.branchId);
  const reason = required(input.reason, 'lý do thêm ca');
  if (reason.length > 1000) throw ApiError.validation('Lý do thêm ca quá dài.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    throw ApiError.validation('Ngày làm việc không hợp lệ.');
  }
  const now = clock.now();
  if (input.businessDate > hcmDateOnly(now)) {
    throw ApiError.validation('Không thể thêm ca cho một ngày trong tương lai.');
  }

  const def = shiftDefinition(input.shiftType);
  const startedAt = hcmWallClockToUtc(input.businessDate, def.startLocalTime);
  const { nominalEndAt, graceEndAt } = shiftBoundaries(input.shiftType, startedAt);
  // The same arithmetic every check-in uses — a guard, never expected to fire.
  if (shiftBusinessDate(input.shiftType, startedAt) !== input.businessDate) {
    throw ApiError.validation('Ca và ngày làm việc không khớp.');
  }
  if (nominalEndAt.getTime() > now.getTime()) {
    throw ApiError.conflict('Ca này chưa kết thúc — lễ tân tự vào ca và ghi báo cáo.');
  }

  const receptionist = await client.user.findUnique({
    where: { id: input.receptionistUserId },
    select: { id: true, fullName: true, role: true, active: true, branchId: true },
  });
  if (!receptionist || receptionist.role !== 'RECEPTIONIST' || !receptionist.active || receptionist.branchId !== branchId) {
    throw ApiError.validation('Lễ tân không thuộc chi nhánh này hoặc không còn hoạt động.');
  }

  // An equivalent shift, or one of theirs overlapping this window, already exists.
  const sameDay = await sessionsForBusinessDates({ from: input.businessDate, to: input.businessDate, branchId }, client);
  const sameDayIds = sameDay.filter((x) => x.shiftType === input.shiftType).map((x) => x.id);
  const equivalent =
    sameDayIds.length > 0
      ? await client.receptionShiftSession.findFirst({
          where: { id: { in: sameDayIds }, userId: receptionist.id },
          select: { id: true },
        })
      : null;
  if (equivalent) {
    throw ApiError.conflict(`${def.name} ngày này của lễ tân đã có — chọn ca đó để nhập bù.`, {
      shiftSessionId: equivalent.id,
    });
  }
  // By NOMINAL windows: a session is often closed a few minutes after its end
  // (at the next check-in), and Ca C ending at 06:00 does not overlap Ca A.
  const overlapping = await client.receptionShiftSession.findFirst({
    where: {
      userId: receptionist.id,
      startedAt: { lt: nominalEndAt },
      nominalEndAt: { gt: startedAt },
    },
    select: { id: true },
  });
  if (overlapping) {
    throw ApiError.conflict('Lễ tân đã có một ca trùng thời gian này.', { shiftSessionId: overlapping.id });
  }

  const backfillKey = `${branchId}:${input.businessDate}:${input.shiftType}:${receptionist.id}`;
  let id: string;
  try {
    id = await client.$transaction(async (tx) => {
      const created = await tx.receptionShiftSession.create({
        data: {
          branchId,
          userId: receptionist.id,
          shiftType: input.shiftType,
          receptionistName: receptionist.fullName,
          startedAt,
          nominalEndAt,
          graceEndAt,
          closedAt: nominalEndAt,
          backfilledByUserId: actor.id,
          backfilledByNameSnapshot: actor.fullName,
          backfilledByRole: actor.role,
          backfilledAt: now,
          backfillReason: reason,
          backfillKey,
        },
        select: { id: true },
      });
      await tx.receptionReportAudit.create({
        data: {
          branchId,
          reportId: null,
          shiftSessionId: created.id,
          action: 'SHIFT_BACKFILL',
          field: 'shiftType',
          oldValue: null,
          newValue: input.shiftType,
          reason,
          actorUserId: actor.id,
          actorNameSnapshot: actor.fullName,
          actorShiftType: null,
          actorRole: actor.role,
          createdAt: now,
        },
      });
      return created.id;
    });
  } catch (error) {
    if (error instanceof PrismaNS.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw ApiError.conflict(`${def.name} ngày này của lễ tân vừa được thêm. Vui lòng tải lại.`);
    }
    throw error;
  }
  const session = (await lateEntrySessions(actor, { branchId, businessDate: input.businessDate }, client)).find(
    (x) => x.id === id,
  );
  if (!session) throw new Error('A backfilled shift is missing from its own business date.');
  return session;
}

export interface LateEntryInput {
  shiftSessionId: string;
  reason: string;
}

/**
 * "NHẬP BÙ" — a manager records, now, what the receptionist missed on a
 * finished shift.
 *
 *   * The SHIFT is the original one (`shiftSessionId`), so the record counts on
 *     that business date and shift — in the journal, the totals, the drawer of
 *     that shift and every export — and never in today's.
 *   * The CREATOR is the receptionist who worked that shift (from the session,
 *     never from the request); `enteredBy…` is the manager; `createdAt` is now.
 *   * The REASON is required, and a LATE_ENTRY audit row records it.
 *   * The CONTENT goes through the category's own validation (`buildCreateData`),
 *     the same as any record — a late payment is checked like any payment.
 */
export async function createLateReport(
  input: CreateReportInput & LateEntryInput,
  actor: ReportActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<ReportDetail> {
  return (await createLateReports([input], input, actor, clock, client))[0]!;
}

/** "Nhập bù" of several entries at once (several services of one guest) — all or none. */
export async function createLateReports(
  inputs: CreateReportInput[],
  late: LateEntryInput,
  actor: ReportActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<ReportDetail[]> {
  assertCan(actor.role, 'reports.lateEntry', 'Bạn không có quyền nhập bù báo cáo.');
  const reason = required(late.reason, 'lý do nhập bù');
  if (reason.length > 1000) throw ApiError.validation('Lý do nhập bù quá dài.');
  if (inputs.some((input) => !LATE_ENTRY_CATEGORIES.includes(input.category))) {
    throw ApiError.validation('Sự cố cơ sở vật chất được nhập bù bằng biểu mẫu báo cáo sự cố.');
  }
  const session = await lateEntrySession(late.shiftSessionId, actor, client);
  const now = clock.now();
  const ids = await client.$transaction(async (tx) => {
    const made: string[] = [];
    for (const input of inputs) {
      const data = await buildCreateData(
        input,
        {
          branchId: session.branchId,
          shiftSessionId: session.id,
          shiftType: session.shiftType,
          createdByUserId: session.userId,
          createdByNameSnapshot: session.receptionistName,
          createdByRole: 'RECEPTIONIST',
          category: input.category,
          createdAt: now,
          lateEntry: { userId: actor.id, name: actor.fullName, role: actor.role, reason },
        },
        tx,
      );
      const created = await tx.receptionOperationalReport.create({ data, select: { id: true } });
      await tx.receptionReportAudit.create({
        data: {
          branchId: session.branchId,
          reportId: created.id,
          shiftSessionId: null,
          action: 'LATE_ENTRY',
          reason,
          actorUserId: actor.id,
          actorNameSnapshot: actor.fullName,
          actorShiftType: null,
          actorRole: actor.role,
          createdAt: now,
        },
      });
      made.push(created.id);
    }
    return made;
  });
  const rows = await client.receptionOperationalReport.findMany({ where: { id: { in: ids } }, include: REPORT_INCLUDE });
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

/**
 * The FINISHED shift a late entry goes on, inside the actor's scope — the one
 * check every "Nhập bù" shares.
 */
async function lateEntrySession(shiftSessionId: string, actor: ReportActor, client: PrismaClient) {
  const session = await client.receptionShiftSession.findUnique({
    where: { id: shiftSessionId },
    select: {
      id: true,
      branchId: true,
      userId: true,
      receptionistName: true,
      shiftType: true,
      closedAt: true,
      user: { select: { fullName: true } },
    },
  });
  if (!session) throw ApiError.notFound('Không tìm thấy ca làm việc.');
  assertBranchInScope(actor, session.branchId);
  if (session.closedAt === null) {
    throw ApiError.conflict('Ca này chưa kết thúc — lễ tân đang trong ca tự ghi báo cáo.');
  }
  return session;
}

/**
 * "NHẬP BÙ" OF A FACILITY INCIDENT — the receptionist's missed report, entered
 * by a manager on the ORIGINAL finished shift.
 *
 *   * The INCIDENT is created by `createIssue` — the same location, room
 *     catalog, repeat-link and photo rules as a live report — on that shift
 *     (so it counts on that business date), reported by that shift's
 *     receptionist, with the manager and the reason in `enteredBy…`.
 *   * The JOURNAL ENTRY (category FACILITY_ISSUE) points at it on the same
 *     shift, with the same late-entry stamp and a LATE_ENTRY audit row.
 *   * Both land in ONE transaction: never an incident missing from the shift's
 *     journal, never a journal entry pointing at nothing.
 *
 * `createdAt` is the real entry time on both. The incident then follows its
 * normal lifecycle (it is NEW: Bộ phận kỹ thuật is notified as for any report).
 */
export async function createLateIncident(
  input: CreateIssueInput & LateEntryInput,
  actor: ReportActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<{ issue: IssueDetail; reportId: string }> {
  assertCan(actor.role, 'reports.lateEntry', 'Bạn không có quyền nhập bù báo cáo.');
  const reason = required(input.reason, 'lý do nhập bù');
  if (reason.length > 1000) throw ApiError.validation('Lý do nhập bù quá dài.');
  const session = await lateEntrySession(input.shiftSessionId, actor, client);
  const now = clock.now();
  let reportId = '';
  const issue = await createIssue(
    { ...input, branchId: session.branchId },
    { ...actor, managedBranchIds: actor.managedBranchIds ? [...actor.managedBranchIds] : undefined },
    {
      shiftSessionId: session.id,
      shiftType: session.shiftType,
      branchId: session.branchId,
      reporter: { userId: session.userId, name: session.user.fullName },
      reason,
      now,
      inTransaction: async (tx, issueId) => {
        const data = await buildCreateData(
          { category: 'FACILITY_ISSUE', facility: { issueId } },
          {
            branchId: session.branchId,
            shiftSessionId: session.id,
            shiftType: session.shiftType,
            createdByUserId: session.userId,
            createdByNameSnapshot: session.receptionistName,
            createdByRole: 'RECEPTIONIST',
            category: 'FACILITY_ISSUE',
            createdAt: now,
            lateEntry: { userId: actor.id, name: actor.fullName, role: actor.role, reason },
          },
          tx,
        );
        const created = await tx.receptionOperationalReport.create({ data, select: { id: true } });
        await tx.receptionReportAudit.create({
          data: {
            branchId: session.branchId,
            reportId: created.id,
            shiftSessionId: null,
            action: 'LATE_ENTRY',
            reason,
            actorUserId: actor.id,
            actorNameSnapshot: actor.fullName,
            actorShiftType: null,
            actorRole: actor.role,
            createdAt: now,
          },
        });
        reportId = created.id;
      },
    },
  );
  return { issue, reportId };
}
