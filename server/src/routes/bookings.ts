import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock } from '../lib/clock';
import { requireAuth, requireAdmin, requirePasswordChanged, requireRole } from '../middleware/auth';
import { proofUpload } from '../middleware/upload';
import { parseBooking } from '../booking/parser';
import { parseAgodaBooking } from '../booking/agoda';
import { parseCtripBooking } from '../booking/ctrip';
import { loadBranchConfigs } from '../booking/branchConfig';
import { detectBusinessType } from '../booking/businessType';
import { persistDraftBooking, snapshotRoomClasses } from '../booking/store';
import { serializeBookingPreview, serializeParsedPreview } from '../booking/serialize';
import {
  BOOKING_LIST_INCLUDE,
  serializeCompletedListItem,
  serializeHistoryListItem,
  serializeNewListItem,
  serializeOpsBookingDetail,
} from '../booking/bookingView';
import { loadBookingDetail } from '../booking/bookingRepo';
import { NOT_DELETED } from '../booking/deleteBooking';
import { approveProof, rejectProof, submitProof, authorizeProofImage } from '../booking/proof';
import {
  CUT_FIELDS,
  activeQueueWhere,
  claimBooking,
  cutBookingField,
  cutFieldsFor,
  resendBooking,
  type CutField,
} from '../booking/claim';
import { readProofFile } from '../booking/proofStorage';
import { analyzeAfterSubmit } from '../booking/ocr/analysisService';
import { isTest } from '../config/env';
import type { UserWithBranch } from '../auth/serialize';
import type { SessionUser } from '../middleware/auth';
import { branchScopeOf, isReceptionSupervisor, scopeIncludes, scopedBranchFilter } from '../auth/branchScope';

const extractSchema = z.object({
  rawText: z.string().min(1, 'Nội dung không được để trống.').max(50000, 'Nội dung quá dài.'),
  // Only the platforms that actually HAVE an intake parser. Tripadvisor and
  // Traveloka are valid identity platforms but are refused here, so a booking
  // can never claim a source the system cannot extract.
  source: z.enum(['BOOKING_COM', 'AGODA', 'CTRIP']).default('BOOKING_COM'),
});

const submitProofSchema = z.object({ note: z.string().trim().max(1000).optional() });
const rejectSchema = z.object({
  // Optional here so a missing reason surfaces the specific REVIEW_REASON_REQUIRED
  // (422) from the service rather than a generic validation error; an invalid
  // non-enum value still fails schema validation.
  reasonCode: z
    .enum([
      'WRONG_CUSTOMER_NAME',
      'WRONG_BOOKING_CODE',
      'WRONG_DATES',
      'WRONG_ROOM_COUNT',
      'WRONG_ROOM_TYPE',
      'WRONG_PRICE',
      'MISSING_ROOM',
      'UNCLEAR_IMAGE',
      'OTHER',
    ])
    .optional(),
  reviewNote: z.string().trim().max(1000).optional(),
});

const paginationSchema = {
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
};

const newListQuery = z.object({ branchId: z.coerce.number().int().positive().optional(), ...paginationSchema });
const completedListQuery = z.object({ branchId: z.coerce.number().int().positive().optional(), ...paginationSchema });
const expiredClaimsQuery = z.object({ branchId: z.coerce.number().int().positive().optional(), ...paginationSchema });

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * An enum filter that also accepts a comma-separated list.
 *
 * PURELY ADDITIVE. `status=NEW` parses to `['NEW']` and is applied as the
 * scalar equality it always was, so every existing caller produces the same
 * query it produced before. `status=NEW,RECEIVED` is a form that previously
 * failed validation with a 422 — there is no request whose meaning changes.
 *
 * The multi-value form exists because the operation centre needs filters the
 * single form cannot express: an "OTA" tab is Agoda OR CTrip, and a
 * multi-select status filter is several statuses at once. The alternative was
 * merging two paginated responses in the client, which yields a wrong total
 * and a meaningless second page.
 */
