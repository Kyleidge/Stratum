'use client';
import { useEffect, useRef } from 'react';

/**
 * The workbench's global keys, read with the latest handlers: Escape closes
 * the History or Details drawer, Alt+←/→ steps between batch items, Ctrl+K
 * opens the command palette and Ctrl+Z / Ctrl+Y undo and redo, outside text
 * fields and dialogs. Reports owns its keyboard: its Undo never changes the
 * signal workflow. Keep the guide's Shortcuts list in step with these keys.
 */
export function useWorkbenchShortcuts({
  reportsShown,
  drawerOpen,
  closeDrawers,
  canStepItem,
  stepItem,
  openPalette,
  undo,
  redo,
}: {
  reportsShown: boolean;
  /** History or Details is open as a drawer. */
  drawerOpen: boolean;
  closeDrawers: () => void;
  /** A batch item is shown and the engine is idle. */
  canStepItem: boolean;
  stepItem: (offset: -1 | 1) => void;
  openPalette: () => void;
  undo: () => void;
  redo: () => void;
}) {
  const shortcuts = useRef<(event: KeyboardEvent) => void>(undefined);
  useEffect(() => {
    shortcuts.current = (event) => {
      if (reportsShown) return;
      if (
        event.key === 'Escape' &&
        drawerOpen &&
        !document.querySelector('[role="dialog"], [role="alertdialog"]')
      ) {
        closeDrawers();
        return;
      }
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        canStepItem &&
        !(
          event.target instanceof Element &&
          event.target.closest('input, textarea, select, [contenteditable]')
        ) &&
        !document.querySelector('[role="dialog"], [role="alertdialog"]')
      ) {
        event.preventDefault();
        stepItem(event.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
          return;
        event.preventDefault();
        openPalette();
        return;
      }
      if (key !== 'z' && key !== 'y') return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable], [role="dialog"], [role="alertdialog"]',
        )
      )
        return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
        return;
      event.preventDefault();
      if (key === 'y' || event.shiftKey) redo();
      else undo();
    };
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcuts.current?.(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}
