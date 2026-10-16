'use client';
import { Hash, LockKeyhole, Waves, X } from 'lucide-react';
import type { SignalEngineState } from '@/hooks/use-signal-engine';
import { formatCount } from '@/lib/format-count';
import type { Project, SignalNode, Source } from '@/lib/signal-types';
import type { WorkflowTarget } from '@/lib/workflow-drag';
import { stepName, type WorkflowIndex } from '@/lib/workflow-history';
import type { ScalarValue } from '@/lib/workflow-types';

/**
 * The status bar: the selection, the latest notice (with Undo when it names
 * the latest change), the scope's inventory and Cancel while busy.
 */
export default function WorkflowStatusBar({
  project,
  index,
  engine,
  hidden,
  title,
  notice,
  setNotice,
  undoable,
  undo,
  dragged,
  activeNode,
  activeValue,
  outputCount,
  allSegments,
  countAll,
  source,
}: {
  project: Project;
  index: WorkflowIndex;
  engine: SignalEngineState;
  hidden: boolean;
  /** The selection's name. */
  title: string;
  notice: string;
  setNotice: (notice: string) => void;
  /** The notice describes the latest change, which Undo reverses. */
  undoable: boolean;
  undo: () => void;
  dragged: WorkflowTarget | null;
  activeNode?: SignalNode;
  activeValue?: ScalarValue;
  /** Outputs of the viewed step. */
  outputCount: number;
  allSegments: boolean;
  /** Count every recording rather than `source` alone. */
  countAll: boolean;
  source?: Source;
}) {
  const originalCount = countAll
    ? project.sources.reduce((sum, item) => sum + item.channels.length, 0)
    : (source?.channels.length ?? 0);
  const derivedCount = project.nodes.filter(
    (node) =>
      (countAll || node.sourceId === source?.id) &&
      node.operation !== 'raw' &&
      !node.internal,
  ).length;
  const valueCount = (project.values ?? []).filter(
    (value) => countAll || value.sourceId === source?.id,
  ).length;
  return (
    <footer className="workflow-status" hidden={hidden}>
      <span className="workflow-status-selection" title={title}>
        {title}
      </span>
      <output
        className={notice ? 'workflow-notice' : undefined}
        aria-live="polite"
      >
        {dragged
          ? `Dragging ${dragged.kind === 'step' ? stepName(index.steps.get(dragged.id)!) : index.label(dragged.id)} · drop on a plot or highlighted tool`
          : notice ||
            (engine.busy
              ? engine.status
              : activeNode
                ? 'Ready'
                : activeValue
                  ? 'Ready'
                  : formatCount(
                      outputCount,
                      allSegments ? 'segment' : 'output',
                    ))}
        {notice && undoable && engine.canUndo && !engine.busy && (
          <button className="workflow-notice-undo" onClick={() => undo()}>
            Undo
          </button>
        )}
        {notice && (
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice('')}
          >
            <X size={14} />
          </button>
        )}
      </output>
      <span className="workflow-inventory">
        <span>
          <LockKeyhole size={12} />
          {formatCount(originalCount, 'original signal')}
        </span>
        <span>
          <Waves size={12} />
          {formatCount(derivedCount, 'derived signal')}
        </span>
        <span>
          <Hash size={12} />
          {formatCount(valueCount, 'value')}
        </span>
      </span>
      {engine.busy ? (
        <button onClick={engine.cancel}>Cancel operation</button>
      ) : (
        <span>
          <LockKeyhole size={12} /> Saved locally
        </span>
      )}
    </footer>
  );
}
