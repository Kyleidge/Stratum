import type { SignalEngine } from './signal-engine';
import type { Source } from './signal-types';

export const WORKFLOW_EXAMPLE = 'motor-test-v1';

/** Deterministic illustrative data: three 40-second motor speed sweeps. */
export function workflowExampleFile() {
  const lines = ['Time [s],Motor speed [rpm],Torque [Nm]'];
  for (let i = 0; i <= 1800; i++) {
    const time = i / 10;
    const run = Math.floor((time - 10) / 55);
    const local = time - 10 - run * 55;
    const active = run >= 0 && run < 3 && local < 40;
    const speed = active ? 900 + 120 * local : 600;
    const torque = active
      ? 70 +
        20 * Math.sin((Math.PI * local) / 40) +
        run * 3 +
        3 * Math.sin(time * 19)
      : 3 + 0.3 * Math.sin(time * 7);
    lines.push([time, speed, torque].map((v) => v.toFixed(5)).join(','));
  }
  return new File([lines.join('\n')], 'Motor test · three runs.csv', {
    type: 'text/csv',
  });
}

/** Uses the same commands as the UI; the caller publishes the batch atomically. */
export async function buildExampleWorkflow(
  engine: SignalEngine,
  source: Source,
) {
  const nameStep = (name: string) =>
    engine.rename(engine.project.workflowSteps!.at(-1)!.id, name);
  await nameStep('Record motor speed and torque');
  const smooth = await engine.derive(source.channels[1], 'smooth', 5);
  await engine.rename(smooth.id, 'Smoothed torque');
  await nameStep('Smooth measured torque');
  const power = await engine.applyRegionFunction({
    sourceId: source.id,
    operation: 'power',
    parameter: 0,
    inputIds: [smooth.id],
    secondaryIds: [source.channels[0]],
  });
  const powerId = power.outputs[0].signalId;
  await engine.rename(powerId, 'Brake power');
  await nameStep('Calculate power from torque and speed');
  const runs = await engine.segment(
    source.id,
    {
      method: 'ranges',
      boundary: 'clip',
      ranges: [
        [10, 50],
        [65, 105],
        [120, 160],
      ],
    },
    [powerId],
    false,
    'signals',
  );
  const runIds = runs.map((run) => run.nodes[0]);
  for (const [i, id] of runIds.entries())
    await engine.rename(id, `Run ${i + 1} · Power`);
  await nameStep('Split power into three runs');
  await engine.calculateValues(runIds, 'time-average');
  for (const [i, value] of engine.project.values!.slice(-3).entries())
    await engine.rename(value.id, `Run ${i + 1} · Average power`);
  await nameStep('Compare average power by run');
  const windows = await engine.segment(
    source.id,
    {
      method: 'windows',
      boundary: 'clip',
      start: 65,
      end: 105,
      duration: 20,
      step: 20,
      includePartial: false,
    },
    [runIds[1]],
    false,
    'signals',
  );
  const windowIds = windows.map((window) => window.nodes[0]);
  const labels = ['First half', 'Second half'];
  for (const [i, id] of windowIds.entries())
    await engine.rename(id, `Run 2 · ${labels[i]} · Power`);
  await nameStep('Split Run 2 into two windows');
  await engine.calculateValues(windowIds, 'maximum');
  for (const [i, value] of engine.project.values!.slice(-2).entries())
    await engine.rename(value.id, `Run 2 · ${labels[i]} · Peak power`);
  await nameStep('Compare peak power within Run 2');
}
