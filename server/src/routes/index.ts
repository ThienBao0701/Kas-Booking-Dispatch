import { Router } from 'express';
import { healthRouter } from './health';
import { createAuthRouter } from './auth';
import { createBranchesRouter } from './branches';
import { createAdminBranchesRouter } from './adminBranches';
import { createAdminRoomMappingRouter } from './adminRoomMapping';
import { createBookingGuestsRouter } from './bookingGuests';
import { createChargeDocumentsRouter } from './chargeDocuments';
import { createChatRouter } from './chat';
import { createRemindersRouter } from './reminders';
import { createAdminUsersRouter } from './adminUsers';
import { createBookingsRouter } from './bookings';
import { createBookingLifecycleRouter } from './bookingLifecycle';
import { createAdminBookingsRouter } from './adminBookings';
import { createOtaReviewRouter } from './otaReview';
import { createAdminDashboardRouter } from './adminDashboard';
import { createAdminReportsRouter } from './adminReports';
import { createNotificationsRouter } from './notifications';
import { createNavBadgesRouter } from './navBadges';
import { createIssuesRouter } from './issues';
import { createReceptionShiftsRouter } from './receptionShifts';
import { createReceptionReportsRouter } from './receptionReports';
import { createDevTestRouter } from './devTest';

/**
 * Builds a fresh API router. A factory (rather than a shared singleton) so each
 * app instance — notably each test file — gets its own login rate limiter state.
 */
export function createApiRouter(): Router {
  const router = Router();

  router.use(healthRouter);
  router.use(createAuthRouter());
  router.use(createBranchesRouter());
  // Mounted before the generic /admin router so branch management owns its paths.
  // Room mapping comes first: its paths are nested under a branch id, and the
  // branch router's own /admin/branches/:id handler would otherwise match them.
  router.use(createAdminRoomMappingRouter());
  router.use(createAdminBranchesRouter());
  router.use(createAdminUsersRouter());
  router.use(createAdminBookingsRouter());
  router.use(createOtaReviewRouter());
  router.use(createAdminDashboardRouter());
  router.use(createAdminReportsRouter());
  // Guest and lifecycle routes are more specific than /bookings/:id, so they
  // mount first — otherwise /bookings/:id would swallow /bookings/:id/receive.
  router.use(createBookingGuestsRouter());
  // Chứng từ. Self-contained: it mounts its own auth + role gate on its prefix.
  router.use(createChargeDocumentsRouter());
  router.use(createChatRouter());
  router.use(createRemindersRouter());
  router.use(createBookingLifecycleRouter());
  router.use(createBookingsRouter());
  router.use(createNotificationsRouter());
  router.use(createNavBadgesRouter());
  router.use(createReceptionShiftsRouter());
  router.use(createReceptionReportsRouter());
  router.use(createIssuesRouter());
  router.use(createDevTestRouter());

  return router;
}
