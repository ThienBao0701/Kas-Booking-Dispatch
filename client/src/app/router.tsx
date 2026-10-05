import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from '../auth/LoginPage';
import { ChangePasswordPage } from '../auth/ChangePasswordPage';
import { PublicOnly, RequireAuth, RequirePasswordChange, RequireRole } from '../auth/ProtectedRoute';
import { useAuth } from '../auth/AuthProvider';
import type { UserRole } from '../auth/types';
import { AppShell } from '../layout/AppShell';
import { ChargeDocumentsPage } from '../pages/ChargeDocumentsPage';
import { ChatBoxPage } from '../pages/ChatBoxPage';
import { AdminHousekeepingPage } from '../pages/AdminHousekeepingPage';
import { DepartmentDeliveriesPage } from '../pages/DepartmentDeliveriesPage';
import { HousekeepingInspectionPage } from '../pages/HousekeepingInspectionPage';
import { RoomCollectionsPage } from '../pages/RoomCollectionsPage';
import { TechnicalStatisticsPage } from '../pages/TechnicalStatisticsPage';
import { ChatConversationPage } from '../pages/ChatConversationPage';
import { ResendOrdersPage } from '../pages/ResendOrdersPage';
import { RemindersPage } from '../pages/RemindersPage';
import { ChargeDocumentDetailPage } from '../pages/ChargeDocumentDetailPage';
import { ChargeReportPage } from '../pages/ChargeReportPage';

/** The two roles Chứng từ is for. Mirrors the server's route gate. */
const CHARGE_ROLES: readonly UserRole[] = ['ADMIN', 'BOOKING_DEPARTMENT'];
/**
 * Chat box is reception↔Admin correspondence. Bộ phận đặt phòng has no stated
 * part in it, so it is excluded here as it is on the API — this gate only
 * renders a forbidden page; the server is the security boundary.
 */
const CHAT_ROLES: readonly UserRole[] = ['ADMIN', 'RECEPTIONIST'];
/** The two departments that read the deliveries addressed to them. */
const DELIVERY_READER_ROLES: readonly UserRole[] = ['TECHNICAL', 'HOUSEKEEPING'];
import { DashboardPage } from '../pages/DashboardPage';
import { DispatchPage } from '../pages/DispatchPage';
import { NewBookingsPage } from '../pages/NewBookingsPage';
import { PendingReviewPage, RejectedPage } from '../pages/VerificationBookingsPage';
import { HistoryPage } from '../pages/HistoryPage';
import { OperationalReportsPage } from '../pages/OperationalReportsPage';
import { CompletedIssuesPage } from '../pages/CompletedIssuesPage';
import { TechnicalReportPage } from '../pages/TechnicalReportPage';
import { ConfidentialReportsPage } from '../pages/ConfidentialReportsPage';
import { HousekeepingRoomPage } from '../pages/HousekeepingRoomPage';
import { HousekeepingKpiPage } from '../pages/HousekeepingKpiPage';
import {
  HkAssignPage,
  HkKpiPage,
  HkOverviewPage,
  HkReportPage,
  HkRoomBoardPage,
  HkStaffPage,
} from '../pages/HousekeepingManagerPages';

/** "Quản lý buồng phòng" — its branch; the Admin, every branch. The server scopes. */
const HK_MANAGER_ROLES: readonly UserRole[] = ['ADMIN', 'HOUSEKEEPING_MANAGER'];
import { TechnicalPage } from '../pages/TechnicalPage';
import { BookingDetailPage } from '../pages/BookingDetailPage';
import { SettingsPage } from '../pages/SettingsPage';
import { BranchesPage } from '../pages/BranchesPage';
import { NotFoundPage } from '../pages/NotFoundPage';

/**
 * The roles that take part in the booking workflow.
 *
 * Bộ phận kỹ thuật and Bộ phận đặt phòng are excluded: neither has a branch and
 * neither has any part in dispatch, so every booking screen would either be
 * empty or meaningless for them. Mirrors the server, which scopes those screens
 * by branch and returns nothing to a branchless role.
 */
