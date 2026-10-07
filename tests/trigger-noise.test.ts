import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { CrossingDetector, type TriggerEvent } from '../lib/segmentation';
import { valueParameters } from '../lib/workflow-types';
import { parseWorkflow, serializeWorkflow } from '../lib/workflow-recipe';
import { extractWorkflow } from '../lib/workflow-extract';
import { validateWorkspace } from '../lib/workspace-archive';
import type { EdgeTrigger, SegmentationDefinition } from '../lib/signal-types';

type Trigger = Pick<EdgeTrigger, 'edge' | 'threshold'> &
  Partial<Pick<EdgeTrigger, 'hysteresis' | 'debounce'>>;
function events(trigger: Trigger, samples: [number, number][]) {
  const detector = new CrossingDetector(trigger);
  return samples.flatMap(([time, value]) => detector.next(time, value) ?? []);
}
const crossings = (trigger: Trigger, samples: [number, number][]) =>
  events(trigger, samples)
    .filter((event) => event.kind === 'crossing')
    .map((event) => Number(event.time.toFixed(9)));

/** The detector before hysteresis and debounce, kept as a reference. */
function original(trigger: Trigger, samples: [number, number][]) {
  let previous: [number, number] | undefined;
  let valid: boolean | undefined;
  const result: TriggerEvent[] = [];
  for (const [time, value] of samples) {
    if (!Number.isFinite(value)) {
      previous = undefined;
      if (valid !== false) result.push({ time, kind: 'gap' });
      valid = false;
      continue;
    }
    const last = previous;
    previous = [time, value];
    if (valid !== true) {
      valid = true;
      result.push({ time, kind: 'valid' });
      continue;
    }
    const level = trigger.threshold;
    if (
      last &&
      (trigger.edge === 'rising'
        ? last[1] <= level && value > level
        : last[1] >= level && value < level)
    )
      result.push({
        time:
          last[0] + ((time - last[0]) * (level - last[1])) / (value - last[1]),
        kind: 'crossing',
      });
  }
  return result;
}

void test('without hysteresis or debounce, crossings are exactly as before', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const samples: [number, number][] = Array.from({ length: 5000 }, (_, i) => [
    i * 0.01,
    random() < 0.02 ? NaN : Math.round(random() * 8) / 4,
  ]);
  for (const edge of ['rising', 'falling'] as const)
    for (const threshold of [0.5, 1, 1.25])
      assert.deepEqual(
        events({ edge, threshold }, samples),
        original({ edge, threshold }, samples),
      );
});

// Chatter around 1: 0 → 1.1 → 0.9 → 1.1 → 0.9 → 2 → 0.
const CHATTER: [number, number][] = [
  [0, 0],
  [1, 1.1],
  [2, 0.9],
  [3, 1.1],
  [4, 0.9],
  [5, 2],
  [6, 0],
  [7, 2],
];

void test('hysteresis ignores chatter until the signal re-arms', () => {
  assert.deepEqual(
    crossings({ edge: 'rising', threshold: 1 }, CHATTER),
    [0.909090909, 2.5, 4.090909091, 6.5],
  );
  // 0.9 is within 0.5 of the threshold, so only 0 re-arms the detector.
  assert.deepEqual(
    crossings({ edge: 'rising', threshold: 1, hysteresis: 0.5 }, CHATTER),
    [0.909090909, 6.5],
  );
  // Falling mirrors it: re-arm at or above threshold + hysteresis.
  assert.deepEqual(
    crossings({ edge: 'falling', threshold: 1, hysteresis: 0.5 }, CHATTER),
    [5.5],
  );
  assert.throws(
    () =>
      new CrossingDetector({ edge: 'rising', threshold: 1, hysteresis: -1 }),
    /zero or positive/,
  );
});

void test('debounce drops short excursions and reports the crossing time', () => {
  const glitch: [number, number][] = [
    [0, 0],
    [1, 2],
    [1.1, 0],
    [2, 0],
    [3, 2],
    [4, 2],
    [5, 2],
  ];
  assert.deepEqual(
    crossings({ edge: 'rising', threshold: 1 }, glitch),
    [0.5, 2.5],
  );
  // 0.5 s → back below at 1.1 s: shorter than 1 s, so it is dropped.
  const held = events({ edge: 'rising', threshold: 1, debounce: 1 }, glitch);
  assert.deepEqual(
    held.filter((event) => event.kind === 'crossing'),
    [{ time: 2.5, kind: 'crossing' }],
  );
  // A gap before the debounce time elapses cancels the candidate.
  assert.deepEqual(
    crossings({ edge: 'rising', threshold: 1, debounce: 1 }, [
      [0, 0],
      [1, 2],
      [1.5, NaN],
      [2, 2],
      [3, 2],
    ]),
    [],
  );
  // With hysteresis, dips that stay above the re-arm level are tolerated.
  assert.deepEqual(
    crossings(
      { edge: 'rising', threshold: 1, hysteresis: 0.5, debounce: 2 },
      CHATTER,
    ),
    // The second crossing ends the data before its 2 s debounce.
    [0.909090909],
  );
});

