'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/** Live result of a CSS media query; false during server rendering. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** A device-local boolean preference, such as whether a pane is open. */
export function useStoredFlag(
  key: string,
  initial: boolean,
): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const saved = localStorage.getItem(key);
        if (saved === 'true' || saved === 'false') setValue(saved === 'true');
      } catch {
        // Keep the default when local preferences cannot be read.
      }
    });
  }, [key]);
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // The preference still applies for this session.
      }
    },
    [key],
  );
  return [value, update];
}
