'use client';

import { useEffect, useRef, useState } from 'react';
import { createPlotLoader, type PlotJob, type PlotView } from '@/lib/plot-view';
import type {
  EngineRequest,
  EngineResponse,
  Project,
} from '@/lib/signal-types';

export function usePlotView(
  project: Project,
  sourceKey: string,
  viewKey: string,
  request: (message: EngineRequest) => Promise<EngineResponse>,
  retry: number,
  scope: string,
) {
  const loader = useRef<ReturnType<typeof createPlotLoader> | undefined>(
    undefined,
  );
  const [result, setResult] = useState<{
    project: Project;
    sourceKey: string;
    scope: string;
    view: PlotView;
  }>();
  useEffect(() => {
    const current = createPlotLoader(
      JSON.parse(sourceKey) as PlotJob[],
      request,
      (view) => setResult({ project, sourceKey, scope, view }),
    );
    loader.current = current;
    return () => current.dispose();
  }, [project, sourceKey, request, retry, scope]);
  useEffect(() => {
    loader.current?.update(JSON.parse(viewKey) as PlotJob[]);
  }, [project, sourceKey, viewKey, request, retry, scope]);
  return {
    view:
      result?.project === project &&
      result.sourceKey === sourceKey &&
      result.scope === scope
        ? result.view
        : undefined,
    preview: (jobs?: PlotJob[]) => {
      loader.current?.update(
        jobs ?? (JSON.parse(viewKey) as PlotJob[]),
        !!jobs,
      );
    },
  };
}
