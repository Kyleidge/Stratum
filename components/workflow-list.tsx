'use client';
import { useState, type ReactNode } from 'react';
import { formatCount } from '@/lib/format-count';

/** Disclosures do no hidden row rendering; every member remains reachable. */
export default function WorkflowList<T>({
  items,
  summary,
  className,
  children,
  initialOpen = false,
}: {
  items: readonly T[];
  summary: ReactNode;
  className?: string;
  children: (page: readonly T[]) => ReactNode;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen),
    [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / 30));
  const current = Math.min(page, pages - 1);
  return (
    <details
      open={open}
      className={className}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{summary}</summary>
      {open && (
        <>
          {children(items.slice(current * 30, (current + 1) * 30))}
          {pages > 1 && (
            <nav className="workflow-list-pages" aria-label="List pages">
              <button
                className="workflow-link"
                disabled={!current}
                onClick={() => setPage(current - 1)}
              >
                Previous
              </button>
              <span>
                Page {current + 1} of {pages} ·{' '}
                {formatCount(items.length, 'item')}
              </span>
              <button
                className="workflow-link"
                disabled={current + 1 === pages}
                onClick={() => setPage(current + 1)}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </details>
  );
}
