import { Navigate, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './AuthProvider';
import type { UserRole } from './types';
import { ForbiddenPage } from '../pages/ForbiddenPage';

/**
 * Gate for the operational app. Unauthenticated users go to /login; users who
 * still owe a password change are funnelled to /change-password.
 */
export function RequireAuth() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  return <Outlet />;
}

/** Login route: send already-authenticated users where they belong. */
export function PublicOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user) {
    // /app resolves to each role's landing page (admin → dashboard, else inbox).
    return <Navigate to={user.mustChangePassword ? '/change-password' : '/app'} replace />;
  }
  return <>{children}</>;
}

/**
 * Change-password route. Reachable by any authenticated user — both the forced
 * flow (mustChangePassword=true) and the voluntary "Đổi mật khẩu" action from
 * the account menu. Only unauthenticated users are bounced to /login. The
 * ChangePasswordPage itself distinguishes forced vs voluntary mode and handles
 * post-success navigation, so no redirect is needed here.
 */
export function RequirePasswordChange({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/**
 * Role gate for restricted pages. The frontend shows a forbidden state; the
 * backend remains the real security boundary.
 *
 * Accepts one role or several — Chứng từ is reachable by two — so a page never
 * has to be wrapped twice or guarded by hand.
 */
export function RequireRole({
  role,
  children,
}: {
  role: UserRole | readonly UserRole[];
  children: ReactNode;
}) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  const allowed = Array.isArray(role) ? role : [role as UserRole];
  if (!allowed.includes(user.role)) return <ForbiddenPage />;
  return <>{children}</>;
}
