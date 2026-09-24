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
import type { Prisma, PrismaClient, ShiftType } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock, hcmDateOnly, type Clock } from '../lib/clock';
import { requireOpenSession, type ShiftActor, type ShiftSessionRow } from '../shift/shiftService';
import { shiftBusinessDate, shiftDefinition, shiftWindowLabel } from '../shift/shiftTypes';
import { ISSUE_INCLUDE, serializeIssue } from '../issue/issueService';
import { describeLocation } from '../issue/issueArea';
import {
  CATEGORY_LABELS,
  PAYMENT_METHOD_LABELS,
  ROOM_SERVICE_LABELS,
  formatVnd,
} from './reportTypes';

export type ReportActor = ShiftActor;

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export const REPORT_INCLUDE = {
  branch: { select: { id: true, code: true, hotelName: true, address: true, branchNumber: true } },
  createdBy: { select: { id: true, fullName: true } },
  voidedBy: { select: { id: true, fullName: true } },
  shiftSession: { select: { id: true, shiftType: true, receptionistName: true, startedAt: true, closedAt: true } },
  payment: true,
  guestRequest: { include: { acceptedBy: { select: { id: true, fullName: true } } } },
  /*
    The LIVE incident, read through the reference — never a copy of it. The
    journal shows the status Bộ phận kỹ thuật has it in right now, which is the
    only status worth showing.
  */
  facility: { include: { issue: { include: ISSUE_INCLUDE } } },
  complaint: true,
  roomService: true,
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
 * A one-line description of a record, for the journal's "TÓM TẮT" column.
 *
 * Built HERE rather than in React so the journal, the Admin list and the export
 * summarise a row identically. It never invents information: every part of it is
 * a field that is on the row.
 */
export function reportSummary(row: ReportDetail): string {
  if (row.payment) {
    const who = row.payment.guestName?.trim() || row.payment.roomNumber?.trim() || 'Khách';
    return `${who} · ${PAYMENT_METHOD_LABELS[row.payment.method]} ${formatVnd(row.payment.amount)}`;
  }
  if (row.guestRequest) {
    const state = row.guestRequest.acceptedAt ? 'đã tiếp nhận' : 'chờ tiếp nhận';
    return `${row.guestRequest.itemType} · ${row.guestRequest.guestName} · ${state}`;
  }
  if (row.facility) {
    const issue = row.facility.issue;
    // The same one-line place description every incident screen uses, so the
    // journal names a room exactly as the Technical queue does.
    return `${describeLocation(issue)} · ${issue.description}`;
  }
  if (row.complaint) {
    return `${row.complaint.guestName} · ${row.complaint.location} · ${row.complaint.description}`;
  }
  if (row.roomService) {
    return `${ROOM_SERVICE_LABELS[row.roomService.serviceType]} · ${row.roomService.guestName} · ${formatVnd(row.roomService.price)}`;
  }
  return CATEGORY_LABELS[row.category];
}

export function serializeReportAudit(row: ReportDetail['audits'][number]) {
  return {
    id: row.id,
    action: row.action,
    field: row.field,
    oldValue: row.oldValue,
    newValue: row.newValue,
    reason: row.reason,
    actor: { id: row.actorUserId, name: row.actorNameSnapshot },
    shiftType: row.actorShiftType,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeReport(row: ReportDetail, now: Date = getClock().now()) {
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
    createdBy: person(row.createdBy),
    /** The name the SHIFT recorded — not the account's current one. */
    createdByName: row.createdByNameSnapshot,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    summary: reportSummary(row),

    voided: row.voidedAt !== null,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    voidedBy: person(row.voidedBy),
    voidedByName: row.voidedByNameSnapshot,
    voidReason: row.voidReason,

    payment: row.payment
      ? {
          ezCode: row.payment.ezCode,
          source: row.payment.source,
          guestName: row.payment.guestName,
          roomNumber: row.payment.roomNumber,
          method: row.payment.method,
          methodLabel: PAYMENT_METHOD_LABELS[row.payment.method],
          amount: row.payment.amount,
          receivable: row.payment.receivable,
          expense: row.payment.expense,
          note: row.payment.note,
          /* The three money columns the table shows, already split by method so
             the screen, the PDF and the XLSX cannot disagree about which column
             a row belongs in. */
          cash: row.payment.method === 'CASH' ? row.payment.amount : 0,
          transfer: row.payment.method === 'TRANSFER' ? row.payment.amount : 0,
          card: row.payment.method === 'CARD' ? row.payment.amount : 0,
        }
      : null,

    guestRequest: row.guestRequest
      ? {
          itemType: row.guestRequest.itemType,
          guestName: row.guestRequest.guestName,
          note: row.guestRequest.note,
          accepted: row.guestRequest.acceptedAt !== null,
          acceptedBy: person(row.guestRequest.acceptedBy),
          acceptedByName: row.guestRequest.acceptedByNameSnapshot,
          acceptedAt: row.guestRequest.acceptedAt
            ? row.guestRequest.acceptedAt.toISOString()
            : null,
          acceptedShiftType: row.guestRequest.acceptedShiftType,
          acceptedShiftName: row.guestRequest.acceptedShiftType
            ? shiftDefinition(row.guestRequest.acceptedShiftType).name
            : null,
        }
      : null,

    facility: row.facility
      ? { issueId: row.facility.issueId, issue: serializeIssue(row.facility.issue, now) }
      : null,

    complaint: row.complaint
      ? {
          guestName: row.complaint.guestName,
          location: row.complaint.location,
          description: row.complaint.description,
        }
      : null,

    roomService: row.roomService
      ? {
          serviceType: row.roomService.serviceType,
          serviceTypeLabel: ROOM_SERVICE_LABELS[row.roomService.serviceType],
          guestName: row.roomService.guestName,
          phone: row.roomService.phone,
          roomNumber: row.roomService.roomNumber,
          roomClass: row.roomService.roomClass,
          fromRoomClass: row.roomService.fromRoomClass,
          toRoomClass: row.roomService.toRoomClass,
          serviceName: row.roomService.serviceName,
          price: row.roomService.price,
          note: row.roomService.note,
        }
      : null,

    audits: row.audits.map(serializeReportAudit),
  };
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
 * ADMIN IS NAMED EXPLICITLY, and everyone else is refused rather than falling
 * through. Bộ phận kỹ thuật works incidents across all eight branches, which
 * makes "not a receptionist" a dangerously close neighbour of "sees everything".
 */
export function reportVisibilityWhere(
  actor: ReportActor,
  filter: { branchId?: number } = {},
): Prisma.ReceptionOperationalReportWhereInput {
  if (actor.role === 'RECEPTIONIST') {
    return { branchId: actor.branchId ?? -1 };
  }
  if (actor.role === 'ADMIN') {
    return filter.branchId !== undefined ? { branchId: filter.branchId } : {};
  }
  throw ApiError.forbidden('Bạn không có quyền xem báo cáo vận hành lễ tân.');
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

export interface PaymentInput {
  ezCode?: string;
  source?: string;
  guestName?: string;
  roomNumber?: string;
  method: 'CASH' | 'TRANSFER' | 'CARD';
  amount: number;
  receivable?: number;
  expense?: number;
  note?: string;
}

export interface GuestRequestInput {
  itemType: string;
  guestName: string;
  note?: string;
}

export interface FacilityInput {
  issueId: string;
}

export interface ComplaintInput {
  guestName: string;
  location: string;
  description: string;
}

export interface RoomServiceInput {
  serviceType: 'ROOM_SALE' | 'UPGRADE' | 'SMOKING' | 'LAUNDRY' | 'OTHER';
  guestName: string;
  phone?: string;
  roomNumber?: string;
  roomClass?: string;
  fromRoomClass?: string;
  toRoomClass?: string;
  serviceName?: string;
  price: number;
  note?: string;
}

/**
 * WHICH FIELDS EACH ROOM-SERVICE SUBTYPE MUST CARRY.
 *
 * The same split as `issue/issueArea.ts`: this table is the authority and the
 * React form READS it to decide what to render. A form that both renders and
 * validates is a form `curl` can skip, and these rows end up in a financial
 * report.
 */
export function normaliseRoomService(input: RoomServiceInput) {
  const guestName = required(input.guestName, 'tên khách');
  const price = assertMoney(input.price, 'Giá tiền');
  const note = optional(input.note);

  switch (input.serviceType) {
    case 'ROOM_SALE':
      return {
        serviceType: input.serviceType,
        guestName,
        phone: optional(input.phone),
        roomClass: required(input.roomClass, 'hạng phòng'),
        roomNumber: null,
        fromRoomClass: null,
        toRoomClass: null,
        serviceName: null,
        price,
        note,
      };
    case 'UPGRADE':
      return {
        serviceType: input.serviceType,
        guestName,
        phone: null,
        roomClass: null,
        roomNumber: optional(input.roomNumber),
        fromRoomClass: required(input.fromRoomClass, 'hạng phòng hiện tại'),
        toRoomClass: required(input.toRoomClass, 'hạng phòng nâng lên'),
        serviceName: null,
        price,
        note,
      };
    case 'SMOKING':
    case 'LAUNDRY':
      return {
        serviceType: input.serviceType,
        guestName,
        phone: null,
        roomClass: null,
        roomNumber: required(input.roomNumber, 'số phòng'),
        fromRoomClass: null,
        toRoomClass: null,
        serviceName: null,
        price,
        note,
      };
    case 'OTHER':
      return {
        serviceType: input.serviceType,
        guestName,
        phone: null,
        roomClass: null,
        roomNumber: required(input.roomNumber, 'số phòng'),
        fromRoomClass: null,
        toRoomClass: null,
        serviceName: required(input.serviceName, 'loại hình dịch vụ'),
        price,
        note,
      };
  }
}

export type CreateReportInput =
  | { category: 'PAYMENT'; payment: PaymentInput }
  | { category: 'GUEST_REQUEST'; guestRequest: GuestRequestInput }
  | { category: 'FACILITY_ISSUE'; facility: FacilityInput }
  | { category: 'CUSTOMER_COMPLAINT'; complaint: ComplaintInput }
  | { category: 'ROOM_SERVICE'; roomService: RoomServiceInput };

/**
 * Create one journal entry.
 *
 * THE SHIFT IS RESOLVED FIRST AND THE REQUEST IS NEVER ASKED FOR IT. The session
 * decides the branch, the shift type, the employee and the employee's name; the
 * clock decides `createdAt`. What the caller supplies is only the content.
 */
export async function createReport(
  input: CreateReportInput,
  actor: ReportActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<ReportDetail> {
  if (actor.role !== 'RECEPTIONIST') {
    throw ApiError.forbidden('Chỉ lễ tân mới ghi được báo cáo vận hành.');
  }
  const session = await requireOpenSession(actor, client);
  const now = clock.now();

  const base = {
    branchId: session.branchId,
    shiftSessionId: session.id,
    shiftType: session.shiftType,
    createdByUserId: actor.id,
    createdByNameSnapshot: session.receptionistName,
    category: input.category,
    createdAt: now,
  };

  const data: Prisma.ReceptionOperationalReportCreateInput = await buildCreateData(
    input,
    base,
    session,
    client,
  );

  const created = await client.receptionOperationalReport.create({
    data,
    include: REPORT_INCLUDE,
  });
  return created;
}

async function buildCreateData(
  input: CreateReportInput,
  base: {
    branchId: number;
    shiftSessionId: string;
    shiftType: ShiftType;
    createdByUserId: number;
    createdByNameSnapshot: string;
    category: CreateReportInput['category'];
    createdAt: Date;
  },
  session: ShiftSessionRow,
  client: PrismaClient,
): Promise<Prisma.ReceptionOperationalReportCreateInput> {
  const scalars = {
    branch: { connect: { id: base.branchId } },
    shiftSession: { connect: { id: base.shiftSessionId } },
    shiftType: base.shiftType,
    createdBy: { connect: { id: base.createdByUserId } },
    createdByNameSnapshot: base.createdByNameSnapshot,
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
          create: {
            ezCode: optional(p.ezCode),
            source: optional(p.source),
            guestName: optional(p.guestName),
            roomNumber: optional(p.roomNumber),
            method: p.method,
            amount: assertMoney(p.amount, 'Số tiền'),
            receivable: assertMoney(p.receivable ?? 0, 'Công nợ'),
            expense: assertMoney(p.expense ?? 0, 'Chi tiền'),
            note: optional(p.note),
          },
        },
      };
    }
    case 'GUEST_REQUEST':
      return {
        ...scalars,
        guestRequest: {
          create: {
            itemType: required(input.guestRequest.itemType, 'loại ký gửi'),
            guestName: required(input.guestRequest.guestName, 'tên khách'),
            note: optional(input.guestRequest.note),
          },
        },
      };
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
        select: { id: true, branchId: true },
      });
      if (!issue) throw ApiError.validation('Không tìm thấy sự cố được tham chiếu.');
      if (issue.branchId !== session.branchId) {
        throw ApiError.branchAccessDenied('Sự cố không thuộc chi nhánh của bạn.');
      }
      return { ...scalars, facility: { create: { issue: { connect: { id: issue.id } } } } };
    }
    case 'CUSTOMER_COMPLAINT':
      return {
        ...scalars,
        complaint: {
          create: {
            guestName: required(input.complaint.guestName, 'tên khách'),
            location: required(input.complaint.location, 'số phòng hoặc vị trí'),
            description: required(input.complaint.description, 'mô tả'),
          },
        },
      };
    case 'ROOM_SERVICE':
      return { ...scalars, roomService: { create: normaliseRoomService(input.roomService) } };
  }
}