const BOOKING_ROLES: readonly UserRole[] = ['ADMIN', 'RECEPTIONIST'];

/**
 * "Báo cáo vấn đề → Kỹ thuật": the supervisors and the Quản lý kỹ thuật, each
 * over its own branches (the server scopes every row).
 */
const TECHNICAL_REPORT_ROLES: readonly UserRole[] = ['ADMIN', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER', 'TECHNICAL_MANAGER'];

/**
 * "Báo cáo vấn đề" and "Buồng phòng" as the reception SUPERVISORS see them —
 * the Admin, a Quản lý lễ tân (its branches) and a Tổng quản lý lễ tân (all).
 * The server scopes every row; this gate only renders a forbidden page.
 */
const SUPERVISION_ROLES: readonly UserRole[] = ['ADMIN', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'];
const REPORT_ROLES: readonly UserRole[] = ['RECEPTIONIST', ...SUPERVISION_ROLES];
/**
 * Reception's screens, for Reception and the two reception managers ("the
 * complete Reception experience, for the branches I manage"). The server scopes
 * every read; a manager never claims, cuts or confirms an order.
 */
const RECEPTION_SCOPE_ROLES: readonly UserRole[] = [...BOOKING_ROLES, 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER'];

/** Sends each role to its natural landing page. */
function RoleLanding() {
  const { user } = useAuth();
  if (user?.role === 'ADMIN') return <Navigate to="/app/dashboard" replace />;
  // Without this, a technician landed on the receptionist inbox — a branch-scoped
  // screen they have no branch for, so it was permanently empty.
  if (user?.role === 'TECHNICAL') return <Navigate to="/app/technical/new" replace />;
  // Quản lý kỹ thuật's own work: the incidents of its branches.
  if (user?.role === 'TECHNICAL_MANAGER') return <Navigate to="/app/reports/technical" replace />;
  if (user?.role === 'BOOKING_DEPARTMENT') return <Navigate to="/app/charge-documents" replace />;
  if (user?.role === 'HOUSEKEEPING') return <Navigate to="/app/inspections" replace />;
  if (user?.role === 'HOUSEKEEPING_MANAGER') return <Navigate to="/app/hk/overview" replace />;
  // The supervision layer opens on its reports.
  if (user?.role === 'RECEPTION_MANAGER' || user?.role === 'RECEPTION_GENERAL_MANAGER') {
    return <Navigate to="/app/reports" replace />;
  }
  return <Navigate to="/app/new" replace />;
}

/**
 * The technician's queues. The Quản lý kỹ thuật's temporary "Nghiệm thu" screen
 * is gone: an old link of its lands on its incident workspace instead.
 */
function TechnicalQueueRoute() {
  const { user } = useAuth();
  if (user?.role === 'TECHNICAL_MANAGER') return <Navigate to="/app/reports/technical" replace />;
  return (
    <RequireRole role="TECHNICAL">
      <TechnicalPage />
    </RequireRole>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        }
      />
      <Route
        path="/change-password"
        element={
          <RequirePasswordChange>
            <ChangePasswordPage />
          </RequirePasswordChange>
        }
      />

      <Route element={<RequireAuth />}>
        <Route path="/app" element={<AppShell />}>
          <Route index element={<RoleLanding />} />
          <Route path="dashboard" element={<RequireRole role="ADMIN"><DashboardPage /></RequireRole>} />
          <Route path="dispatch" element={<RequireRole role="ADMIN"><DispatchPage /></RequireRole>} />
          <Route path="waiting" element={<RequireRole role="ADMIN"><NewBookingsPage /></RequireRole>} />
          {/*
            The booking workflow. Gated so a branchless department cannot reach
            a branch-scoped screen — these routes used to be open to any
            authenticated user, which sent a technician to an empty inbox with
            nothing to explain it.
          */}
          <Route path="new" element={<RequireRole role={RECEPTION_SCOPE_ROLES}><NewBookingsPage /></RequireRole>} />
          <Route path="pending-review" element={<RequireRole role={BOOKING_ROLES}><PendingReviewPage /></RequireRole>} />
          <Route path="rejected" element={<RequireRole role={BOOKING_ROLES}><RejectedPage /></RequireRole>} />
          {/*
            "Đã xác nhận đúng" is no longer a screen. The address stays as a
            redirect so a bookmark or an old link lands somewhere that works; the
            confirmed orders themselves are unchanged and are listed, with every
            other status, in "Lịch sử".
          */}
          <Route path="completed" element={<Navigate to="/app/history" replace />} />
          <Route path="history" element={<RequireRole role={BOOKING_ROLES}><HistoryPage /></RequireRole>} />
          <Route path="booking/:id" element={<RequireRole role={RECEPTION_SCOPE_ROLES}><BookingDetailPage /></RequireRole>} />
          {/*
            OLD ADDRESSES, KEPT AS REDIRECTS. Incidents are reported and watched
            in "Báo cáo vấn đề" → "Sự cố cơ sở vật chất đang xử lý" now, and "Bàn giao
            ca" has no screen of its own. A bookmark, a notification or an old
            link still lands somewhere that works instead of on a blank page.
            Only the screens went: the incident and handover APIs and every
            historical row behind them are untouched.
          */}
          <Route path="issues" element={<Navigate to="/app/reports?category=FACILITY_ISSUE" replace />} />
          <Route path="handover" element={<Navigate to="/app/reports" replace />} />
          {/*
            "Báo cáo vấn đề". ONE ROUTE FOR TWO SCREENS: reception records, the
            Admin drills down by branch. They answer different questions but
            operators call both by the same name, and a second address would
            make a shared link land on the wrong one.

            This gate only renders a forbidden page; the server refuses a write
            from anyone who is not a receptionist on an open shift, and refuses
            the Admin endpoints to everyone else.
          */}
          <Route path="reports" element={<RequireRole role={REPORT_ROLES}><OperationalReportsPage /></RequireRole>} />
          {/* "Báo cáo vấn đề" → "Kỹ thuật" and "Buồng phòng". */}
          <Route path="reports/technical" element={<RequireRole role={TECHNICAL_REPORT_ROLES}><TechnicalReportPage /></RequireRole>} />
          <Route path="reports/housekeeping" element={<RequireRole role={SUPERVISION_ROLES}><AdminHousekeepingPage /></RequireRole>} />
          {/* "VII" — private reports upward; who may send and who may read is the server's. */}
          <Route path="reports/confidential" element={<RequireRole role={REPORT_ROLES}><ConfidentialReportsPage /></RequireRole>} />
          {/* The 12-hour completion archive — a query over the same records; the Admin reads every branch. */}
          <Route
            path="completed-issues"
            element={<RequireRole role={['ADMIN', 'RECEPTIONIST', 'RECEPTION_MANAGER', 'RECEPTION_GENERAL_MANAGER']}><CompletedIssuesPage /></RequireRole>}
          />
          {/*
            Bộ phận kỹ thuật. `queue` is a real path segment so each workflow
            state has its own address and can be bookmarked or opened alongside.
          */}
          <Route
            path="technical"
            element={<Navigate to="/app/technical/new" replace />}
          />
          <Route
            path="technical/statistics"
            element={
              <RequireRole role="TECHNICAL">
                <TechnicalStatisticsPage />
              </RequireRole>
            }
          />
          <Route path="technical/:queue" element={<TechnicalQueueRoute />} />
          {/*
            Chứng từ. Reception is refused here AND by the API — this gate only
            renders a forbidden page; the server is the security boundary.
          */}
          <Route
            path="charge-documents"
            element={
              <RequireRole role={CHARGE_ROLES}>
                <ChargeDocumentsPage />
              </RequireRole>
            }
          />
          <Route
            path="charge-documents/report"
            element={
              <RequireRole role={CHARGE_ROLES}>
                <ChargeReportPage />
              </RequireRole>
            }
          />
          <Route
            path="charge-documents/:id"
            element={
              <RequireRole role={CHARGE_ROLES}>
                <ChargeDocumentDetailPage />
              </RequireRole>
            }
          />
          <Route
            path="chat"
            element={
              <RequireRole role={CHAT_ROLES}>
                <ChatBoxPage />
              </RequireRole>
            }
          />
          <Route
            path="chat/:id"
            element={
              <RequireRole role={CHAT_ROLES}>
                <ChatConversationPage />
              </RequireRole>
            }
          />
          {/*
            Buồng phòng. Three audiences, three addresses, one data set: the
            department records (`inspections`), Reception collects
            (`room-collections`), the Admin reads and reports (`housekeeping`).
            The server is the boundary; these gates only render a forbidden page.
          */}
          <Route path="inspections" element={<RequireRole role="HOUSEKEEPING"><HousekeepingInspectionPage /></RequireRole>} />
          <Route path="inspections/room/:id" element={<RequireRole role="HOUSEKEEPING"><HousekeepingRoomPage /></RequireRole>} />
          <Route path="my-kpi" element={<RequireRole role="HOUSEKEEPING"><HousekeepingKpiPage /></RequireRole>} />
          {/* "Quản lý buồng phòng": six focused screens. */}
          <Route path="hk" element={<Navigate to="/app/hk/overview" replace />} />
          <Route path="hk/overview" element={<RequireRole role={HK_MANAGER_ROLES}><HkOverviewPage /></RequireRole>} />
          <Route path="hk/rooms" element={<RequireRole role={HK_MANAGER_ROLES}><HkRoomBoardPage /></RequireRole>} />
          <Route path="hk/assign" element={<RequireRole role={HK_MANAGER_ROLES}><HkAssignPage /></RequireRole>} />
          <Route path="hk/staff" element={<RequireRole role={HK_MANAGER_ROLES}><HkStaffPage /></RequireRole>} />
          <Route path="hk/kpi" element={<RequireRole role={HK_MANAGER_ROLES}><HkKpiPage /></RequireRole>} />
          <Route path="hk/report" element={<RequireRole role={HK_MANAGER_ROLES}><HkReportPage /></RequireRole>} />
          <Route path="room-collections" element={<RequireRole role="RECEPTIONIST"><RoomCollectionsPage /></RequireRole>} />
          {/* The old address of the supervisors' Buồng phòng: under "Báo cáo vấn đề" now. */}
          <Route path="housekeeping" element={<Navigate to="/app/reports/housekeeping" replace />} />
          {/* "Giao nhận hàng hóa" as Technical and Housekeeping see it — their own department's. */}
          <Route
            path="deliveries"
            element={
              <RequireRole role={DELIVERY_READER_ROLES}>
                <DepartmentDeliveriesPage />
              </RequireRole>
            }
          />
          {/* Admin recovery for orders whose 3-minute claim ran out. */}
          <Route
            path="resend-orders"
            element={
              <RequireRole role="ADMIN">
                <ResendOrdersPage />
              </RequireRole>
            }
          />
          {/* Nhắc nhở: Admin composes, receptionist reads their own. */}
          <Route
            path="reminders"
            element={
              <RequireRole role={CHAT_ROLES}>
                <RemindersPage />
              </RequireRole>
            }
          />
          <Route path="branches" element={<RequireRole role="ADMIN"><BranchesPage /></RequireRole>} />
          <Route path="settings" element={<RequireRole role="ADMIN"><SettingsPage /></RequireRole>} />
        </Route>
      </Route>

      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
