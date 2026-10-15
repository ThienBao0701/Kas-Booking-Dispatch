import { disablePush } from '../pwa/push';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/errors';
import { authApi } from './api';
import type { AuthUser, LoginResponse } from './types';

const AUTH_ME_KEY = ['auth', 'me'] as const;

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<LoginResponse>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const meQuery = useQuery({
    queryKey: AUTH_ME_KEY,
    queryFn: async (): Promise<AuthUser | null> => {
      try {
        const { user } = await authApi.me();
        return user;
      } catch (error) {
        // 401 is the normal "not signed in" answer — return null, not an error.
        if (error instanceof ApiError && error.isAuthError) return null;
        // Network / server errors surface as a real query error (retryable),
        // so a blip is never mistaken for being logged out.
        throw error;
      }
    },
    staleTime: Infinity,
    retry: (failureCount, error) => {
      if (error instanceof ApiError) return false;
      return failureCount < 1;
    },
  });

  const user = meQuery.data ?? null;

  const login = useCallback(
    async (username: string, password: string): Promise<LoginResponse> => {
      const result = await authApi.login({ username, password });
      queryClient.setQueryData(AUTH_ME_KEY, result.user);
      return result;
    },
    [queryClient],
  );

  const logout = useCallback(async (): Promise<void> => {
    // A shared phone must not keep receiving this account's work after it signs out.
    await disablePush().catch(() => undefined);
    try {
      await authApi.logout();
    } catch {
      // Logout must succeed for the UI even if the server session is already gone.
    }
    queryClient.setQueryData(AUTH_ME_KEY, null);
    // Drop every cached protected query so nothing remains visible after logout.
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' });
  }, [queryClient]);

  const refreshUser = useCallback(async (): Promise<void> => {
    await meQuery.refetch();
  }, [meQuery]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading: meQuery.isLoading,
      isError: meQuery.isError,
      error: meQuery.error,
      isAuthenticated: user !== null,
      login,
      logout,
      refreshUser,
    }),
    [user, meQuery.isLoading, meQuery.isError, meQuery.error, login, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