/* ------------------------------------------------------------------ *
 * Listing
 * ------------------------------------------------------------------ */

export interface ListReportsFilter {
  branchId?: number;
  category?: CreateReportInput['category'];
  shiftSessionId?: string;
  /**
   * Only rows written on one of these shifts. This is how a BUSINESS DATE is
   * applied: the caller resolves the day to its sessions (`businessDate.ts`)
   * and the rows follow their shift, wherever their own timestamps fall. An
   * empty list matches nothing — a day with no shifts has no records.
   */
  shiftSessionIds?: string[];
  /** Half-open [from, to) instants, already resolved from HCM calendar days. */
  from?: Date;
  to?: Date;
  /** Voided rows are INCLUDED by default — they are part of the audit record. */
  includeVoided?: boolean;
  take?: number;
}

export function reportWhere(
  actor: ReportActor,
  filter: ListReportsFilter,
): Prisma.ReceptionOperationalReportWhereInput {
  const where: Prisma.ReceptionOperationalReportWhereInput = reportVisibilityWhere(actor, filter);
  if (filter.category) where.category = filter.category;
  if (filter.shiftSessionId) where.shiftSessionId = filter.shiftSessionId;
  else if (filter.shiftSessionIds) where.shiftSessionId = { in: filter.shiftSessionIds };
  if (filter.from || filter.to) {
    where.createdAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lt: filter.to } : {}),
    };
  }
  if (filter.includeVoided === false) where.voidedAt = null;
  return where;
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
  if (actor.role === 'RECEPTIONIST') {
    if (row.branchId !== actor.branchId) {
      throw ApiError.branchAccessDenied('Báo cáo không thuộc chi nhánh của bạn.');
    }
    return row;
  }
  /*
    ADMIN IS REFUSED A WRITE HERE, DELIBERATELY.

    The specification is explicit that "Admin does NOT need operational Reception
    editing", and an Admin silently correcting a branch's cash row would break
    the one guarantee that makes this journal worth keeping: that each record
    says which receptionist entered it and who, if anyone, changed it afterwards.
    Admin reads everything; the desk owns its own corrections.
  */
  throw ApiError.forbidden('Chỉ lễ tân của chi nhánh mới sửa được báo cáo.');
}