function csvEnum<T extends readonly [string, ...string[]]>(values: T) {
  const single = z.enum(values);
  return z
    .string()
    .transform((raw) => raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
    .pipe(z.array(single).min(1).max(values.length))
    .optional();
}

/** `undefined`, a scalar for one value, or a Prisma `in` filter for several. */
function oneOf<T extends string>(values: T[] | undefined): T | { in: T[] } | undefined {
  if (!values || values.length === 0) return undefined;
  return values.length === 1 ? values[0]! : { in: values };
}

const STATUS_VALUES = [
  'DRAFT', 'READY', 'NEW', 'COMPLETED', 'ARCHIVED',
  'RECEIVED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW',
] as const;
const SOURCE_VALUES = ['BOOKING_COM', 'AGODA', 'CTRIP'] as const;
const VERIFICATION_VALUES = ['NOT_SUBMITTED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const;

/**
 * The history query, extended into the operational search.
 *
 * Every addition is OPTIONAL and additive: an existing caller that sends none
 * of the new parameters gets exactly the results it did before. The one
 * behavioural change is that `search` is now case-insensitive — see the handler.
 *
 * `status` accepts the operational states as well as the original five. Without
 * them a dispatched OTA booking could never be filtered to "checked in", which
 * is the state an operator most often looks for.
 */
const historyQuery = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  branchId: z.coerce.number().int().positive().optional(),
  status: csvEnum(STATUS_VALUES),
  /** Which platform the reservation came from. */
  source: csvEnum(SOURCE_VALUES),
  verificationStatus: csvEnum(VERIFICATION_VALUES),
  country: z.string().trim().min(1).max(100).optional(),
  language: z.string().trim().min(1).max(100).optional(),
  paymentStatus: z.enum(['PAY_BEFORE', 'PAY_AFTER']).optional(),
  isLastMinute: z.enum(['true', 'false']).optional(),
  sentFrom: isoDay.optional(),
  sentTo: isoDay.optional(),
  checkInFrom: isoDay.optional(),
  checkInTo: isoDay.optional(),
  checkOutFrom: isoDay.optional(),
  checkOutTo: isoDay.optional(),
  createdFrom: isoDay.optional(),
  createdTo: isoDay.optional(),
  updatedFrom: isoDay.optional(),
  updatedTo: isoDay.optional(),
  completedFrom: isoDay.optional(),
  completedTo: isoDay.optional(),
  sort: z
    .enum([
      'sentAt', 'checkInDate', 'checkOutDate', 'completedAt', 'createdAt',
      'updatedAt', 'customerName', 'totalAmount', 'status', 'sourcePlatform',
    ])
    .optional(),
  /** Ascending is opt-in; every existing caller keeps newest-first. */
  order: z.enum(['asc', 'desc']).optional(),
  ...paginationSchema,
});

