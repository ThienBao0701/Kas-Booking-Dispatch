import { MutationCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/errors';
import { SHIFT_SESSION_KEY } from '../hooks/useShiftSession';

/**
 * The server's refusal when a receptionist tries to record work without having
 * checked in to a shift.
 */
const SHIFT_CHECK_IN_REQUIRED = 'SHIFT_CHECK_IN_REQUIRED';

/**
 * Shared React Query client. ApiErrors (auth/permission/validation) are never
 * retried; only transient failures (e.g. NetworkError) get a couple of retries.
 *
 * ONE GLOBAL HANDLER FOR "YOU HAVE NO SHIFT".
 *
 * The server refuses an unattributed submission with `SHIFT_CHECK_IN_REQUIRED`,
 * and the shift picker is supposed to appear when it does. It did not: nothing
 * in the client looked at the code, so a receptionist whose shift had lapsed
 * mid-order saw a Vietnamese sentence in an error box and had to wait up to
 * sixty seconds for the session poll — or reload — before the picker offered
 * them a way out.
 *
 * Handling it in the MUTATION CACHE rather than at each call site is what makes
 * it stay fixed. Every shift-gated write the application will ever gain — proof
 * submission today, handovers and handover notes now — goes through here, so
 * none of them has to remember. Invalidating the session query is all that is
 * needed: `ShiftGate` already renders the picker from a null/expired session.
 */
export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error) => {
      if (error instanceof ApiError && error.code === SHIFT_CHECK_IN_REQUIRED) {
        void queryClient.invalidateQueries({ queryKey: SHIFT_SESSION_KEY });
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