const NOISY = [
  't,Speed [rpm],Torque [Nm]',
  ...[0, 0, 1100, 900, 1100, 900, 2000, 2000, 0, 0].map(
    (speed, t) => `${t},${speed},${t}`,
  ),
].join('\n');
async function fixture() {
  const engine = new SignalEngine(undefined, crypto.randomUUID());
  await engine.open();
  await engine.initializeWorkflow();
  const source = await engine.importCsv(new File([NOISY], 'noisy.csv'));
  return {
    engine,
    source,
    speed: source.channels[0],
    torque: source.channels[1],
  };
}
const triggers = (
  speed: string,
  noise: Partial<EdgeTrigger> = {},
): SegmentationDefinition => ({
  method: 'triggers',
  boundary: 'discard',
  minimumDuration: 0,
  start: {
    signalId: speed,
    edge: 'rising',
    threshold: 1000,
    offset: 0,
    ...noise,
  },
  end: {
    signalId: speed,
    edge: 'falling',
    threshold: 1000,
    offset: 0,
    ...noise,
  },
});

void test('segments and crossing values use hysteresis and debounce', async () => {
  const { engine, source, speed, torque } = await fixture();
  try {
    const plain = await engine.previewSegments(source.id, triggers(speed), [
      torque,
    ]);
    assert.equal(plain.ranges.length, 3);
    const steady = await engine.segment(
      source.id,
      triggers(speed, { hysteresis: 200 }),
      [torque],
    );
    const round = (pairs: number[][]) =>
      pairs.map((pair) => pair.map((time) => Number(time.toFixed(6))));
    // 0 → 1100 rpm crosses 1000 at 1 + 1000/1100 s; the 900 rpm dips do not
    // re-arm, so one segment runs to the final fall at 7.5 s.
    assert.deepEqual(
      round(steady.map((segment) => [segment.start, segment.end])),
      [[1.909091, 7.5]],
    );
    const held = await engine.previewSegments(
      source.id,
      triggers(speed, { debounce: 1.5 }),
      [torque],
    );
    // Only the rise to 2000 rpm and the final fall last 1.5 s.
    assert.deepEqual(
      round(held.ranges.map((range) => [range.start, range.end])),
      [[5.090909, 7.5]],
    );
    await assert.rejects(
      engine.previewSegments(source.id, triggers(speed, { hysteresis: -1 }), [
        torque,
      ]),
      /zero or positive/,
    );
    const [count] = await engine.calculateValues([speed], 'crossing-count', {
      threshold: 1000,
      hysteresis: 200,
    });
    assert.equal(count.value, 1);
    assert.deepEqual(count.parameters, {
      threshold: 1000,
      edge: 1,
      hysteresis: 200,
    });
    const [chatter] = await engine.calculateValues([speed], 'crossing-count', {
      threshold: 1000,
      hysteresis: 0,
      debounce: 0,
    });
    assert.equal(chatter.value, 3);
    assert.deepEqual(chatter.parameters, { threshold: 1000, edge: 1 });
    assert.throws(
      () => valueParameters('crossing-count', { threshold: 1, debounce: -1 }),
      /Debounce must be zero or positive/,
    );
    const archive = structuredClone(engine.project);
    const operation = archive.segmentationOperations!.at(-1)!;
    if (operation.definition?.method === 'triggers')
      operation.definition.start.hysteresis = -5;
    assert.throws(() => validateWorkspace(archive), /triggers/);
  } finally {
    engine.close();
  }
});

void test('workflow files save and read trigger and value noise settings', async () => {
  const { engine, source, speed, torque } = await fixture();
  try {
    await engine.segment(
      source.id,
      triggers(speed, { hysteresis: 200, debounce: 0.5 }),
      [torque],
    );
    await engine.calculateValues([speed], 'first-crossing', {
      threshold: 1000,
      debounce: 1.5,
    });
    const recipe = extractWorkflow(engine.project, source.id, {
      name: 'Noise',
      itemLabel: 'Run',
    }).recipe;
    const text = serializeWorkflow(recipe);
    assert.match(text, /hysteresis: 200/);
    assert.match(text, /debounce: 0.5/);
    assert.match(text, /debounce: 1.5/);
    assert.deepEqual(parseWorkflow(text), recipe);
    assert.throws(
      () => parseWorkflow(text.replace('hysteresis: 200', 'hysteresis: -2')),
      /cannot be negative/,
    );
    assert.throws(
      () =>
        parseWorkflow(
          text.replace('debounce: 1.5', 'debounce: { value: crossing-count }'),
        ),
      /must be a finite number/,
    );
  } finally {
    engine.close();
  }
});
