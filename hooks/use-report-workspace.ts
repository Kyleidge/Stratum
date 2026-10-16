'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SignalEngineState } from '@/hooks/use-signal-engine';
import type { WorkflowSelection } from '@/components/workflow-history';
import {
  reportAssets,
  reportSnapshotStates,
  reportTargetAssets,
  resolveReportAssets,
} from '@/lib/report-data';
import type {
  ReportBuilderHandle,
  ReportWorkspace,
} from '@/lib/report-integration';
import type { ReportBlock } from '@/lib/report-mockup';
import { captureReportPlot } from '@/lib/report-plot';
import type { PlotSheet } from '@/lib/plot-scratchpad';
import type { Project } from '@/lib/signal-types';
import { readWorkflowDrag } from '@/lib/workflow-drag';
import type { WorkflowIndex } from '@/lib/workflow-history';

const reportBlockCount = (document: { pages: { blocks: unknown[] }[] }) =>
  document.pages.reduce((sum, page) => sum + page.blocks.length, 0);
/**
 * Blocks added to the report since it held `before`. The editor publishes
 * its draft after rendering, so this waits briefly for the count to change;
 * a capture that failed leaves it unchanged.
 */
async function reportBlocksAdded(
  read: () => { pages: { blocks: unknown[] }[] } | undefined,
  before: number,
) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const report = read();
    const added = report ? reportBlockCount(report) - before : 0;
    if (added > 0) return added;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return 0;
}

/**
 * The Reports workspace beside Data: which one is shown, the report editor's
 * handle and the assets it may capture, and Add to report with its toast and
 * the Reports badge.
 */
export function useReportWorkspace({
  project,
  index,
  selection,
  engine,
  closeDrawers,
  setNotice,
  onAdd,
}: {
  project: Project;
  index: WorkflowIndex;
  selection: WorkflowSelection;
  engine: SignalEngineState;
  /** Closes the History and Details drawers; stable. */
  closeDrawers: () => void;
  setNotice: (notice: string) => void;
  /** Called as a capture starts. */
  onAdd: () => void;
}) {
  const request = engine.request;
  const report = useRef<ReportBuilderHandle>(null);
  // Both workspaces stay mounted; switching only changes which one is shown.
  const [workspaceView, setWorkspaceView] = useState<'data' | 'reports'>(
    'data',
  );
  const reportsShown = workspaceView === 'reports';
  const [reportSheets, setReportSheets] = useState<PlotSheet[]>([]);
  const openDataInspector = useCallback(() => setWorkspaceView('data'), []);
  // Adding to the report keeps Data shown: a toast offers Open Reports and
  // the Reports switch counts snapshots added since it was last opened.
  const [reportToast, setReportToast] = useState<{
    id: number;
    added: number;
  }>();
  const [reportAdded, setReportAdded] = useState(0);
  const openReports = useCallback(() => {
    setWorkspaceView('reports');
    closeDrawers();
    setReportAdded(0);
    setReportToast(undefined);
  }, [closeDrawers]);
  const announceReport = useCallback((added: number) => {
    if (added > 0) setReportAdded((count) => count + added);
    setReportToast({ id: Date.now(), added });
  }, []);
  useEffect(() => {
    if (!reportToast) return;
    const timer = setTimeout(() => setReportToast(undefined), 8000);
    return () => clearTimeout(timer);
  }, [reportToast]);
  // Stable, so the Save dialog reads the latest draft without re-extracting each render.
  const readReport = useCallback(() => report.current?.getReport(), []);
  const addReportBlocks = useCallback(
    (blocks: ReportBlock[]) => {
      const editor = report.current;
      if (!editor || !blocks.length) return;
      const before = reportBlockCount(editor.getReport());
      editor.addBlocks(blocks);
      void reportBlocksAdded(editor.getReport, before).then(announceReport);
    },
    [announceReport],
  );
  const reportLibrary = useMemo(
    () => reportAssets(project, reportSheets),
    [project, reportSheets],
  );
  const reportRevision = useMemo(
    () => ({ project, sheets: reportSheets }),
    [project, reportSheets],
  );
  function reportOutputIds(ids: string[]) {
    return ids.flatMap((id) =>
      index.nodes.has(id)
        ? [`signal:${id}`]
        : index.values.has(id)
          ? [`value:${id}`]
          : [],
    );
  }
  const reportWorkspace: ReportWorkspace = {
    assets: reportLibrary,
    selectionIds: reportTargetAssets(index, selection),
    busy: engine.busy || !engine.ready,
    revision: reportRevision,
    resolveAssets: (ids, signal) =>
      resolveReportAssets(
        project,
        reportSheets,
        ids,
        request,
        (sheet, signal) => captureReportPlot(project, sheet, request, signal),
        signal,
      ),
    resolveDrop: (raw) => {
      const target = readWorkflowDrag(raw, index);
      return target ? reportTargetAssets(index, target) : [];
    },
    snapshotStates: (sources) => reportSnapshotStates(project, sources),
  };
  /** Captures `ids` into the report; only a drop on Reports switches to it. */
  function addToReport(ids: string[], open = false) {
    const editor = report.current;
    if (!ids.length && !engine.busy) {
      setNotice(
        'Segments are time intervals, not results. Add the signals or values made within them instead.',
      );
      return;
    }
    if (!ids.length || engine.busy || !engine.ready || !editor) return;
    if (open) openReports();
    onAdd();
    const before = reportBlockCount(editor.getReport());
    void editor
      .addAssets(ids)
      .then(() =>
        open ? undefined : reportBlocksAdded(editor.getReport, before),
      )
      .then((added) => {
        if (added !== undefined) announceReport(added);
      });
  }

  return {
    report,
    workspaceView,
    reportsShown,
    openDataInspector,
    openReports,
    reportToast,
    setReportToast,
    reportAdded,
    setReportSheets,
    readReport,
    addReportBlocks,
    reportOutputIds,
    reportWorkspace,
    addToReport,
  };
}
