'use client';

import { useEffect, useRef, useState } from 'react';

const PANES = {
  history: {
    id: 'workflow-navigation',
    label: 'Operation history',
    initial: 300,
    min: 250,
    max: 640,
    fraction: 0.48,
    direction: 1,
  },
  inspector: {
    id: 'workflow-inspector',
    label: 'Inspector',
    initial: 300,
    min: 260,
    max: 520,
    fraction: 0.4,
    direction: -1,
  },
} as const;

/** Resize the existing panes without remounting the history or live plots. */
export default function WorkflowPaneResizer({
  pane,
}: {
  pane: keyof typeof PANES;
}) {
  const settings = PANES[pane];
  const property = `--workflow-${pane}-width`;
  const storageKey = `stratus-${pane}-width-v1`;
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    width: number;
    previous: string;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [bounds, setBounds] = useState<{ width: number; max: number }>({
    width: settings.initial,
    max: settings.max,
  });

  useEffect(() => {
    const container = handle.current?.parentElement;
    const target = document.getElementById(settings.id);
    if (!container || !target) return;
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (
        Number.isFinite(saved) &&
        saved >= settings.min &&
        saved <= settings.max
      )
        container.style.setProperty(property, `${saved}px`);
    } catch {
      // Resizing remains available when local storage is unavailable.
    }
    const observer = new ResizeObserver(() => {
      setBounds({
        width: Math.round(target.getBoundingClientRect().width),
        max: Math.round(
          Math.max(
            settings.min,
            Math.min(settings.max, container.clientWidth * settings.fraction),
          ),
        ),
      });
    });
    observer.observe(container);
    observer.observe(target);
    return () => observer.disconnect();
  }, [property, settings, storageKey]);

  function resize(width: number, save = false) {
    const container = handle.current?.parentElement;
    if (!container) return;
    const max = Math.min(
      settings.max,
      container.clientWidth * settings.fraction,
    );
    const next = Math.max(settings.min, Math.min(width, max));
    container.style.setProperty(property, `${next}px`);
    if (save) {
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        // Keep the current width for this session even if it cannot be saved.
      }
    }
  }
  function finish(save: boolean) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setDragging(false);
    const container = handle.current?.parentElement;
    if (save) {
      const target = document.getElementById(settings.id);
      if (target) resize(target.getBoundingClientRect().width, true);
    } else if (current.previous) {
      container?.style.setProperty(property, current.previous);
    } else {
      container?.style.removeProperty(property);
    }
    if (handle.current?.hasPointerCapture(current.pointerId))
      handle.current.releasePointerCapture(current.pointerId);
  }

  return (
    <div
      ref={handle}
      className={`workflow-pane-resizer workflow-${pane}-resizer`}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- A focusable window splitter uses the interactive ARIA separator pattern.
      role="separator"
      tabIndex={0}
      aria-label={`Resize ${settings.label}`}
      aria-controls={settings.id}
      aria-orientation="vertical"
      aria-valuemin={settings.min}
      aria-valuemax={bounds.max}
      aria-valuenow={bounds.width}
      aria-valuetext={`${bounds.width} pixels`}
      title={`Resize ${settings.label} · drag or use arrow keys · double-click to reset`}
      data-dragging={dragging}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        const target = document.getElementById(settings.id);
        if (!target) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          width: target.getBoundingClientRect().width,
          previous:
            event.currentTarget.parentElement?.style.getPropertyValue(
              property,
            ) ?? '',
        };
        setDragging(true);
        if (event.isTrusted)
          event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        resize(
          current.width + (event.clientX - current.startX) * settings.direction,
        );
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) finish(true);
      }}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(false)}
      onDoubleClick={() => resize(settings.initial, true)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && drag.current) {
          event.preventDefault();
          finish(false);
          return;
        }
        const target = document.getElementById(settings.id);
        if (!target || drag.current) return;
        let width = target.getBoundingClientRect().width;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
          width +=
            (event.key === 'ArrowRight' ? 1 : -1) *
            settings.direction *
            (event.shiftKey ? 50 : 10);
        else if (event.key === 'Home') width = settings.min;
        else if (event.key === 'End') width = bounds.max;
        else if (event.key === 'Enter') width = settings.initial;
        else return;
        event.preventDefault();
        resize(width, true);
      }}
    />
  );
}