/** The fields each category allows a correction to touch. */
const EDITABLE: Record<CreateReportInput['category'], readonly string[]> = {
  PAYMENT: ['ezCode', 'source', 'guestName', 'roomNumber', 'method', 'amount', 'receivable', 'expense', 'note'],
  GUEST_REQUEST: ['itemType', 'guestName', 'note'],
  /*
    A facility entry has NOTHING TO CORRECT. Its only field is the incident it
    points at, and pointing it somewhere else would not be a correction — it
    would be a different report. The wrong one is voided and a new one written.
  */
  FACILITY_ISSUE: [],
  CUSTOMER_COMPLAINT: ['guestName', 'location', 'description'],
  ROOM_SERVICE: ['guestName', 'phone', 'roomNumber', 'roomClass', 'fromRoomClass', 'toRoomClass', 'serviceName', 'price', 'note'],
};

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

  const session = await requireOpenSession(actor, client);
  const allowed = EDITABLE[current.category];
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
  };
  const supplied: Record<string, unknown> = suppliedByCategory[current.category] ?? {};

  const reason = optional(patch.reason);

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
      },
    });
    if (!fresh) throw ApiError.notFound('Không tìm thấy báo cáo.');
    if (fresh.voidedAt) throw ApiError.conflict('Báo cáo đã bị hủy, không thể sửa.');

    const detail = (fresh.payment ?? fresh.guestRequest ?? fresh.complaint ?? fresh.roomService) as
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
      const next = MONEY_FIELDS.has(field)
        ? assertMoney(raw, moneyLabel(field))
        : field === 'method'
          ? assertMethod(raw)
          : normaliseText(field, raw, current.category);
      const before = detail[field] ?? null;
      if (auditValue(before) === auditValue(next)) continue;
      data[field] = next;
      guard[field] = before;
      changes.push({ field, oldValue: auditValue(before), newValue: auditValue(next) });
    }

    if (changes.length === 0) return fresh.id;

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
        shiftSessionId: session.id,
        action: 'EDIT' as const,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        reason,
        actorUserId: actor.id,
        actorNameSnapshot: session.receptionistName,
        actorShiftType: session.shiftType,
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

