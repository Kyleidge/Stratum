'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createSignalWorker } from '@/lib/create-signal-worker';
import type {
  EngineRequest,
  EngineResponse,
  Project,
} from '@/lib/signal-types';

export function useSignalEngine(
  initialization: 'init-regions' | 'init-workflow' = 'init-regions',
) {
  const worker = useRef<Worker | null>(null),
    serial = useRef(0);
  const pending = useRef(
    new Map<
      number,
      {
        resolve: (response: EngineResponse) => void;
        reject: (error: Error) => void;
      }
    >(),
  );
  const [project, setProject] = useState<Project>({
    sources: [],
    nodes: [],
    segments: [],
  });
  const [ready, setReady] = useState(false),
    [canUndo, setCanUndo] = useState(false),
    [canRedo, setCanRedo] = useState(false),
    [undoLabel, setUndoLabel] = useState<string>(),
    [redoLabel, setRedoLabel] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('Opening local workspace…');
  const request = useCallback(
    (message: EngineRequest) =>
      new Promise<EngineResponse>((resolve, reject) => {
        if (!worker.current) {
          reject(new Error('The signal engine is not ready.'));
          return;
        }
        const requestId = ++serial.current;
        pending.current.set(requestId, { resolve, reject });
        try {
          worker.current.postMessage({ ...message, requestId });
        } catch {
          pending.current.delete(requestId);
          reject(new Error('The worker is unavailable. Reload the workspace.'));
        }
      }),
    [],
  );
  useEffect(() => {
    let engine: Worker;
    try {
      engine = createSignalWorker();
    } catch {
      queueMicrotask(() =>
        setError('The signal worker could not start. Reload the workspace.'),
      );
      return;
    }
    worker.current = engine;
    engine.onmessage = ({ data }: MessageEvent<EngineResponse>) => {
      if (data.type === 'progress') {
        setStatus(data.message);
        return;
      }
      const waiting = pending.current.get(data.requestId);
      if (!waiting) return;
      pending.current.delete(data.requestId);
      if (data.type === 'error') waiting.reject(new Error(data.message));
      else waiting.resolve(data);
    };
    const fail = () => {
      const failure = new Error(
        'The signal worker stopped. Reload the workspace.',
      );
      setError(failure.message);
      engine.terminate();
      worker.current = null;
      setReady(false);
      setBusy(false);
      for (const waiting of pending.current.values()) waiting.reject(failure);
      pending.current.clear();
    };
    engine.onerror = fail;
    engine.onmessageerror = fail;
    let alive = true;
    const startupUrl = new URL(location.href);
    const refreshExample = startupUrl.searchParams.has('refresh-example');
    void request(
      initialization === 'init-workflow'
        ? { type: initialization, refreshExample }
        : { type: initialization },
    )
      .then((response) => {
        if (alive && response.type === 'project') {
          if (refreshExample) {
            startupUrl.searchParams.delete('refresh-example');
            history.replaceState(history.state, '', startupUrl);
          }
          setProject(response.project);
          setCanUndo(!!response.canUndo);
          setCanRedo(!!response.canRedo);
          setUndoLabel(response.undoLabel);
          setRedoLabel(response.redoLabel);
          setStatus('Ready · local processing');
          setReady(true);
        }
      })
      .catch((caught: Error) => {
        if (alive) setError(caught.message);
      });
    const waiting = pending.current;
    return () => {
      alive = false;
      engine.terminate();
      worker.current = null;
      for (const item of waiting.values())
        item.reject(new Error('Worker closed.'));
      waiting.clear();
    };
  }, [request, initialization]);
  async function mutate(message: EngineRequest, label: string) {
    setBusy(true);
    setError('');
    setStatus(label);
    try {
      const response = await request(message);
      if (response.type !== 'project')
        throw new Error('Unexpected engine response.');
      setProject(response.project);
      setCanUndo(!!response.canUndo);
      setCanRedo(!!response.canRedo);
      setUndoLabel(response.undoLabel);
      setRedoLabel(response.redoLabel);
      setStatus('Saved · source data unchanged');
      return response.project;
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Processing failed.';
      setError(message);
      setStatus('Ready');
      throw caught;
    } finally {
      setBusy(false);
    }
  }
  /**
   * Run several mutations as one busy period, applying each committed project
   * as it arrives. `step` sees each result and may stop the sequence early.
   */
  async function sequence(
    messages: EngineRequest[],
    labels: string[],
    step: (
      index: number,
      result: { project?: Project; error?: Error },
    ) => boolean | void,
  ) {
    setBusy(true);
    setError('');
    try {
      for (const [index, message] of messages.entries()) {
        setStatus(labels[index] ?? 'Processing…');
        let result: { project?: Project; error?: Error };
        try {
          const response = await request(message);
          if (response.type !== 'project')
            throw new Error('Unexpected engine response.');
          setProject(response.project);
          setCanUndo(!!response.canUndo);
          setCanRedo(!!response.canRedo);
          setUndoLabel(response.undoLabel);
          setRedoLabel(response.redoLabel);
          result = { project: response.project };
        } catch (caught) {
          result = {
            error:
              caught instanceof Error
                ? caught
                : new Error('Processing failed.'),
          };
        }
        if (step(index, result) === false) break;
      }
      setStatus('Saved · source data unchanged');
    } finally {
      setBusy(false);
    }
  }
  async function preview(message: EngineRequest) {
    setBusy(true);
    setStatus('Previewing segment boundaries…');
    try {
      return await request(message);
    } finally {
      setBusy(false);
      setStatus('Preview complete · no results created');
    }
  }
  return {
    project,
    ready,
    canUndo,
    canRedo,
    /** The action Undo would reverse, when the journal names it. */
    undoLabel,
    redoLabel,
    busy,
    error,
    status,
    request,
    mutate,
    sequence,
    preview,
    setError,
    cancel: () =>
      worker.current?.postMessage({
        type: 'cancel',
        requestIds: [...pending.current.keys()],
      }),
  };
}
