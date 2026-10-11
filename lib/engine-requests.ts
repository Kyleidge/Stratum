import type { SignalEngine } from './signal-engine';
import type { EngineRequest, EngineResponse } from './signal-types';
import { measurePlot } from './plot-measurement';
import type { ByteSink } from './workspace-archive';

/** Every request but `cancel`, which only the worker's queue handles. */
export type EngineCommand = Exclude<EngineRequest, { type: 'cancel' }>;

/**
 * Writes to a transferred native file stream. Each write waits for the
 * renderer to take the previous chunk, so memory stays bounded; a failure
 * aborts the stream so the renderer discards the partial file.
 */
async function toStream(
  stream: WritableStream<Uint8Array>,
  write: (sink: ByteSink) => Promise<number>,
) {
  const writer = stream.getWriter();
  try {
    const bytes = await write(async (chunk) => {
      await writer.ready;
      await writer.write(chunk);
    });
    await writer.close();
    return bytes;
  } catch (error) {
    await writer.abort(error).catch(() => {});
    throw error;
  }
}

/**
 * Runs one engine request and sends its reply: the worker protocol, shared by
 * the signal worker and the MCP server (`mcp/`) so both behave identically.
 * Every request type must be handled here (the `never` check enforces it).
 * Failures throw for the caller to report.
 */
