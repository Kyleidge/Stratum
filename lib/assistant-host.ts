import {
  ASSISTANT_REQUESTS,
  fromBase64,
  READ_REQUESTS,
  toBase64,
  type AssistantCall,
  type AssistantFile,
  type AssistantRequestResult,
  type AssistantState,
} from './assistant-protocol';
import type { EngineRequest, EngineResponse } from './signal-types';

/** What the workbench offers an assistant (see `useSignalEngine`). */
export type AssistantHost = {
  state(): AssistantState;
  /** Sends a request as the workbench does and applies a committed project. */
  request(message: EngineRequest): Promise<EngineResponse>;
  cancel(): void;
  /** Selects an ID in the window; returns what it showed. */
  show(id: string): string;
  /** Reports a committed change, so the window can say what happened. */
  changed?(label: string): void;
};

/** Rebuilds `{ $fileIndex }` placeholders as File objects. */
function revive(value: unknown, files: AssistantFile[]): unknown {
  if (Array.isArray(value)) return value.map((item) => revive(item, files));
  if (value && typeof value === 'object') {
    const index = (value as { $fileIndex?: unknown }).$fileIndex;
    if (typeof index === 'number') {
      const file = files[index];
      if (!file) throw new Error('A file in the request is missing.');
      return new File([fromBase64(file.data)], file.name);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, revive(item, files)]),
    );
  }
  return value;
}

/** Draws an SVG on a canvas and returns base64 PNG (renderer only). */
async function svgToPng(svg: string): Promise<string> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d')?.drawImage(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) throw new Error('The plot could not be drawn.');
    return toBase64(new Uint8Array(await blob.arrayBuffer()));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Answers one call from the assistant channel. Only `ASSISTANT_REQUESTS`
 * reach the engine, through the workbench's own request path, so changes
 * appear in History and can be undone like the user's own.
 */
export async function handleAssistantCall(
  call: AssistantCall,
  host: AssistantHost,
): Promise<unknown> {
  const params = call.params ?? {};
  switch (call.method) {
    case 'hello':
      return { ok: true };
    case 'state':
      return host.state();
    case 'cancel':
      host.cancel();
      return { ok: true };
    case 'show':
      return host.show(String(params.id));
    case 'render-png':
      return svgToPng(String(params.svg));
    case 'request': {
      const message = params.message as EngineRequest | undefined;
      if (!message || !ASSISTANT_REQUESTS.has(message.type))
        throw new Error(
          `An assistant cannot send "${String(message?.type)}" requests.`,
        );
      const before = host.state();
      const response = await host.request(
        revive(
          message,
          (params.files as AssistantFile[]) ?? [],
        ) as EngineRequest,
      );
      if (response.type === 'project' && !READ_REQUESTS.has(message.type))
        host.changed?.(
          message.type === 'undo'
            ? `Undo ${before.undoLabel ?? 'last change'}`
            : message.type === 'redo'
              ? `Redo ${before.redoLabel ?? 'last change'}`
              : (response.undoLabel ?? 'Workspace changed'),
        );
      if (response.type === 'export') {
        const { blob, ...rest } = response;
        return {
          ...rest,
          bytesBase64: toBase64(new Uint8Array(await blob.arrayBuffer())),
        } satisfies AssistantRequestResult;
      }
      return response;
    }
    default:
      throw new Error(`Unknown assistant call: ${String(call.method)}`);
  }
}
