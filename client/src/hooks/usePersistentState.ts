import { useCallback, useState } from 'react';

/**
 * State that survives a reload, stored under one key.
 *
 * Used for filter selections: an operator who filters to their branch and the
 * OTA tab, opens a booking, then comes back should not have to rebuild the
 * filter. Nothing sensitive goes in here — only the operator's own view
 * choices, never booking or guest data.
 *
 * Storage is treated as best-effort throughout. Private mode and disabled
 * storage both throw on access, and a filter bar that cannot render because
 * localStorage is unavailable would be a much worse failure than a forgotten
 * preference.
 */
export function usePersistentState<T>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback));

  const update = useCallback(
    (next: T) => {
      setValue(next);
      write(key, next);
    },
    [key],
  );

  return [value, update];
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // Unreadable or corrupt (a half-written value, a schema that has since
    // changed). The default is always a safe view, so fall back rather than
    // failing the page.
    return fallback;
  }
}

function write<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage unavailable or full — the choice simply does not persist. */
  }
}
