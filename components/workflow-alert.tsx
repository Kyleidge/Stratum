'use client';
import { AlertCircle, X } from 'lucide-react';
import { needsReload } from '@/lib/engine-error';
import { cn } from '@/lib/utils';

/**
 * An error message. Reload is offered only for worker or storage failures;
 * validation messages are dismissible and never suggest reloading.
 */
export function WorkflowAlert({
  message,
  ready = true,
  onDismiss,
  onCsvHelp,
  className,
}: {
  message: string;
  ready?: boolean;
  onDismiss?: () => void;
  /** Shown for CSV import problems: opens the expected file format. */
  onCsvHelp?: () => void;
  className?: string;
}) {
  const reload = needsReload(message, ready);
  const csv = !reload && /\.csv\b/i.test(message);
  return (
    <div
      className={cn('workflow-error', className)}
      role="alert"
      data-severity={reload ? 'failure' : 'problem'}
    >
      <AlertCircle size={15} aria-hidden />
      <span className="workflow-error-message">{message}</span>
      {csv && onCsvHelp && (
        <button type="button" className="workflow-link" onClick={onCsvHelp}>
          CSV format
        </button>
      )}
      {reload && (
        <button
          type="button"
          className="workflow-link"
          onClick={() => location.reload()}
        >
          Reload workspace
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="workflow-error-dismiss"
          aria-label="Dismiss error"
          onClick={onDismiss}
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}
