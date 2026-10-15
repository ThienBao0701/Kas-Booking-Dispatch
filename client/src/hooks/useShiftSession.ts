import { useQuery } from '@tanstack/react-query';
import { shiftsApi } from '../api/shifts';
import { useAuth } from '../auth/AuthProvider';

export const SHIFT_SESSION_KEY = ['reception', 'shift', 'current'];
export const SHIFT_OPTIONS_KEY = ['reception', 'shift', 'options'];
/** "Bàn giao ca" — invalidated by a handover, which may write a note. */
export const HANDOVER_NOTES_KEY = ['reception', 'handover-notes'];

/** Only a receptionist works a shift; nobody else is ever asked for one. */
export function useIsReception(): boolean {
  const { user } = useAuth();
  return user?.role === 'RECEPTIONIST';
}

/**
 * The receptionist's open shift, read from the SERVER rather than held in React
 * state, so a refresh, a second tab and a reopened laptop all agree on who is
 * working.
 *
 * Polled every sixty seconds. The boundary it watches for is a ten-minute grace
 * window, so a minute of latency is invisible to an operator, while a
 * five-second poll would be twelve times the traffic for no visible difference.
 */
export function useShiftSession() {
  const enabled = useIsReception();
  return useQuery({
    queryKey: SHIFT_SESSION_KEY,
    queryFn: () => shiftsApi.current(),
    enabled,
    refetchInterval: enabled ? 60_000 : false,
    refetchOnWindowFocus: true,
  });
}
