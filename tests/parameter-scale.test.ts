import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration,
  parameterContext,
  parameterHint,
  parameterScale,
  sliderPosition,
  sliderValue,
} from '../lib/parameter-scale';

const context = parameterContext({
  count: 1801,
  min: 600,
  max: 5688,
  mean: 2395,
  integral: 0,
  start: 0,
  end: 180,
});

void test('parameter context reads the sample interval from a summary', () => {
  assert.equal(context.interval, 0.1);
  assert.deepEqual(parameterContext(undefined), {});
  assert.deepEqual(
    parameterContext({
      count: 0,
      min: NaN,
      max: NaN,
      mean: NaN,
      integral: 0,
      start: NaN,
      end: NaN,
    }),
    {},
  );
});

void test('sliders round-trip readable values on linear and log scales', () => {
  const window = parameterScale('smooth', context)!;
  assert.equal(window.integer, true);
  assert.equal(window.min, 1);
  assert.equal(window.max, 360);
  for (const value of [1, 7, 25, 360])
    assert.equal(sliderValue(sliderPosition(value, window), window), value);
  // Window presets are durations converted to whole samples.
  assert.deepEqual(
    window.presets.map((preset) => preset.value),
    [10, 100],
  );
  const cutoff = parameterScale('low-pass', context)!;
  assert.equal(cutoff.max, 5, 'Cutoff stops at Nyquist.');
  assert.equal(sliderValue(1, cutoff), 5);
  assert.equal(sliderValue(0, cutoff), cutoff.min);
  assert.ok(cutoff.presets.every((preset) => preset.value <= 5));
  const offset = parameterScale('offset', context)!;
  assert.deepEqual([offset.min, offset.max], [-10000, 10000]);
  assert.equal(sliderValue(0.5, offset), 0);
  assert.equal(sliderValue(sliderPosition(1234, offset), offset), 1240);
  assert.deepEqual(
    offset.presets.map((preset) => preset.label),
    ['Remove mean', 'Minimum to 0', 'Maximum to 0'],
  );
  assert.equal(offset.presets[0].value, -2395);
  // Out-of-range and invalid values clamp rather than throwing.
  assert.equal(sliderPosition(-5, window), 0);
  assert.equal(sliderPosition(Number.NaN, window), 0);
  assert.equal(sliderPosition(1e9, window), 1);
  assert.equal(parameterScale('absolute', context), undefined);
});

void test('hints describe parameters in time and output units', () => {
  assert.equal(
    parameterHint('smooth', 25, context),
    'Window ≈ 2.5 s at 10 Hz.',
  );
  assert.match(parameterHint('low-pass', 5, context)!, /barely filters/);
  assert.match(parameterHint('exponential', 0.5, context)!, /144 ms/);
  assert.equal(
    parameterHint('scale', 2, context, 'rpm'),
    'Output 1,200 to 11,376 rpm.',
  );
  assert.equal(
    parameterHint('time-shift', -5, context),
    'New time range -5 to 175 s.',
  );
  assert.match(parameterHint('resample', 1, context)!, /≈ 181 samples/);
  assert.match(parameterHint('resample', 1, context)!, /aliasing/);
  assert.equal(parameterHint('smooth', 25, {}), undefined);
  assert.equal(formatDuration(150), '2.5 min');
  assert.equal(formatDuration(0.0025), '2.5 ms');
});
