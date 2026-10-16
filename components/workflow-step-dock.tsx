'use client';
import type { ComponentProps } from 'react';
import type { SignalEngineState } from '@/hooks/use-signal-engine';
import { stepName } from '@/lib/workflow-history';
import type { WorkflowStep } from '@/lib/workflow-types';
import { SignalSamples } from './plot-scratchpad';
import { RegionSelect } from './region-controls';
import WorkflowDock, {
  WorkflowStepSettings,
  type DockTab,
} from './workflow-dock';
import WorkflowOutputsPanel from './workflow-outputs-panel';

const reference = (step?: WorkflowStep) =>
  step ? `#${String(step.sequence + 1).padStart(3, '0')}` : '';

/**
 * The viewed step's dock below Active: its outputs, exact samples of a
 * plotted signal, or its saved settings with Edit and New version.
 */
export default function WorkflowStepDock({
  project,
  index,
  graph,
  step,
  selection,
  busy,
  request,
  dockTab,
  setDockTab,
  dockOpen,
  setDockOpen,
  sampleChoices,
  dockSampleId,
  setSampleChoice,
  repeat,
  ...outputs
}: Omit<ComponentProps<typeof WorkflowOutputsPanel>, 'repeat'> & {
  request: SignalEngineState['request'];
  dockTab: DockTab;
  setDockTab: (tab: DockTab) => void;
  dockOpen: boolean;
  setDockOpen: (open: boolean) => void;
  /** Plotted signals whose samples the Samples tab can show. */
  sampleChoices: string[];
  dockSampleId: string;
  setSampleChoice: (id: string) => void;
  /** Opens the step's settings; `editing` edits it in place. */
  repeat: (editing?: boolean) => void;
}) {
  const { setExportOpen } = outputs;
  const stepOutputs = step.outputIds;
  return (
    <WorkflowDock
      tab={dockTab}
      onTab={setDockTab}
      open={dockOpen}
      onOpen={setDockOpen}
      outputCount={stepOutputs.length}
      context={
        dockTab === 'samples' && dockSampleId
          ? `Exact samples · ${index.label(dockSampleId)}`
          : `${reference(step)} ${stepName(step)}`
      }
    >
      {dockTab === 'outputs' ? (
        <WorkflowOutputsPanel
          project={project}
          index={index}
          graph={graph}
          step={step}
          selection={selection}
          busy={busy}
          {...outputs}
          repeat={() => repeat()}
        />
      ) : dockTab === 'samples' ? (
        <section className="workflow-dock-samples">
          {sampleChoices.length > 1 && (
            <RegionSelect
              label="Signal"
              value={dockSampleId}
              items={sampleChoices.map((id) => ({
                value: id,
                label: index.label(id),
              }))}
              onChange={setSampleChoice}
            />
          )}
          {dockSampleId ? (
            <SignalSamples
              key={dockSampleId}
              id={dockSampleId}
              project={project}
              unit={index.nodes.get(dockSampleId)?.unit ?? ''}
              request={request}
              onExport={() => setExportOpen(true)}
              busy={busy}
            />
          ) : (
            <p className="workflow-empty">
              This selection has no signal samples.
            </p>
          )}
        </section>
      ) : (
        <WorkflowStepSettings
          step={step}
          index={index}
          busy={busy}
          onEdit={() => repeat(true)}
          onNewVersion={() => repeat()}
        />
      )}
    </WorkflowDock>
  );
}
