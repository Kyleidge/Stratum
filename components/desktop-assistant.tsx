'use client';
import { useEffect, useRef, useState } from 'react';
import { Bot, X } from 'lucide-react';
import { handleAssistantCall, type AssistantHost } from '@/lib/assistant-host';
import { desktopBridge } from '@/lib/desktop-bridge';
import type { EngineRequest, EngineResponse } from '@/lib/signal-types';
import type { AssistantState } from '@/lib/assistant-protocol';

type Automation = {
  readonly state: AssistantState;
  request(message: EngineRequest): Promise<EngineResponse>;
  cancel(): void;
  show(id: string): string;
};

/**
 * Desktop only: answers a connected AI assistant's calls with the
 * workbench's own requests (lib/assistant-host.ts) and says what each change
 * it made was, so the user always sees it. Calls arrive only while the user
 * allows AI assistants (Workspace dialog).
 */
export default function DesktopAssistant({
  automation,
}: {
  automation: Automation;
}) {
  const [change, setChange] = useState<{ id: number; label: string }>();
  const automationRef = useRef(automation);
  useEffect(() => {
    automationRef.current = automation;
  }, [automation]);
  useEffect(() => {
    const assistant = desktopBridge()?.assistant;
    if (!assistant) return;
    const host: AssistantHost = {
      state: () => {
        const { project, revision, canUndo, canRedo, undoLabel, redoLabel } =
          automationRef.current.state;
        return { project, revision, canUndo, canRedo, undoLabel, redoLabel };
      },
      request: (message) => automationRef.current.request(message),
      cancel: () => automationRef.current.cancel(),
      show: (id) => automationRef.current.show(id),
      changed: (label) => setChange({ id: Date.now(), label }),
    };
    return assistant.onCall((call) =>
      handleAssistantCall({ id: 0, ...call }, host),
    );
  }, []);
  useEffect(() => {
    if (!change) return;
    const timer = setTimeout(() => setChange(undefined), 8000);
    return () => clearTimeout(timer);
  }, [change]);
  if (!change) return null;
  return (
    <output key={change.id} className="workflow-toast workflow-assistant-toast">
      <Bot size={15} />
      <span>AI assistant: {change.label}</span>
      <button
        className="workflow-icon-button workflow-quiet"
        aria-label="Dismiss"
        onClick={() => setChange(undefined)}
      >
        <X size={14} />
      </button>
    </output>
  );
}
