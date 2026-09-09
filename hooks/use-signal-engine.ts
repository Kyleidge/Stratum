'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createSignalWorker } from '@/lib/create-signal-worker';
import type {
  EngineRequest,
  EngineResponse,
  Project,
} from '@/lib/signal-types';

export function useSignalEngine() {
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
        worker.current.postMessage({ ...message, requestId });
      }),
    [],
  );
  useEffect(() => {
    const engine = createSignalWorker();
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
    engine.onerror = () => {
      const failure = new Error(
        'The signal worker stopped. Reload the workspace.',
      );
      setError(failure.message);
      for (const waiting of pending.current.values()) waiting.reject(failure);
      pending.current.clear();
    };
    let alive = true;
    void request({ type: 'init-regions' })
      .then((response) => {
        if (alive && response.type === 'project') {
          setProject(response.project);
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
  }, [request]);
  async function mutate(message: EngineRequest, label: string) {
    setBusy(true);
    setError('');
    setStatus(label);
    try {
      const response = await request(message);
      if (response.type !== 'project')
        throw new Error('Unexpected engine response.');
      setProject(response.project);
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
  async function preview(message: EngineRequest) {
    setBusy(true);
    setStatus('Previewing region boundaries…');
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
    busy,
    error,
    status,
    request,
    mutate,
    preview,
    setError,
    cancel: () => worker.current?.postMessage({ type: 'cancel' }),
  };
}
