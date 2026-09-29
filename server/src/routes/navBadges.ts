/**
 * Sidebar badge counts — one request, every number in the menu.
 *
 * WHY ONE ENDPOINT AND NOT SIX. The sidebar is on screen for the whole shift
 * and polls forever; six independent polls would be six connections and six
 * chances for the menu to disagree with itself mid-refresh. One payload means
 * the numbers are always a consistent snapshot of the same instant.
 *
 * EVERY COUNT IS A `SELECT count(*)`, DERIVED THE SAME WAY THE LIST BEHIND IT
 * IS. Nothing here is incremented, cached in the browser, or remembered between
 * requests, which is what makes a badge still correct after a refresh, in a
 * second tab, and after a claim, an expiry, a resend, a submission, a verdict
 * or a reminder being read: those all change what the underlying query counts,
 * so the next poll simply returns a different number.
 *
 * The counts reuse the exact `where` fragments of the screens they label, so a
 * badge can never claim work a list will not show.
 */
import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { getClock } from '../lib/clock';
import { requireAuth, requirePasswordChanged } from '../middleware/auth';
import { NOT_DELETED } from '../booking/deleteBooking';
import { activeQueueWhere } from '../booking/claim';
import { visibilityWhere } from '../chat/chatService';

/** Every badge the menu can show. Absent or zero means no badge is rendered. */
export interface NavBadgeCounts {
  new: number;
  pendingReview: number;
  rejected: number;
  resendOrders: number;
  chat: number;
  reminders: number;
}

const EMPTY: NavBadgeCounts = {
  new: 0,
  pendingReview: 0,
  rejected: 0,
  resendOrders: 0,
  chat: 0,
  reminders: 0,
};

export function createNavBadgesRouter(): Router {
  const router = Router();

  router.get('/nav-badges', requireAuth, requirePasswordChanged, (req, res, next) => {
    (async () => {
      const user = req.currentUser!;
      const now = getClock().now();

      /*
        Departments with no part in the booking workflow get zeros.

        Bộ phận đặt phòng has a one-item menu; Bộ phận kỹ thuật works incident
        queues and no booking screen at all; Bộ phận buồng phòng inspects rooms.
        The first two are branchless, so without this
        they fall through to the branch filter below, where `branchId === null`
        widens to EVERY branch — handing a role that cannot open a single one of
        those screens a count of every order on all eight.
      */
      if (
        user.role === 'BOOKING_DEPARTMENT' ||
        user.role === 'TECHNICAL' ||
        user.role === 'TECHNICAL_MANAGER' ||
        user.role === 'HOUSEKEEPING'
      ) {
        res.json({ counts: EMPTY, serverNow: now.toISOString() });
        return;
      }

      const isAdmin = user.role === 'ADMIN';
      const branch: Prisma.BookingWhereInput =
        isAdmin || user.branchId === null ? {} : { branchId: user.branchId };

      /*
        A receptionist's two claimable queues hide an elapsed order, exactly as
        the lists do — the badge must not count work the screen refuses to show.
        Admin's overview counts everything dispatched.
      */
      const queue: Prisma.BookingWhereInput = isAdmin ? {} : activeQueueWhere(now);

      const dispatched = { ...NOT_DELETED, status: 'NEW', ...branch } as const;

      // An interactive transaction so the numbers are one snapshot without
      // issuing queries for screens this role does not have.
      const counts: NavBadgeCounts = await prisma.$transaction(async (tx) => ({
        new: await tx.booking.count({
          where: { ...dispatched, verificationStatus: 'NOT_SUBMITTED', ...queue },
        }),
        pendingReview: await tx.booking.count({
          where: { ...dispatched, verificationStatus: 'PENDING_REVIEW' },
        }),
        rejected: await tx.booking.count({
          where: { ...dispatched, verificationStatus: 'REJECTED', ...queue },
        }),
        // Only Admin has a "Gửi lại đơn" screen, so only Admin pays for the count.
        resendOrders: isAdmin
          ? await tx.booking.count({
              where: {
                ...NOT_DELETED,
                status: 'NEW',
                verificationStatus: { in: ['NOT_SUBMITTED', 'REJECTED'] },
                claimedByUserId: { not: null },
                claimExpiresAt: { lt: now },
              },
            })
          : 0,
        /*
          CHAT COUNTS CONVERSATIONS AWAITING YOU, NOT UNREAD MESSAGES.

          The chat schema has no read tracking at all — no `readAt`, no
          per-participant `lastReadAt` — so a true unread count is not derivable
          from it, and inventing one would mean a migration for a badge.
          `ChatConversationStatus` already records whose turn it is, which is the
          operationally useful number: Admin sees threads waiting on an answer, a
          receptionist sees their own threads answered since they last spoke.
        */
        chat: await tx.chatConversation.count({
          where: isAdmin
            ? { status: 'WAITING_ADMIN', branchChannel: false }
            : {
                ...visibilityWhere({ id: user.id, role: user.role, branchId: user.branchId }),
                status: 'ANSWERED',
              },
        }),
        // Reminders are per-recipient; an Admin has no inbox of their own.
        reminders: isAdmin
          ? 0
          : await tx.reminder.count({ where: { recipientUserId: user.id, readAt: null } }),
      }));

      res.json({ counts, serverNow: now.toISOString() });
    })().catch(next);
  });

  return router;
}
