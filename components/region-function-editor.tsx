'use client';
import { useState } from 'react';
import { Play, Sigma } from 'lucide-react';
import { FUNCTIONS, type FunctionSpec } from '@/lib/signal-functions';
import { operationLabels } from '@/lib/signal-explorer';
import { regionHistory } from '@/lib/region-model';
import type { Project, Operation, Source } from '@/lib/signal-types';
import type { FunctionRun, FunctionSettings } from '@/lib/region-types';
import { finite, RegionNumber, RegionSelect } from './region-controls';

export const REGION_FUNCTIONS: FunctionSpec[] = [
  ...FUNCTIONS.filter((spec) => spec.operation !== 'segment'),
  {
    operation: 'power',
    name: 'Brake power',
    category: 'Calculation',
    description:
      'Calculate brake power from synchronized torque [Nm] and speed [rpm].',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
  {
    operation: 'bsfc',
    name: 'Specific fuel consumption',
    category: 'Calculation',
    description:
      'Fuel flow [kg/h] divided by brake power [kW], giving g/kWh. Nonpositive power is excluded.',
    parameter: '',
    defaultValue: 0,
    unit: '',
  },
];
export function inputChoices(project: Project, source: Source) {
  const steps = new Map(
    regionHistory(project, source.id).map((item, index) => [
      item.id,
      index + 1,
    ]),
  );
  return [
    ...source.channels.map((id) => ({
      value: `signal:${id}`,
      label: `Original · ${project.nodes.find((node) => node.id === id)?.name}`,
    })),
    ...(project.functionRuns ?? [])
      .filter((run) => run.sourceId === source.id)
      .map((run) => ({
        value: `run:${run.id}`,
        label: `${String(steps.get(run.id)).padStart(2, '0')} · ${operationLabels[run.operation]} · ${run.outputs.length} result${run.outputs.length === 1 ? '' : 's'}`,
      })),
  ];
}
export function resolveInput(project: Project, key: string): string[] {
  if (key.startsWith('run:'))
    return (
      project.functionRuns
        ?.find((run) => run.id === key.slice(4))
        ?.outputs.map((output) => output.signalId) ?? []
    );
  return key.startsWith('signal:') ? [key.slice(7)] : [];
}
export default function RegionFunctionEditor({
  project,
  source,
  operation: initialOperation,
  inputKey: initialInput,
  regionSetId,
  saved,
  busy,
  onApply,
}: {
  project: Project;
  source: Source;
  operation: Operation;
  inputKey: string;
  regionSetId?: string;
  saved?: FunctionRun;
  busy: boolean;
  onApply: (settings: FunctionSettings) => Promise<void>;
}) {
  const [operation, setOperation] = useState(
    saved?.operation ?? initialOperation,
  );
  const [inputKey, setInputKey] = useState(initialInput);
  const [second, setSecond] = useState(
    saved?.secondaryIds?.length
      ? 'saved-second'
      : `signal:${source.channels[0]}`,
  );
  const [within, setWithin] = useState(saved?.regionSetId ?? regionSetId ?? '');
  const [regionId, setRegionId] = useState(
    saved?.regionIds?.length === 1 ? saved.regionIds[0] : '',
  );
  const [parameter, setParameter] = useState(
    String(
      saved?.parameter ??
        REGION_FUNCTIONS.find((spec) => spec.operation === initialOperation)
          ?.defaultValue ??
        0,
    ),
  );
  const [error, setError] = useState('');
  const spec = REGION_FUNCTIONS.find((item) => item.operation === operation)!;
  const set = project.regionSets?.find((item) => item.id === within);
  const inputs =
    inputKey === 'saved'
      ? (saved?.inputIds ?? [])
      : resolveInput(project, inputKey);
  const choices = inputChoices(project, source);
  if (saved)
    choices.unshift({
      value: 'saved',
      label: 'Saved inputs · ' + saved.inputIds.length + ' signal(s)',
    });
  if (saved?.secondaryIds?.length)
    choices.push({
      value: 'saved-second',
      label:
        'Saved second inputs · ' + saved.secondaryIds.length + ' signal(s)',
    });
  // Saved operations may reference one result rather than its entire family.
  for (const id of [...(saved?.inputIds ?? []), ...(saved?.secondaryIds ?? [])])
    if (!choices.some((choice) => choice.value === `signal:${id}`))
      choices.push({
        value: `signal:${id}`,
        label: project.nodes.find((node) => node.id === id)?.name ?? id,
      });
  const binary = operation === 'power' || operation === 'bsfc';
  async function apply() {
    setError('');
    try {
      await onApply({
        sourceId: source.id,
        operation,
        parameter: spec.parameter ? finite(parameter) : 0,
        inputIds: inputs,
        secondaryIds: binary
          ? second === 'saved-second'
            ? saved?.secondaryIds
            : resolveInput(project, second)
          : undefined,
        regionSetId: within || undefined,
        regionIds: regionId ? [regionId] : undefined,
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Unable to apply function.',
      );
    }
  }
  return (
    <fieldset className="region-form" disabled={busy}>
      <div className="region-form-title">
        <Sigma size={17} />
        <strong>{saved ? 'Function settings' : 'Apply a function'}</strong>
      </div>
      <RegionSelect
        label="Function"
        value={operation}
        items={REGION_FUNCTIONS.map((item) => ({
          value: item.operation,
          label: `${item.category} · ${item.name}`,
        }))}
        onChange={(value) => {
          const next = REGION_FUNCTIONS.find(
            (item) => item.operation === value,
          );
          if (next && next.operation !== 'segment') {
            setOperation(next.operation);
            setParameter(String(next.defaultValue));
          }
        }}
      />
      <p className="region-hint">{spec.description}</p>
      <RegionSelect
        label={
          operation === 'power'
            ? 'Torque input'
            : operation === 'bsfc'
              ? 'Fuel flow input'
              : 'Input signal / result family'
        }
        value={inputKey}
        items={choices}
        onChange={setInputKey}
      />
      {binary && (
        <RegionSelect
          label={operation === 'power' ? 'Speed input' : 'Power input'}
          value={second}
          items={choices}
          onChange={setSecond}
        />
      )}
      <RegionSelect
        label="Processing scope"
        value={within}
        items={[
          { value: '', label: 'Input extent · preserve existing regions' },
          ...(project.regionSets ?? [])
            .filter((item) => item.sourceId === source.id)
            .map((item) => ({
              value: item.id,
              label: `Each ${item.name} v${item.version} region independently`,
            })),
        ]}
        onChange={(value) => {
          setWithin(value);
          setRegionId('');
        }}
      />
      {set && (
        <RegionSelect
          label="Process these regions"
          value={regionId}
          items={[
            { value: '', label: `All ${set.regions.length} regions` },
            ...set.regions.map((region) => ({
              value: region.id,
              label: region.name,
            })),
          ]}
          onChange={setRegionId}
        />
      )}
      {spec.parameter && (
        <RegionNumber
          label={spec.parameter}
          value={parameter}
          unit={spec.unit}
          onChange={setParameter}
        />
      )}
      <div className="region-scope-note">
        <strong>{set ? 'Independent execution' : 'Use input extent'}</strong>
        <span>
          {set
            ? 'Each region has its own filter/window state. Overlaps remain separate results.'
            : 'Original signals use the full recording. Existing region results retain their own boundaries.'}
        </span>
      </div>
      <p className="region-hint">
        {operation === 'min-max'
          ? 'Output: one result-table row per signal and region.'
          : 'Output: a signal or a family of region results.'}{' '}
        Viewing a region does not alter these settings.
      </p>
      {error && (
        <p className="region-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="primary-button"
        type="button"
        disabled={!inputs.length}
        onClick={() => void apply()}
      >
        <Play size={14} />
        {saved ? 'Create new operation' : 'Apply function'}
      </button>
    </fieldset>
  );
}
