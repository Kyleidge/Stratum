'use client';
import type { RefObject } from 'react';
import {
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  Hash,
  HelpCircle,
  ListChecks,
  LockKeyhole,
  Moon,
  PanelRight,
  Play,
  Redo2,
  Save,
  ScanLine,
  Scissors,
  Sun,
  Undo2,
  Waves,
} from 'lucide-react';
import type { SignalEngineState } from '@/hooks/use-signal-engine';
import { formatCount } from '@/lib/format-count';
import type { Project } from '@/lib/signal-types';
import type { Theme } from '@/lib/theme';
import { stepName, type WorkflowIndex } from '@/lib/workflow-history';
import type { WorkflowBatch, WorkflowStep } from '@/lib/workflow-types';
import WorkflowCommandPalette, {
  type PaletteCommand,
  type PaletteTarget,
} from './workflow-command-palette';
import type { ToolbarAction } from './workflow-toolbar';

const reference = (step?: WorkflowStep) =>
  step ? `#${String(step.sequence + 1).padStart(3, '0')}` : '';

type CommandOptions = {
  project: Project;
  index: WorkflowIndex;
  engine: SignalEngineState;
  processingIds: string[];
  step?: WorkflowStep;
  batches: WorkflowBatch[];
  /** Whether a batch item is shown, which offers next and previous. */
  itemRun: boolean;
  /** Report assets the viewed output or step would add. */
  reportSelection: string[];
  theme: Theme;
  setTheme: (theme: Theme) => void;
  file: RefObject<HTMLInputElement | null>;
  workflowInput: RefObject<HTMLInputElement | null>;
  toolbarAction: (action: Exclude<ToolbarAction, 'report'>) => void;
  handleAction: (action: ToolbarAction) => void;
  openRunDialog: () => Promise<void>;
  setSaveOpen: (open: boolean) => void;
  switchSource: (id: string) => void;
  stepItem: (offset: -1 | 1) => void;
  setExportOpen: (open: boolean) => void;
  openReports: () => void;
  undo: () => void;
  redo: () => void;
  toggleInspector: () => void;
  setHelp: (open: boolean) => void;
};

/**
 * Command palette commands: they mirror the top bar, plus batch results,
 * Undo/Redo, the theme, Details and the guide.
 */
