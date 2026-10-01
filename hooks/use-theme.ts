'use client';

import { useEffect, useSyncExternalStore } from 'react';
import {
  currentTheme,
  setTheme,
  storedTheme,
  subscribeTheme,
  type Theme,
} from '@/lib/theme';

/** The active theme and a setter that persists it on this device. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  useEffect(() => {
    // Server-rendered pages start dark; adopt the saved preference on mount.
    if (storedTheme() !== currentTheme()) setTheme(storedTheme());
  }, []);
  const theme = useSyncExternalStore(
    subscribeTheme,
    currentTheme,
    () => 'dark' as const,
  );
  return [theme, setTheme];
}
