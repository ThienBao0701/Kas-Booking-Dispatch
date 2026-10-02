import { useEffect, useState } from 'react';

/**
 * The value, settled.
 *
 * Typing "nguyen" into the search box fired six requests, of which five were
 * already stale when they landed and one raced the others to paint. This
 * returns the value only once the user has paused, so the query key changes
 * once per search rather than once per keystroke.
 *
 * The delay is deliberately short. Search-as-you-type stops feeling live much
 * past a third of a second.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
