import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from '../auth/LoginPage';
import { ChangePasswordPage } from '../auth/ChangePasswordPage';
import { PublicOnly, RequireAuth, RequirePasswordChange, RequireRole } from '../auth/ProtectedRoute';
import { useAuth } from '../auth/AuthProvider';
import type { UserRole } from '../auth/types';
import { AppShell } from '../layout/AppShell';
import { ChargeDocumentsPage } from '../pages/ChargeDocumentsPage';
import { ChatBoxPage } from '../pages/ChatBoxPage';
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
import { DashboardPage } from '../pages/DashboardPage';
import { DispatchPage } from '../pages/DispatchPage';
import { NewBookingsPage } from '../pages/NewBookingsPage';
import { PendingReviewPage, RejectedPage } from '../pages/VerificationBookingsPage';
import { CompletedBookingsPage } from '../pages/CompletedBookingsPage';
import { HistoryPage } from '../pages/HistoryPage';
import { OperationalReportsPage } from '../pages/OperationalReportsPage';
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

/** Sends each role to its natural landing page. */
function RoleLanding() {
  const { user } = useAuth();
  if (user?.role === 'ADMIN') return <Navigate to="/app/dashboard" replace />;
  // Without this, a technician landed on the receptionist inbox — a branch-scoped
  // screen they have no branch for, so it was permanently empty.
  if (user?.role === 'TECHNICAL') return <Navigate to="/app/technical/new" replace />;
  if (user?.role === 'BOOKING_DEPARTMENT') return <Navigate to="/app/charge-documents" replace />;
  return <Navigate to="/app/new" replace />;
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
          <Route path="new" element={<RequireRole role={BOOKING_ROLES}><NewBookingsPage /></RequireRole>} />
          <Route path="pending-review" element={<RequireRole role={BOOKING_ROLES}><PendingReviewPage /></RequireRole>} />
          <Route path="rejected" element={<RequireRole role={BOOKING_ROLES}><RejectedPage /></RequireRole>} />
          <Route path="completed" element={<RequireRole role={BOOKING_ROLES}><CompletedBookingsPage /></RequireRole>} />
          <Route path="history" element={<RequireRole role={BOOKING_ROLES}><HistoryPage /></RequireRole>} />
          <Route path="booking/:id" element={<RequireRole role={BOOKING_ROLES}><BookingDetailPage /></RequireRole>} />
          {/*
            OLD ADDRESSES, KEPT AS REDIRECTS. Incidents are reported and watched
            in "Báo cáo vấn đề" → "Sự cố vật chất đang xử lý" now, and "Bàn giao
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
          <Route path="reports" element={<RequireRole role={BOOKING_ROLES}><OperationalReportsPage /></RequireRole>} />
          {/*
            Bộ phận kỹ thuật. `queue` is a real path segment so each workflow
            state has its own address and can be bookmarked or opened alongside.
          */}
          <Route
            path="technical"
            element={<Navigate to="/app/technical/new" replace />}
          />
          <Route
            path="technical/:queue"
            element={
              <RequireRole role="TECHNICAL">
                <TechnicalPage />
              </RequireRole>
            }
          />
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