function dayStart(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
function dayAfter(iso: string): Date {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
function rangeFilter(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  const filter: Prisma.DateTimeFilter = {};
  if (from) filter.gte = dayStart(from);
  if (to) filter.lt = dayAfter(to);
  return filter;
}

function paginate(page: number, pageSize: number): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}
function meta(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/**
 * The branch a receptionist is locked to. Admins may target any branch (or none
 * for "all"). A receptionist's own branch always wins over any client-supplied
 * branchId, so branch isolation cannot be bypassed from the query string.
 *
 * A Quản lý lễ tân reads its assigned branches and a Tổng quản lý lễ tân every
 * branch — narrowed to the one asked for, and REFUSED (403) for a branch outside
 * the scope — through the same `scopedBranchFilter` as every reception read.
 */
function branchScope(user: SessionUser, requested: number | undefined): number | { in: number[] } | undefined {
  if (user.role === 'ADMIN') return requested;
  if (isReceptionSupervisor(user.role)) return scopedBranchFilter(user, requested).branchId;
  return user.branchId ?? -1; // -1 never matches, so an unassigned receptionist sees nothing
}

/**
 * The acting user, plus the request correlation id so booking-scoped audit
 * events can be tied back to one HTTP request. The id is opaque metadata — it
 * is never a credential and never identifies anything but the request.
 */
function actor(user: UserWithBranch, correlationId?: string) {
  return {
    id: user.id,
    role: user.role,
    branchId: user.branchId,
    fullName: user.fullName,
    correlationId: correlationId ?? null,
  };
}

/**
 * WHO WORKS AN ORDER: the Admin who dispatches it and the receptionist who
 * creates it in the hotel system. An ALLOW-LIST, for the same reason as in
 * bookingLifecycle.ts — the branch and claim checks downstream are written as
 * `actor.role === 'RECEPTIONIST' && …`, so a role that is not a receptionist
 * skips them rather than failing them. Naming the two roles that belong here
 * means a future department gets nothing by default.
 */
const requireBookingOperator = requireRole('ADMIN', 'RECEPTIONIST');

export function createBookingsRouter(): Router {
  const router = Router();

  /**
   * POST /api/bookings/extract — Admin-only: parse raw text into a review.
   *
   * ── TWO BEHAVIOURS, ON PURPOSE ────────────────────────────────────────────
   * BOOKING.COM returns a PREVIEW and writes nothing. The reservation is
   * reviewed in the browser and created once, at Send, by
   * `POST /api/admin/bookings/dispatch`. Extracting is no longer an act of
   * record: an Admin who pastes the wrong page, changes their mind, or closes
   * the tab leaves nothing behind.
   *
   * AGODA and CTRIP are UNCHANGED. They still persist a DRAFT here. Their
   * production review path is `POST /api/admin/ota/*`, which already creates its
   * booking in one transaction and never touches this route — so this is a
   * legacy intake that other callers and tests still rely on, and quietly
   * changing it would alter two platforms that were not part of this work.
   */
  router.post('/bookings/extract', requireAuth, requirePasswordChanged, requireAdmin, (req, res, next) => {
    (async () => {
      const { rawText, source } = extractSchema.parse(req.body);
      // One load of the routing configuration (active branches + their active
      // platform aliases); the parsers stay pure and never query the database.
      const branches = await loadBranchConfigs();

      // Every adapter returns the identical normalized structure; only the
      // source stamp, the platform its hotel name is recognised against, and a
      // few label/prepaid variants differ. The chosen source is preserved
      // verbatim on the stored booking — a CTrip booking is never filed as
      // Agoda, even though the two share property names today.
      const parsed =
        source === 'AGODA'
          ? parseAgodaBooking(rawText, branches)
          : source === 'CTRIP'
            ? parseCtripBooking(rawText, branches)
            : parseBooking(rawText, branches, 'BOOKING_COM');
      // The same deterministic detection the dispatch re-runs, surfaced in the
      // preview so the Admin sees the type + confidence and can confirm/override.
      const business = detectBusinessType({
        rawText,
        roomType: parsed.rooms[0]?.roomName ?? null,
        specialRequest: parsed.specialRequest,
      });

      /*
        BOOKING.COM: preview only. Nothing is written — no Booking, no
        BookingRoom, no BookingNightPrice, no room-class snapshot.

        Room classes are not resolved here either, and cannot be: resolution is
        scoped to a branch, and the Admin chooses the branch DURING the review
        that has not happened yet. The screen asks
        `POST /api/admin/branches/:branchId/room-mapping/resolve` once it has
        one, and the dispatch resolves authoritatively when the order is sent.
      */
      if (source === 'BOOKING_COM') {
        res.status(201).json({
          ...serializeParsedPreview(parsed, 'BOOKING_COM', branches),
          branchMatchScore: parsed.branchMatchScore,
          branchConfidence: parsed.branchConfidence,
          branchConfident: parsed.branchConfident,
          requiresManualConfirmation: parsed.requiresManualConfirmation,
          fieldConfidence: parsed.fieldConfidence,
          parserQuality: parsed.parserQuality,
          businessType: business.type,
          businessTypeConfidence: business.confidence,
          businessTypeRequiresAdminConfirmation: business.requiresAdminConfirmation,
          businessTypeMatchedRules: business.matchedRules,
          agoda: null,
        });
        return;
      }

      const bookingId = await persistDraftBooking(parsed, rawText, req.currentUser?.id ?? null, source);
      // Branch-specific room codes, captured as an immutable snapshot.
      await snapshotRoomClasses(bookingId);

      const stored = await prisma.booking.findUniqueOrThrow({
        where: { id: bookingId },
        include: { branch: true, rooms: { include: { nights: true } }, warnings: true },
      });

      const preview = serializeBookingPreview(stored);
      const candidateBranch = preview.suggestedBranch
        ? preview.suggestedBranch
        : parsed.suggestedBranch
          ? {
              id: parsed.suggestedBranch.id,
              code: parsed.suggestedBranch.code,
              hotelName: parsed.suggestedBranch.hotelName,
              address: parsed.suggestedBranch.address,
              branchNumber:
                branches.find((b) => b.id === parsed.suggestedBranch?.id)?.branchNumber ?? 0,
            }
          : null;

      res.status(201).json({
        ...preview,
        suggestedBranch: candidateBranch,
        branchMatchScore: parsed.branchMatchScore,
        branchConfidence: parsed.branchConfidence,
        branchConfident: parsed.branchConfident,
        requiresManualConfirmation: parsed.requiresManualConfirmation,
        fieldConfidence: parsed.fieldConfidence,
        parserQuality: parsed.parserQuality,
        businessType: business.type,
        businessTypeConfidence: business.confidence,
        businessTypeRequiresAdminConfirmation: business.requiresAdminConfirmation,
        businessTypeMatchedRules: business.matchedRules,
        // Present only for an Agoda hotel-partner email: structured partner fields
        // plus the exact two-line PMS note the receptionist copies.
        agoda: parsed.agoda ?? null,
      });
    })().catch(next);
  });

  /**
   * Shared handler for the three "still operationally NEW" verification lists,
   * distinguished only by verificationStatus:
   *   NOT_SUBMITTED + APPROVED -> "Đơn mới" / "Chờ chi nhánh tạo"
   *   PENDING_REVIEW           -> "Chờ Admin kiểm tra" / "Chờ kiểm tra"
   *   REJECTED                 -> "Cần tạo lại"
   *
   * WHY APPROVED SITS IN THE FIRST LIST:
   * proof approval no longer completes a booking — the two lifecycles are
   * independent — so an approved booking stays at NEW until reception receives
   * it. Filtering on a single verificationStatus meant APPROVED matched none of
   * the three lists and the booking was not in "completed" either: it vanished
   * from every reception screen while still needing to be received and checked
   * in. Both NOT_SUBMITTED and APPROVED mean the same thing to a receptionist —
   * nothing is pending from an Admin, the branch must act — so they share a
   * list. A booking is therefore visible on some reception screen at every
   * point in its life.
   * Branch isolation is enforced through branchScope, so a receptionist can never
   * widen the list to another branch via the query string.
   */
  function newStageList(
    verificationStatuses: readonly ('NOT_SUBMITTED' | 'PENDING_REVIEW' | 'REJECTED' | 'APPROVED')[],
  ) {
    return (req: Request, res: Response, next: NextFunction) => {
      (async () => {
        const user = req.currentUser!;
        const query = newListQuery.parse(req.query);
        const branchId = branchScope(user, query.branchId);

        const where: Prisma.BookingWhereInput = {
          ...NOT_DELETED,
          status: 'NEW',
          verificationStatus: { in: [...verificationStatuses] },
        };
        if (branchId !== undefined) where.branchId = branchId;

        /*
          AN ELAPSED ORDER LEAVES RECEPTION'S QUEUE THE MOMENT IT ELAPSES.

          Not swept, not flagged — filtered, so the disappearance needs no
          scheduler and cannot lag behind the deadline. The order is not gone:
          it is in the Admin "Gửi lại đơn" list, and an Admin sending it back is
          what returns it here.

          ADMIN IS DELIBERATELY EXEMPT. Their "Chờ chi nhánh tạo" screen is an
          overview of everything dispatched, and an order silently vanishing
          from it would hide the very lapse they are being asked to act on.

          PENDING_REVIEW carries no claim, so the filter is limited to the two
          claimable stages rather than applied to every list.
        */
        const claimable = verificationStatuses.some(
          (status) => status === 'NOT_SUBMITTED' || status === 'REJECTED',
        );
        // A reception manager reads the queue exactly as the desk sees it.
        if ((user.role === 'RECEPTIONIST' || (user.role !== 'ADMIN' && isReceptionSupervisor(user.role))) && claimable) {
          Object.assign(where, activeQueueWhere(getClock().now()));
        }

        const now = getClock().now();
        const { skip, take } = paginate(query.page, query.pageSize);
        const [total, rows] = await prisma.$transaction([
          prisma.booking.count({ where }),
          prisma.booking.findMany({
            where,
            include: BOOKING_LIST_INCLUDE,
            orderBy: [{ isLastMinute: 'desc' }, { checkInDate: 'asc' }, { sentAt: 'asc' }],
            skip,
            take,
          }),
        ]);

        /*
          WHEN THE RESPONSE CLOCK STARTED, per order.

          The SLA measures Admin-sent → reception-started, so it restarts every
          time an order is put in front of reception again. `sentAt` alone is not
          that instant: the claim-expiry resend deliberately does NOT touch
          `sentAt` — it releases a lapsed claim and leaves the dispatch record
          alone — so an order resent at 15:00 would otherwise be measured from
          its original 09:00 send and read as hours overdue the moment it
          reappeared.

          The resend already leaves an authoritative mark: a BOOKING_RESENT audit
          row. Taking the later of the two reads the real "most recently put in
          front of reception" instant out of data that already exists — no new
          column, and no change to a claim workflow that is working.

          One grouped query for the whole page, never one per row.
        */
        const resentAt = new Map<string, Date>();
        if (rows.length > 0) {
          const groups = await prisma.bookingAuditEvent.groupBy({
            by: ['bookingId'],
            // A "Cần tạo lại" verdict puts the order in front of reception again, like a resend.
            where: { bookingId: { in: rows.map((r) => r.id) }, action: { in: ['BOOKING_RESENT', 'BOOKING_PROOF_REJECTED'] } },
            _max: { createdAt: true },
          });
          for (const g of groups) {
            if (g._max.createdAt) resentAt.set(g.bookingId, g._max.createdAt);
          }
        }

        const bookings = rows.map((row) => {
          const resent = resentAt.get(row.id) ?? null;
          const startedAt =
            row.sentAt && resent
              ? row.sentAt > resent
                ? row.sentAt
                : resent
              : (resent ?? row.sentAt);
          return { ...serializeNewListItem(row), slaStartedAt: startedAt?.toISOString() ?? null };
        });

        res.json({
          bookings,
          pagination: meta(query.page, query.pageSize, total),
          // The client renders the SLA as (slaStartedAt + window − serverNow), so
          // a wrong or wound-back PC clock cannot flatter the response time.
          serverNow: now.toISOString(),
        });
      })().catch(next);
    };
  }

  /**
   * POST /api/bookings/:id/claim — "CUT", the receptionist takes ownership.
   *
   * This is the duplicate-booking control. Two receptionists at a branch see
   * the same queue; the atomic claim inside `claimBooking` decides which of
   * them owns the creation work, and the loser is told who beat them.
   */
  router.post('/bookings/:id/claim', requireAuth, requirePasswordChanged, requireBookingOperator, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const id = req.params.id;
      if (!id) throw ApiError.notFound('Không tìm thấy đơn.');
      const result = await claimBooking(
        id,
        { id: user.id, role: user.role, branchId: user.branchId },
        prisma,
        getClock(),
      );
      res.json({
        claimedAt: result.claimedAt.toISOString(),
        claimExpiresAt: result.claimExpiresAt.toISOString(),
        claimCycle: result.claimCycle,
        // The client renders the countdown as (claimExpiresAt - serverNow), so
        // a wrong or wound-back PC clock cannot lengthen the window.
        serverNow: getClock().now().toISOString(),
      });
    })().catch(next);
  });

  /**
   * POST /api/bookings/:id/cut — take ONE field off the order.
   *
   * This is the receptionist's only entry into the claim: there is no separate
   * "take the order" button, so the first CẮT is what locks the booking and
   * starts the three minutes. Later CẮTs in the same cycle return the SAME
   * deadline untouched.
   */
  router.post('/bookings/:id/cut', requireAuth, requirePasswordChanged, requireBookingOperator, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const id = req.params.id;
      if (!id) throw ApiError.notFound('Không tìm thấy đơn.');

      const field = (req.body ?? {}).field as unknown;
      if (typeof field !== 'string' || !(CUT_FIELDS as readonly string[]).includes(field)) {
        throw ApiError.validation('Trường cần cắt không hợp lệ.', {
          field: `Chỉ chấp nhận: ${CUT_FIELDS.join(', ')}.`,
        });
      }

      const result = await cutBookingField(
        id,
        field as CutField,
        { id: user.id, role: user.role, branchId: user.branchId },
        prisma,
        getClock(),
      );
      res.json({
        claimedAt: result.claimedAt.toISOString(),
        claimExpiresAt: result.claimExpiresAt.toISOString(),
        claimCycle: result.claimCycle,
        cutFields: result.cutFields,
        serverNow: getClock().now().toISOString(),
      });
    })().catch(next);
  });

  /**
   * GET /api/bookings/expired-claims — the Admin "Gửi lại đơn" list.
   *
   * Expiry is DERIVED here, not swept by a scheduler: an order qualifies when
   * a claim is held and its stored deadline has passed, and it has not been
   * completed (a submitted proof leaves NOT_SUBMITTED/REJECTED).
   */
  router.get('/bookings/expired-claims', requireAuth, requirePasswordChanged, requireAdmin, (req, res, next) => {
    (async () => {
      const query = expiredClaimsQuery.parse(req.query ?? {});
      const now = getClock().now();
      const where: Prisma.BookingWhereInput = {
        ...NOT_DELETED,
        status: 'NEW',
        verificationStatus: { in: ['NOT_SUBMITTED', 'REJECTED'] },
        claimedByUserId: { not: null },
        claimExpiresAt: { lt: now },
      };
      if (query.branchId !== undefined) where.branchId = query.branchId;

      const { skip, take } = paginate(query.page, query.pageSize);
      const [total, rows] = await prisma.$transaction([
        prisma.booking.count({ where }),
        prisma.booking.findMany({
          where,
          include: BOOKING_LIST_INCLUDE,
          orderBy: [{ claimExpiresAt: 'asc' }],
          skip,
          take,
        }),
      ]);
      res.json({
        bookings: rows.map(serializeNewListItem),
        pagination: meta(query.page, query.pageSize, total),
        serverNow: now.toISOString(),
      });
    })().catch(next);
  });

  /**
   * POST /api/bookings/:id/resend — Admin returns an expired order to reception.
   *
   * Conditional on the claim still being expired, so a double-clicked button
   * cannot increment the cycle twice.
   */
  router.post('/bookings/:id/resend', requireAuth, requirePasswordChanged, requireAdmin, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const id = req.params.id;
      if (!id) throw ApiError.notFound('Không tìm thấy đơn.');
      const result = await resendBooking(
        id,
        { id: user.id, role: user.role, branchId: user.branchId },
        prisma,
        getClock(),
      );
      res.json({ success: true, claimCycle: result.claimCycle });
    })().catch(next);
  });

  // GET /api/bookings/new — dispatched work the BRANCH must act on: no proof
  // submitted yet, or a proof already approved and the stay still to be run.
  // "Đơn mới" holds both stages that need creating: a fresh order, and one the
  // Admin sent back as "Cần tạo lại" (its badge says which).
  router.get('/bookings/new', requireAuth, requirePasswordChanged, newStageList(['NOT_SUBMITTED', 'REJECTED']));
  // GET /api/bookings/pending-review — proof submitted, awaiting admin verdict.
  router.get('/bookings/pending-review', requireAuth, requirePasswordChanged, newStageList(['PENDING_REVIEW']));
  // GET /api/bookings/rejected — proof rejected, needs recreation ("Cần tạo lại").
  router.get('/bookings/rejected', requireAuth, requirePasswordChanged, newStageList(['REJECTED']));

  // GET /api/bookings/completed — the "Đã hoàn thành" list.
  router.get('/bookings/completed', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const query = completedListQuery.parse(req.query);
      const branchId = branchScope(user, query.branchId);

      /*
        The "Đã xác nhận đúng" list, which is what the nav has always called it.
        It filtered on the LIFECYCLE status alone, and since proof approval was
        decoupled from completion an approved booking no longer reaches that
        status — so the confirmed list held none of them.

        That did not show while approved bookings stayed in the reception queue.
        Now that they leave it on approval, filtering on status alone would put
        them on no list at all, which is the invisibility this queue exists to
        prevent. Both are accepted: the list only GAINS rows, so nothing that
        appeared here before has stopped appearing.
      */
      const where: Prisma.BookingWhereInput = {
        ...NOT_DELETED,
        OR: [{ status: 'COMPLETED' }, { verificationStatus: 'APPROVED' }],
      };
      if (branchId !== undefined) where.branchId = branchId;

      const { skip, take } = paginate(query.page, query.pageSize);
      const [total, rows] = await prisma.$transaction([
        prisma.booking.count({ where }),
        prisma.booking.findMany({
          where,
          include: BOOKING_LIST_INCLUDE,
          orderBy: [{ completedAt: 'desc' }],
          skip,
          take,
        }),
      ]);

      res.json({ bookings: rows.map(serializeCompletedListItem), pagination: meta(query.page, query.pageSize, total) });
    })().catch(next);
  });

  // GET /api/bookings/history — filtered, paginated history.
  router.get('/bookings/history', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const query = historyQuery.parse(req.query);

      const where: Prisma.BookingWhereInput = { ...NOT_DELETED };
      const branchId = branchScope(user, query.branchId);
      if (branchId !== undefined) where.branchId = branchId;
      // Receptionists only ever see dispatched bookings for their branch.
      if (user.role !== 'ADMIN') where.sentAt = { not: null };

      if (query.search) {
        // Case-INSENSITIVE, deliberately. `contains` is case-sensitive on
        // PostgreSQL, so searching "khuyen" found nothing for a guest stored as
        // "Khuyen" — an operator typing a name from memory would conclude the
        // booking did not exist. Widened at the same time from three fields to
        // the ones people actually search by; the hotel name is included
        // because a branch is often remembered by its hotel, not its code.
        const term = { contains: query.search, mode: 'insensitive' as const };
        where.OR = [
          { bookingCode: term },
          { customerName: term },
          { phone: term },
          { hotelName: term },
          { countryOfResidence: term },
          { branch: { hotelName: term } },
          { branch: { code: term } },
        ];
      }
      // A single value stays a scalar equality, exactly as before; several
      // become an IN. See csvEnum above.
      where.status = oneOf(query.status);
      where.sourcePlatform = oneOf(query.source);
      where.verificationStatus = oneOf(query.verificationStatus);
      if (query.country) where.countryOfResidence = { contains: query.country, mode: 'insensitive' };
      if (query.language) where.websiteLanguage = { contains: query.language, mode: 'insensitive' };
      if (query.paymentStatus) where.paymentStatus = query.paymentStatus;
      if (query.isLastMinute) where.isLastMinute = query.isLastMinute === 'true';

      const sentAt = rangeFilter(query.sentFrom, query.sentTo);
      if (sentAt) where.sentAt = { ...(where.sentAt as object), ...sentAt };
      const checkIn = rangeFilter(query.checkInFrom, query.checkInTo);
      if (checkIn) where.checkInDate = checkIn;
      const checkOut = rangeFilter(query.checkOutFrom, query.checkOutTo);
      if (checkOut) where.checkOutDate = checkOut;
      const createdAt = rangeFilter(query.createdFrom, query.createdTo);
      if (createdAt) where.createdAt = createdAt;
      const updatedAt = rangeFilter(query.updatedFrom, query.updatedTo);
      if (updatedAt) where.updatedAt = updatedAt;
      const completedAt = rangeFilter(query.completedFrom, query.completedTo);
      if (completedAt) where.completedAt = completedAt;

      // Newest-first stays the default for every existing caller.
      const sortKey = query.sort ?? 'sentAt';
      const direction = query.order ?? 'desc';
      const orderBy: Prisma.BookingOrderByWithRelationInput[] =
        sortKey === 'sentAt'
          ? [{ sentAt: direction }, { createdAt: 'desc' }]
          : [{ [sortKey]: direction }, { createdAt: 'desc' }];

      const { skip, take } = paginate(query.page, query.pageSize);
      const [total, rows] = await prisma.$transaction([
        prisma.booking.count({ where }),
        prisma.booking.findMany({ where, include: BOOKING_LIST_INCLUDE, orderBy, skip, take }),
      ]);

      res.json({ bookings: rows.map(serializeHistoryListItem), pagination: meta(query.page, query.pageSize, total) });
    })().catch(next);
  });

  // GET /api/bookings/:id — operational detail (rawText only for Admin).
  router.get('/bookings/:id', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const booking = await loadBookingDetail(req.params.id!);

      if (user.role !== 'ADMIN') {
        // A reception manager reads the orders of its branches; a receptionist its own.
        const mine = isReceptionSupervisor(user.role)
          ? booking.branchId !== null && scopeIncludes(branchScopeOf(user), booking.branchId)
          : booking.branchId === user.branchId;
        if (!mine) throw ApiError.branchAccessDenied();
        // Not-yet-dispatched drafts are not visible to receptionists.
        if (booking.status === 'DRAFT' || booking.status === 'READY') {
          throw ApiError.notFound('Không tìm thấy đơn đặt phòng.');
        }
      }

      const isAdmin = user.role === 'ADMIN';
      /*
        WHICH FIELDS THIS RECEPTIONIST HAS ALREADY CẮT, this cycle.

        ADMIN NEVER GETS ONE, and that is the point of §12: CẮT hides a value
        from the person who has already taken it, and hides nothing from anyone
        else. The Booking row is untouched either way — the guest's name, the
        amount and the note are all still there, and this list only says which
        of them reception has finished with.
      */
      // A reception manager reads; it takes nothing off the order, so nothing is hidden from it.
      const cutFields = isReceptionSupervisor(user.role) ? [] : await cutFieldsFor(booking.id, booking.claimCycle, prisma);

      res.json({
        booking: { ...serializeOpsBookingDetail(booking, isAdmin), cutFields },
        // So a countdown rendered straight after a page load is measured against
        // the SERVER's clock, not the machine's. Without it a wound-back PC clock
        // would display a longer window than the one the server will enforce.
        serverNow: getClock().now().toISOString(),
      });
    })().catch(next);
  });

  // POST /api/bookings/:id/proofs — receptionist (own branch) or admin uploads a
  // proof screenshot claiming the reservation was created externally.
  router.post(
    '/bookings/:id/proofs',
    requireAuth,
    requirePasswordChanged,
    requireBookingOperator,
    proofUpload(),
    (req, res, next) => {
      (async () => {
        const user = req.currentUser!;
        const { note } = submitProofSchema.parse(req.body ?? {});
        const file = req.file
          ? { buffer: req.file.buffer, originalName: req.file.originalname, size: req.file.size }
          : undefined;
        const booking = await submitProof(req.params.id!, file, note, actor(user, req.requestId), getClock());

        // Advisory OCR extraction on the just-created proof. It never blocks or
        // fails the upload: awaited only in tests for determinism, fire-and-forget
        // in production. The proof attempt is already valid regardless of OCR.
        const latestProof = await prisma.bookingCreationProof.findFirst({
          where: { bookingId: req.params.id! },
          orderBy: { attemptNumber: 'desc' },
          select: { id: true },
        });
        if (latestProof) {
          if (isTest) await analyzeAfterSubmit(latestProof.id);
          else void analyzeAfterSubmit(latestProof.id);
        }

        res.status(201).json({ booking: serializeOpsBookingDetail(booking, user.role === 'ADMIN') });
      })().catch(next);
    },
  );

  // GET /api/bookings/:id/proofs/:proofId/image — authenticated, branch-isolated
  // image bytes. Never served as public static content.
  router.get('/bookings/:id/proofs/:proofId/image', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const { storedFileName, mimeType } = await authorizeProofImage(
        req.params.id!,
        req.params.proofId!,
        actor(user, req.requestId),
      );
      const bytes = await readProofFile(storedFileName);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(bytes);
    })().catch(next);
  });

  // POST /api/bookings/:id/proofs/:proofId/approve — Admin marks the proof correct.
  router.post(
    '/bookings/:id/proofs/:proofId/approve',
    requireAuth,
    requirePasswordChanged,
    requireAdmin,
    (req, res, next) => {
      (async () => {
        const user = req.currentUser!;
        const booking = await approveProof(req.params.id!, req.params.proofId!, actor(user, req.requestId), getClock());
        res.json({ booking: serializeOpsBookingDetail(booking, /* isAdmin */ true) });
      })().catch(next);
    },
  );

  // POST /api/bookings/:id/proofs/:proofId/reject — Admin rejects with a reason.
  router.post(
    '/bookings/:id/proofs/:proofId/reject',
    requireAuth,
    requirePasswordChanged,
    requireAdmin,
    (req, res, next) => {
      (async () => {
        const user = req.currentUser!;
        const { reasonCode, reviewNote } = rejectSchema.parse(req.body ?? {});
        const booking = await rejectProof(
          req.params.id!,
          req.params.proofId!,
          reasonCode,
          reviewNote,
          actor(user, req.requestId),
          getClock(),
        );
        res.json({ booking: serializeOpsBookingDetail(booking, /* isAdmin */ true) });
      })().catch(next);
    },
  );

  return router;
}