function moneyLabel(field: string): string {
  if (field === 'amount') return 'Số tiền';
  if (field === 'receivable') return 'Công nợ';
  if (field === 'expense') return 'Chi tiền';
  return 'Giá tiền';
}

function assertMethod(raw: unknown): 'CASH' | 'TRANSFER' | 'CARD' {
  if (raw === 'CASH' || raw === 'TRANSFER' || raw === 'CARD') return raw;
  throw ApiError.validation('Phương thức thanh toán không hợp lệ.');
}

/** Which text fields may become empty, and which may not. */
const TEXT_REQUIRED: Record<string, string> = {
  itemType: 'loại ký gửi',
  guestName: 'tên khách',
  location: 'số phòng hoặc vị trí',
  description: 'mô tả',
  serviceName: 'loại hình dịch vụ',
  roomClass: 'hạng phòng',
  fromRoomClass: 'hạng phòng hiện tại',
  toRoomClass: 'hạng phòng nâng lên',
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
const ROOM_SERVICE_OPTIONAL = new Set(['roomClass', 'fromRoomClass', 'toRoomClass', 'serviceName']);

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
  const session = await requireOpenSession(actor, client);

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
        voidedByNameSnapshot: session.receptionistName,
        voidReason: trimmed,
      },
    });
    if (count === 0) throw ApiError.conflict('Báo cáo đã bị hủy trước đó.');

    await tx.receptionReportAudit.create({
      data: {
        branchId: current.branchId,
        reportId: id,
        shiftSessionId: session.id,
        action: 'VOID',
        reason: trimmed,
        actorUserId: actor.id,
        actorNameSnapshot: session.receptionistName,
        actorShiftType: session.shiftType,
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
 * "NGƯỜI TIẾP NHẬN" — a second, separate actor on a guest request.
 *
 * It writes only the acceptance columns and never touches the creation ones. A
 * bag taken on Ca A and returned on Ca B has two names on it afterwards, and the
 * first one is still the answer to "who took it?".
 *
 * Guarded by `acceptedAt: null` in the update itself, so two receptionists
 * accepting at once produce one acceptance rather than the later overwriting the
 * earlier.
 */
export async function acceptGuestRequest(
  id: string,
  actor: ReportActor,
  clock: Clock = getClock(),
  client: PrismaClient = prisma,
): Promise<ReportDetail> {
  const now = clock.now();
  const current = await loadOwn(id, actor, client);
  if (current.category !== 'GUEST_REQUEST' || !current.guestRequest) {
    throw ApiError.validation('Chỉ yêu cầu của khách mới cần tiếp nhận.');
  }
  if (current.voidedAt) throw ApiError.conflict('Báo cáo đã bị hủy.');
  if (current.guestRequest.acceptedAt) {
    throw ApiError.conflict('Yêu cầu này đã được tiếp nhận.');
  }
  const session = await requireOpenSession(actor, client);

  const { count } = await client.guestRequestReport.updateMany({
    where: { reportId: id, acceptedAt: null },
    data: {
      acceptedByUserId: actor.id,
      acceptedByNameSnapshot: session.receptionistName,
      acceptedAt: now,
      acceptedShiftSessionId: session.id,
      acceptedShiftType: session.shiftType,
    },
  });
  if (count === 0) throw ApiError.conflict('Yêu cầu này đã được tiếp nhận.');

  return client.receptionOperationalReport.findUniqueOrThrow({
    where: { id },
    include: REPORT_INCLUDE,
  });
}
