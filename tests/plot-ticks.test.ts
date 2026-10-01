import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAxisTick, logTicks, niceTicks } from '../lib/plot-ticks';

void test('plot axes label round 1/2/5 steps instead of even divisions', () => {
  // The review example: a 192.96–6,095 rpm scale must not read 1,036.1.
  const speed = niceTicks(192.96, 6095, 6);
  assert.deepEqual(speed.ticks, [1000, 2000, 3000, 4000, 5000, 6000]);
  assert.equal(speed.step, 1000);
  assert.deepEqual(
    speed.ticks.map((value) => formatAxisTick(value, speed.step)),
    ['1,000', '2,000', '3,000', '4,000', '5,000', '6,000'],
  );
  const time = niceTicks(10, 26, 5);
  assert.deepEqual(time.ticks, [10, 15, 20, 25]);
  const fine = niceTicks(0.0012, 0.0031, 5);
  assert(fine.ticks.every((value) => Number.isFinite(value)));
  assert.equal(formatAxisTick(fine.ticks[0], fine.step), '0.0015');
});

void test('large, tiny and logarithmic axes stay readable and bounded', () => {
  assert.match(formatAxisTick(1.7e9 + 0.5, 0.5), /e\+9$/);
  assert.equal(formatAxisTick(0, 0.1), '0');
  assert.equal(formatAxisTick(Number.NaN, 1), '—');
  assert.deepEqual(logTicks(1, 1000).ticks, [1, 10, 100, 1000]);
  assert.deepEqual(logTicks(3, 40).ticks, [5, 10, 20]);
  assert.deepEqual(logTicks(-1, 10).ticks, []);
  assert(logTicks(Number.MIN_VALUE, Number.MAX_VALUE).ticks.length <= 100);
});
