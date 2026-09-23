import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { niceDomain, niceTicks } from '../lib/mockup-data';

void test('mockup chart axes retain round ticks for ordinary data', () => {
  assert.deepEqual(niceTicks(0, 100, 6), {
    ticks: [0, 20, 40, 60, 80, 100],
    step: 20,
  });
  assert.deepEqual(niceDomain(3, 97, 6), {
    lo: 0,
    hi: 100,
    ticks: [0, 20, 40, 60, 80, 100],
    step: 20,
  });
  const fractional = niceTicks(0, 0.3, 4);
  assert.equal(fractional.ticks.length, 4);
  assert(Math.abs(fractional.ticks[3] - 0.3) < Number.EPSILON);
});

void test('mockup chart ticks terminate for high offsets and narrow spans', () => {
  // Run separately: a synchronous index-increment regression must fail with a
  // timeout rather than hang the entire test runner.
  const moduleUrl = new URL('../lib/mockup-data.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      new URL('./typescript-loader.mjs', import.meta.url).href,
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import { niceDomain, niceTicks } from ${JSON.stringify(moduleUrl)};
       const ranges = [
         [1e16, 1e16 + 2],
         [-1e16, -1e16 + 2],
         [1700000000, 1700000000 + 2 ** -22],
         [Number.MIN_VALUE, Number.MIN_VALUE * 4],
         [Number.MAX_VALUE, Number.MAX_VALUE],
         [-Number.MAX_VALUE, Number.MAX_VALUE],
       ];
       for (const [low, high] of ranges) {
         for (const target of [3, 6, 10]) {
           const domain = niceDomain(low, high, target);
           assert(Number.isFinite(domain.lo) && Number.isFinite(domain.hi));
           assert(domain.lo < domain.hi);
           assert(domain.lo <= low && domain.hi >= high);
           const axis = niceTicks(low, high, target);
           for (const result of [axis, domain]) {
             assert(Number.isFinite(result.step) && result.step > 0);
             assert(result.ticks.length <= 102);
             assert(result.ticks.every(Number.isFinite));
             assert(result.ticks.every((v, i, ticks) => i === 0 || v > ticks[i - 1]));
           }
           assert.equal(domain.ticks[0], domain.lo);
           assert.equal(domain.ticks.at(-1), domain.hi);
         }
       }
       console.log('bounded finite axes');`,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bounded finite axes/);
});
