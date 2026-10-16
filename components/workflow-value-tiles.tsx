'use client';
import { seriesColor } from '@/lib/plot-scratchpad';
import type { WorkflowIndex } from '@/lib/workflow-history';
import { valueSpec, valueTitle, type ScalarValue } from '@/lib/workflow-types';
import type { WorkflowSelection } from './workflow-history';
import { formatValue } from './signal-chart';

const number = (value: number) => formatValue(value, 3);

/**
 * Above Active: the viewed value with how it was found, or a tile for each
 * value of a viewed Value step.
 */
export default function WorkflowValueTiles({
  activeValue,
  tileValues,
  traceColor,
  index,
  select,
}: {
  activeValue?: ScalarValue;
  tileValues: ScalarValue[];
  /** Plot colours by trace ID, so a tile matches its value's line. */
  traceColor: ReadonlyMap<string, string>;
  index: WorkflowIndex;
  select: (next: WorkflowSelection) => void;
}) {
  return activeValue ? (
    <section className="workflow-value-card" aria-label="Calculated value">
      <div>
        <span>
          {valueTitle(
            activeValue.operation,
            activeValue.parameters,
            index.nodes.get(activeValue.inputId)?.unit,
            activeValue.expression,
          )}
        </span>
        <strong>
          {activeValue.value === null
            ? 'Unavailable'
            : number(activeValue.value)}{' '}
          <small>{activeValue.unit}</small>
        </strong>
      </div>
      <p>
        {activeValue.operation === 'calculate'
          ? `${activeValue.value === null ? 'Unavailable: a value it uses is unavailable, or the result is not a finite number. ' : ''}${Object.entries(
              activeValue.bindings ?? {},
            )
              .map(
                ([name, bound]) =>
                  `${name} = ${
                    activeValue.parameters?.[name] === undefined
                      ? 'unavailable'
                      : `${number(activeValue.parameters[name])} ${index.values.get(bound.valueId)?.unit ?? ''}`.trim()
                  } (${index.label(bound.valueId)})`,
              )
              .join(' · ')}`
          : activeValue.value === null
            ? activeValue.operation === 'time-average'
              ? 'No finite result. Time averages require adjacent finite samples with positive elapsed time.'
              : 'No finite result for this input and these settings.'
            : `${activeValue.sampleCount.toLocaleString()} finite samples · ${number(activeValue.validDuration)} s of valid intervals${activeValue.timestamp !== undefined ? ` · at ${number(activeValue.timestamp)} s` : ''}`}
      </p>
      <p>{valueSpec(activeValue.operation)?.description}</p>
    </section>
  ) : tileValues.length ? (
    <div className="workflow-value-tiles" aria-label="Calculated values">
      {tileValues.map((value) => (
        <button
          key={value.id}
          className="workflow-value-tile"
          onClick={() => select({ kind: 'output', id: value.id })}
          title={`Open ${index.label(value.id)}`}
        >
          <span>
            <i
              style={{
                background: seriesColor(traceColor.get(value.id) ?? ''),
              }}
            />
            {index.label(value.id)}
          </span>
          <strong>
            {value.value === null ? 'Unavailable' : number(value.value)}{' '}
            <small>{value.unit}</small>
          </strong>
          <em>
            {valueTitle(
              value.operation,
              value.parameters,
              index.nodes.get(value.inputId)?.unit,
              value.expression,
            )}
            {value.operation === 'calculate'
              ? ''
              : value.timestamp !== undefined
                ? ` · at ${number(value.timestamp)} s`
                : ` · ${value.sampleCount.toLocaleString()} samples`}
          </em>
        </button>
      ))}
    </div>
  ) : null;
}
