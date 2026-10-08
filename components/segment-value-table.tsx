'use client';

import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { segmentInterval } from '@/lib/file-segments';
import type { WorkflowIndex } from '@/lib/workflow-history';
import type { WorkflowStep } from '@/lib/workflow-types';
import { formatValue } from './signal-chart';

const PAGE = 30;
/** Columns shown at once; wider steps page through their inputs. */
const COLUMNS = 8;

/**
 * Values calculated within segments as a grid: one row per segment, one
 * column per input. Each cell selects its value.
 */
export default function SegmentValueTable({
  index,
  step,
  selectedId,
  onSelect,
}: {
  index: WorkflowIndex;
  step: WorkflowStep;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const [page, setPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const cells = new Map<string, string>();
  const segments: string[] = [];
  const inputs: string[] = [];
  for (const id of step.outputIds) {
    const value = index.values.get(id);
    if (!value?.segmentId) continue;
    if (!segments.includes(value.segmentId)) segments.push(value.segmentId);
    if (!inputs.includes(value.inputId)) inputs.push(value.inputId);
    cells.set(`${value.segmentId}\n${value.inputId}`, id);
  }
  const pages = Math.max(1, Math.ceil(segments.length / PAGE));
  const current = Math.min(page, pages - 1);
  const columnPages = Math.max(1, Math.ceil(inputs.length / COLUMNS));
  const currentColumns = Math.min(columnPage, columnPages - 1);
  const shownInputs = inputs.slice(
    currentColumns * COLUMNS,
    (currentColumns + 1) * COLUMNS,
  );
  const unit = (id: string) => index.values.get(id)?.unit ?? '';
  return (
    <div className="segment-value-table">
      <Table className="workflow-output-table">
        <TableHeader>
          <TableRow>
            <TableHead>Segment</TableHead>
            <TableHead>Time (s)</TableHead>
            {shownInputs.map((input) => {
              const sample = cells.get(`${segments[0]}\n${input}`);
              return (
                <TableHead key={input} title={index.label(input)}>
                  {index.label(input)}
                  {sample && unit(sample) ? ` [${unit(sample)}]` : ''}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {segments
            .slice(current * PAGE, (current + 1) * PAGE)
            .map((segmentId) => {
              const segment = index.segments.get(segmentId)?.segment;
              return (
                <TableRow key={segmentId}>
                  <TableCell>{index.segmentLabel(segmentId)}</TableCell>
                  <TableCell className="workflow-number">
                    {segment ? segmentInterval(segment, 2) : '—'}
                  </TableCell>
                  {shownInputs.map((input) => {
                    const id = cells.get(`${segmentId}\n${input}`);
                    const value = id ? index.values.get(id) : undefined;
                    return (
                      <TableCell
                        key={input}
                        className="workflow-number"
                        data-state={
                          id && id === selectedId ? 'selected' : undefined
                        }
                      >
                        {id && value ? (
                          <button
                            className="workflow-output-name"
                            title={index.label(id)}
                            onClick={() => onSelect(id)}
                          >
                            {value.value === null
                              ? 'Unavailable'
                              : formatValue(value.value, 4)}
                          </button>
                        ) : (
                          <span className="workflow-muted">—</span>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
        </TableBody>
      </Table>
      {(pages > 1 || columnPages > 1) && (
        <nav className="workflow-list-pages" aria-label="Table pages">
          {pages > 1 && (
            <>
              <button
                className="workflow-link"
                disabled={!current}
                onClick={() => setPage(current - 1)}
              >
                Previous segments
              </button>
              <span>
                Segments {current * PAGE + 1}–
                {Math.min(segments.length, (current + 1) * PAGE)} of{' '}
                {segments.length}
              </span>
              <button
                className="workflow-link"
                disabled={current + 1 === pages}
                onClick={() => setPage(current + 1)}
              >
                Next segments
              </button>
            </>
          )}
          {columnPages > 1 && (
            <>
              <button
                className="workflow-link"
                disabled={!currentColumns}
                onClick={() => setColumnPage(currentColumns - 1)}
              >
                Previous inputs
              </button>
              <span>
                Inputs {currentColumns * COLUMNS + 1}–
                {Math.min(inputs.length, (currentColumns + 1) * COLUMNS)} of{' '}
                {inputs.length}
              </span>
              <button
                className="workflow-link"
                disabled={currentColumns + 1 === columnPages}
                onClick={() => setColumnPage(currentColumns + 1)}
              >
                Next inputs
              </button>
            </>
          )}
        </nav>
      )}
    </div>
  );
}
