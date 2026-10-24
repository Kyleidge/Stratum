'use client';
import { useEffect, useState } from 'react';
import type { AssistantStatus, StratumDesktop } from '@/lib/desktop-bridge';
import { formatCount } from '@/lib/format-count';

/** The MCP client entry that starts Stratum's assistant server. */
export function assistantConfig(status: AssistantStatus) {
  return JSON.stringify(
    {
      mcpServers: {
        stratum: {
          command: status.command,
          args: status.args,
          env: status.env,
        },
      },
    },
    null,
    2,
  );
}

/**
 * Workspace dialog, desktop only: lets the user allow AI assistants (MCP
 * clients such as Claude Desktop) to work in this workspace, says what that
 * shares, and gives the entry to add to the assistant's configuration.
 */
export default function AssistantSettings({
  assistant,
  open,
}: {
  assistant: NonNullable<StratumDesktop['assistant']>;
  open: boolean;
}) {
  const [status, setStatus] = useState<AssistantStatus>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void assistant
      .settings()
      .then((value) => alive && setStatus(value))
      .catch(() => {});
    const stop = assistant.onStatus((value) => alive && setStatus(value));
    return () => {
      alive = false;
      stop();
    };
  }, [assistant, open]);

  async function choose(enabled: boolean) {
    setBusy(true);
    setMessage('');
    try {
      setStatus(await assistant.setEnabled(enabled));
    } catch (caught) {
      setMessage(
        caught instanceof Error
          ? caught.message
          : 'Could not change AI assistant access.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(assistantConfig(status));
      setMessage('Copied. Paste it into the assistant’s configuration.');
    } catch {
      setMessage('Could not copy; select the text and copy it instead.');
    }
  }

  return (
    <>
      <h3 className="workflow-storage-heading">AI assistants</h3>
      <p className="workflow-muted">
        Let an AI assistant such as Claude Desktop work in this workspace: read
        your recordings, steps and values, and add, change or delete steps. Its
        changes appear in History and can be undone. Stratum sends nothing
        itself, but what the assistant reads is sent to its AI service.
      </p>
      {status?.enabled ? (
        <>
          <p className="workflow-muted">
            Allowed
            {status.connections
              ? ` · ${formatCount(status.connections, 'assistant')} connected`
              : ' · no assistant connected'}
            . To connect Claude Desktop, open its Settings → Developer → Edit
            Config and add this entry, then restart it:
          </p>
          <pre className="workflow-assistant-config">
            {assistantConfig(status)}
          </pre>
          <div className="workflow-storage-actions">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void copy()}
            >
              Copy configuration
            </button>
            <button
              className="workflow-link"
              disabled={busy}
              onClick={() => void choose(false)}
            >
              Turn off
            </button>
          </div>
        </>
      ) : (
        <div className="workflow-storage-actions">
          <button
            className="secondary-button"
            disabled={busy || !status}
            onClick={() => void choose(true)}
          >
            Allow AI assistants
          </button>
        </div>
      )}
      {message && <output className="workflow-muted">{message}</output>}
    </>
  );
}
