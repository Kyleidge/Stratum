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
  const product = await engine.applyRegionFunction({
    sourceId: source.id,
    operation: 'multiply',
    parameter: 0,
    inputIds: [smooth.id],
    secondaryIds: [source.channels[0]],
  });
  const productId = product.outputs[0].signalId;
  await engine.rename(productId, 'Torque × speed');
  await nameStep('Multiply torque and speed');
  // Segments are time intervals of the whole recording, found by a signal.
  const speed = source.channels[0];
  const runs = await engine.segmentSet(source.id, {
    method: 'triggers',
    boundary: 'clip',
    minimumDuration: 5,
    start: { signalId: speed, edge: 'rising', threshold: 800, offset: 0 },
    end: { signalId: speed, edge: 'falling', threshold: 800, offset: 0 },
  });
  for (const [i, segment] of runs.segments.entries())
    await engine.rename(segment.id, `Run ${i + 1}`);
  await nameStep('Find the three runs');
  const averages = await engine.calculateValues(
    [productId],
    'time-average',
    undefined,
    undefined,
    { setId: runs.id },
  );
  for (const [i, value] of averages.entries())
    await engine.rename(value.id, `Run ${i + 1} · Average product`);
  await nameStep('Average product per run');
  const halves = await engine.segmentSet(
    source.id,
    {
      method: 'windows',
      boundary: 'clip',
      start: 0,
      end: 40,
      duration: 20,
      step: 20,
      includePartial: false,
    },
    undefined,
    { setId: runs.id, segmentIds: [runs.segments[1].id] },
  );
  const labels = ['First half', 'Second half'];
  for (const [i, segment] of halves.segments.entries())
    await engine.rename(segment.id, `Run 2 · ${labels[i]}`);
  await nameStep('Split Run 2 into two halves');
  const peaks = await engine.calculateValues(
    [productId],
    'maximum',
    undefined,
    undefined,
    { setId: halves.id },
  );
  for (const [i, value] of peaks.entries())
    await engine.rename(value.id, `Run 2 · ${labels[i]} · Peak product`);
  await nameStep('Peak product in each Run 2 half');
}