function workbenchCommands({
  project,
  index,
  engine,
  processingIds,
  step,
  batches,
  itemRun,
  reportSelection,
  theme,
  setTheme,
  file,
  workflowInput,
  toolbarAction,
  handleAction,
  openRunDialog,
  setSaveOpen,
  switchSource,
  stepItem,
  setExportOpen,
  openReports,
  undo,
  redo,
  toggleInspector,
  setHelp,
}: CommandOptions): PaletteCommand[] {
  return [
    ...(
      [
        ['derive', 'Derive signal…', Waves],
        ['segment', 'Segment…', Scissors],
        ['value', 'Calculate value…', Hash],
        ['align', 'Compare & align…', ScanLine],
      ] as const
    ).map(([action, label, icon]) => ({
      id: `command:${action}`,
      label,
      hint: !project.sources.length
        ? 'Import a recording first'
        : `Apply to ${processingIds.length === 1 ? index.label(processingIds[0]) : formatCount(processingIds.length, 'signal')}`,
      icon,
      disabled: engine.busy || !engine.ready || !processingIds.length,
      run: () => toolbarAction(action),
    })),
    {
      id: 'command:import',
      label: 'Import recordings…',
      hint: 'Add a recording',
      icon: ArrowDownToLine,
      disabled: engine.busy || !engine.ready,
      run: () => file.current?.click(),
    },
    {
      id: 'command:run-workflow',
      label: 'Run a workflow on recordings…',
      hint: 'Process many files with saved steps and checks',
      icon: Play,
      disabled: engine.busy || !engine.ready,
      run: () => void openRunDialog(),
    },
    {
      id: 'command:open-workflow',
      label: 'Open a workflow file…',
      icon: FolderOpen,
      disabled: engine.busy || !engine.ready,
      run: () => workflowInput.current?.click(),
    },
    {
      id: 'command:save-workflow',
      label: "Save this recording's workflow…",
      hint: 'Steps, checks and report layout as a .stratum.yaml file',
      icon: Save,
      disabled: engine.busy || !project.sources.length,
      run: () => setSaveOpen(true),
    },
    ...batches.slice(-5).map((batch) => ({
      id: `command:batch:${batch.id}`,
      label: `Open batch results · ${batch.name}`,
      hint: formatCount(batch.runs.length, 'item'),
      icon: ListChecks,
      run: () => switchSource(`batch:${batch.id}`),
    })),
    ...(itemRun
      ? [
          {
            id: 'command:next-item',
            label: 'Next batch item',
            shortcut: 'Alt →',
            icon: ChevronRight,
            run: () => stepItem(1),
          },
          {
            id: 'command:previous-item',
            label: 'Previous batch item',
            shortcut: 'Alt ←',
            icon: ChevronLeft,
            run: () => stepItem(-1),
          },
        ]
      : []),
    {
      id: 'command:export',
      label: 'Export data…',
      hint: 'Values or samples as CSV, or a quick HTML summary',
      icon: Download,
      disabled: !step?.outputIds.length,
      run: () => setExportOpen(true),
    },
    {
      id: 'command:report',
      label: 'Add to report',
      hint: 'Capture the viewed output or step',
      icon: FilePlus2,
      disabled: engine.busy || !engine.ready || !reportSelection.length,
      run: () => handleAction('report'),
    },
    {
      id: 'command:reports',
      label: 'Open Reports',
      icon: FileText,
      run: openReports,
    },
    {
      id: 'command:undo',
      label: engine.undoLabel
        ? `Undo: ${engine.undoLabel}`
        : 'Undo last change',
      shortcut: 'Ctrl Z',
      icon: Undo2,
      disabled: !engine.canUndo || engine.busy,
      run: undo,
    },
    {
      id: 'command:redo',
      label: engine.redoLabel
        ? `Redo: ${engine.redoLabel}`
        : 'Redo last change',
      shortcut: 'Ctrl Y',
      icon: Redo2,
      disabled: !engine.canRedo || engine.busy,
      run: redo,
    },
    {
      id: 'command:theme',
      label: theme === 'dark' ? 'Use light theme' : 'Use dark theme',
      icon: theme === 'dark' ? Sun : Moon,
      run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    },
    {
      id: 'command:inspector',
      label: 'Show or hide Details',
      icon: PanelRight,
      run: toggleInspector,
    },
    {
      id: 'command:guide',
      label: 'Open the workflow guide',
      icon: HelpCircle,
      run: () => setHelp(true),
    },
  ];
}

/** Every step and output in scope, opened by name from the palette. */
function workbenchTargets(
  steps: WorkflowStep[],
  index: WorkflowIndex,
  selectStep: (id: string) => void,
  follow: (id: string) => void,
): PaletteTarget[] {
  return steps.flatMap((item) => [
    {
      id: `step:${item.id}`,
      label: `${reference(item)} ${stepName(item)}`,
      hint: `Step · ${formatCount(item.outputIds.length, item.segmentSetId ? 'segment' : 'output')}`,
      icon:
        item.kind === 'value'
          ? Hash
          : item.kind === 'segment' || item.kind === 'regions'
            ? Scissors
            : item.kind === 'import'
              ? LockKeyhole
              : Waves,
      run: () => selectStep(item.id),
    },
    ...item.outputIds.map((id) => ({
      id: `output:${id}`,
      label: index.label(id),
      hint: `${index.kind(id)} · ${reference(item)}`,
      icon: index.values.has(id)
        ? Hash
        : index.nodes.get(id)?.operation === 'raw'
          ? LockKeyhole
          : Waves,
      run: () => follow(id),
    })),
  ]);
}

/**
 * Ctrl+K for the workbench: the top bar's commands and every step and
 * output in scope, by name.
 */
export default function WorkflowCommands({
  open,
  onOpenChange,
  steps,
  selectStep,
  follow,
  ...options
}: CommandOptions & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Steps in the History scope. */
  steps: WorkflowStep[];
  selectStep: (id: string) => void;
  follow: (id: string) => void;
}) {
  return (
    <WorkflowCommandPalette
      open={open}
      onOpenChange={onOpenChange}
      commands={workbenchCommands(options)}
      targets={() => workbenchTargets(steps, options.index, selectStep, follow)}
    />
  );
}
