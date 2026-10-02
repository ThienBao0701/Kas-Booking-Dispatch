import { useQuery } from '@tanstack/react-query';
import { branchesApi } from '../api/bookings';

/**
 * The rooms of ONE branch, from the server's room catalog — the single source
 * every room selector (incidents, inspections) reads. `rooms` is null while
 * loading, when no branch is chosen, and for a branch with no catalog; the form
 * then falls back to typing the room, exactly as before.
 *
 * Keyed by branch, so changing the branch reloads the list and a room from
 * another branch can never linger in the options.
 */
export function useBranchRooms(branchId: number | null | undefined) {
  const query = useQuery({
    queryKey: ['branch-rooms', branchId],
    queryFn: () => branchesApi.rooms(branchId!),
    enabled: typeof branchId === 'number',
    // The catalog changes with a release, not during a shift.
    staleTime: 60 * 60 * 1000,
  });
  return {
    rooms: query.data?.rooms ?? null,
    /** The branch's floors ("Hành lang", "Cầu thang"); null without a floor catalog. */
    floors: query.data?.floors ?? null,
    isLoading: query.isLoading && typeof branchId === 'number',
  };
}