export async function handleEngineRequest(
  engine: SignalEngine,
  r: EngineCommand,
  requestId: number,
  send: (message: EngineResponse) => void,
): Promise<void> {
  switch (r.type) {
    case 'time-operation':
      await engine.applyTimeOperation(r.settings);
      break;
    case 'backup-workspace':
      if (r.stream) {
        const stream = r.stream;
        send({
          type: 'written',
          requestId,
          revision: engine.savedRevision,
          bytes: await toStream(stream, (sink) => engine.writeBackup(sink)),
        });
      } else
        send({
          type: 'export',
          requestId,
          blob: await engine.backupWorkspace(),
        });
      return;
    case 'restore-workspace':
      await engine.restoreWorkspace(r.file);
      break;
    case 'delete-operation':
      await engine.deleteOperation(r.stepId);
      break;
    case 'edit-operation':
      await engine.editOperation(r.stepId, r.command);
      break;
    case 'rename':
      await engine.rename(r.id, r.name);
      break;
    case 'create-named':
      await engine.createNamed(r.command, r.name);
      break;
    case 'run-workflow':
      await engine.runWorkflow(r);
      break;
    case 'finish-batch':
      await engine.finishBatch(r.batchId, r.state, r.failures);
      break;
    case 'set-checks':
      await engine.setChecks(r.stepId, r.checks);
      break;
    case 'undo':
    case 'redo':
      await engine.travel(r.type);
      break;
    case 'demo-workflow':
      await engine.workflowExample(r.refresh, r.sourceId);
      break;
    case 'init-workflow':
      await engine.open();
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await engine.recoverImports();
        await engine.pruneDerivedIndexes().catch(() => {});
      }
      await engine.initializeWorkflow();
      if (r.refreshExample) await engine.workflowExample(true);
      break;
    case 'calculate-values':
      await engine.calculateValues(
        r.inputIds,
        r.operation,
        r.parameters,
        r.bindings,
        r.within,
        r.expression,
        r.unit,
      );
      break;
    case 'segment-set':
      await engine.segmentSet(
        r.sourceId,
        r.definition,
        r.referenceId,
        r.within,
      );
      break;
    case 'segment-set-preview':
      send({
        type: 'segment-plan',
        requestId,
        plan: await engine.previewSegmentSet(
          r.sourceId,
          r.definition,
          r.referenceId,
          r.within,
        ),
      });
      return;
    case 'init-regions':
      await engine.open();
      await engine.initializeRegions();
      if (!(engine.project.regionExamples ?? []).length)
        await engine.regionExample('ramps');
      break;
    case 'region-example':
      await engine.regionExample(r.key);
      break;
    case 'region-create':
      await engine.createRegions(r.settings);
      break;
    case 'region-function':
      await engine.applyRegionFunction(r.settings);
      break;
    case 'region-preview':
      send({
        type: 'region-plan',
        requestId,
        plan: await engine.previewRegions(r.settings),
      });
      return;
    case 'init':
      await engine.open();
      if (!engine.project.sources.length) await engine.demo();
      break;
    case 'demo':
      await engine.demo();
      break;
    case 'example':
      await engine.example(r.key);
      break;
    case 'import':
      await engine.importRecording(r.file, {
        tables: r.tables,
        layout: r.layout,
        units: r.units,
        custom: r.custom,
        names: r.names,
        tableNames: r.tableNames,
      });
      break;
    case 'derive':
      await engine.derive(r.parentId, r.operation, r.parameter);
      break;
    case 'derive-many':
      await engine.deriveMany(
        r.parentIds,
        r.operation,
        r.parameter,
        true,
        r.bindings,
        {
          ...(r.unit !== undefined ? { unit: r.unit } : {}),
          ...(r.formula ? { formula: r.formula } : {}),
          ...(r.within ? { within: r.within } : {}),
        },
      );
      break;
    case 'segment':
      await engine.segment(
        r.sourceId,
        r.definition,
        r.targetIds,
        r.independently,
        r.scope,
      );
      break;
    case 'segment-preview':
      send({
        type: 'segment-plan',
        requestId,
        plan: await engine.previewSegments(
          r.sourceId,
          r.definition,
          r.targetIds,
          r.independently,
          r.scope,
        ),
      });
      return;
    case 'derive-preview':
      send({
        type: 'derive-preview',
        requestId,
        preview: await engine.previewDerived(r),
      });
      return;
    case 'value-preview':
      send({
        type: 'value-preview',
        requestId,
        statistics: await engine.previewValues(
          r.ids,
          r.operation,
          r.parameters,
          r.bindings,
          r.within,
        ),
      });
      return;
    case 'segment-metrics':
      await engine.calculateSegmentMetrics(r.ids);
      break;
    case 'view': {
      const plots = [];
      if (r.windows)
        for (const window of r.windows.slice(0, 100))
          plots.push(await engine.plot(r.ids[0], window));
      else
        for (const id of r.ids)
          plots.push(
            await engine.plot(id, r.ranges?.[id] ?? r.range, !!r.ranges?.[id]),
          );
      send({ type: 'plots', requestId, plots });
      return;
    }
    case 'measure-plot': {
      if (r.items.length > 30)
        throw new Error('Measure up to 30 traces per page.');
      const measurements = [];
      for (const item of r.items)
        measurements.push(
          await measurePlot(
            item.id,
            engine.evaluate(item.id, undefined, [
              Math.min(item.a, item.b),
              Math.max(item.a, item.b),
            ]),
            item.a,
            item.b,
            () => {
              if (engine.cancelled) throw new Error('Measurement cancelled.');
            },
          ),
        );
      send({ type: 'plot-measurements', requestId, measurements });
      return;
    }
    case 'sample-count':
      send({
        type: 'sample-count',
        requestId,
        count: r.id === null ? null : await engine.sampleCount(r.id),
      });
      return;
    case 'rows':
      send({
        type: 'rows',
        requestId,
        ...(await engine.rows(r.id, r.offset)),
      });
      return;
    case 'export':
      send({
        type: 'export',
        requestId,
        blob: await engine.exportSummary(r.ids),
      });
      return;
    case 'export-samples':
      if (r.stream) {
        const stream = r.stream;
        send({
          type: 'written',
          requestId,
          revision: engine.savedRevision,
          bytes: await toStream(stream, (sink) =>
            engine.writeSamples(r.ids, sink),
          ),
        });
      } else
        send({
          type: 'export',
          requestId,
          blob: await engine.exportSamples(r.ids),
        });
      return;
    default: {
      const unknown: never = r;
      throw new Error(
        `Unknown engine request: ${JSON.stringify((unknown as { type?: unknown }).type)}`,
      );
    }
  }
  send({
    type: 'project',
    requestId,
    project: engine.project,
    revision: engine.savedRevision,
    canUndo: engine.canUndo,
    canRedo: engine.canRedo,
    undoLabel: engine.undoLabel,
    redoLabel: engine.redoLabel,
  });
}
