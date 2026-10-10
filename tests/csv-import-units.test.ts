import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SignalEngine } from '../lib/signal-engine';
import { openRecording } from '../lib/formats/index';
import { layoutTables } from '../lib/formats/delimited-layout';
import type { DelimitedLayout } from '../lib/formats/delimited-layout';
import type { RecordingFile } from '../lib/formats/recording';
import { arithmeticUnit } from '../lib/signal-arithmetic';
import { bindChannels, recipeUnits } from '../lib/workflow-recipe';
import {
  conversionTargets,
  describeUnit,
  importUnitProblem,
  sameUnit,
  unitConversion,
  unitSuggestions,
} from '../lib/units';

async function all(recording: RecordingFile, table = 0) {
  const time: number[] = [];
  const values: number[][] = recording.tables[table].channels.map(() => []);
  for await (const block of recording.read(table)) {
    time.push(...block.time);
    block.values.forEach((column, c) => values[c].push(...column));
  }
  return { time, values };
}

const near = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

void test('compound and prefixed units are recognised and written one way', () => {
  const cases: [string, string, string | undefined][] = [
    ['Nm', 'N·m', 'Torque'],
    ['N·m/s', 'N·m/s', undefined],
    ['m/s/s', 'm/s²', 'Acceleration'],
    ['kg/m3', 'kg/m³', 'Density'],
    ['W/m²·K', 'W/(m²·K)', undefined],
    ['kg m/s', 'kg·m/s', undefined],
    ['s⁻¹', '1/s', 'Frequency'],
    ['(kg/h)/(kW)', 'kg/(h·kW)', 'Specific fuel consumption'],
    ['uA', 'µA', 'Current'],
    ['μm', 'µm', 'Length'],
    ['kOhm', 'kΩ', 'Resistance'],
    ['GW', 'GW', 'Power'],
    ['%', '%', 'Ratio'],
  ];
  for (const [label, written, quantity] of cases)
    assert.deepEqual(
      describeUnit(label),
      { label: written, ...(quantity ? { quantity } : {}) },
      label,
    );
  for (const label of ['mg/stk', 'C', 'x', 'dB/s', 'm/', '()', 'm^0', 'kg//s'])
    assert.equal(describeUnit(label), undefined, label);
  // Case matters: mW is a milliwatt, MW a megawatt.
  near(unitConversion('MW', 'mW')!.factor, 1e9);
  assert.ok(sameUnit('Nm', 'N·m'));
  assert.ok(sameUnit('m/s^2', 'm/s²'));
  assert.ok(!sameUnit('Nm', 'nm'));
});

void test('units convert when their dimensions match, never across quantities', () => {
  // Torque × rotational speed is a power; torque is not an energy.
  near(unitConversion('(N·m)·(rpm)', 'kW')!.factor, Math.PI / 30 / 1000);
  assert.equal(unitConversion('N·m', 'J'), undefined);
  // Angle is a dimension: rpm is not a frequency.
  assert.equal(unitConversion('rpm', 'Hz'), undefined);
  near(unitConversion('(kg/h)/(kW)', 'g/kWh')!.factor, 1000);
  near(unitConversion('g/s', 'kg/h')!.factor, 3.6);
  near(unitConversion('mbar', 'kPa')!.factor, 0.1);
  near(unitConversion('%', '1')!.factor, 0.01);
  // A temperature inside a compound is a difference.
  assert.deepEqual(unitConversion('°F/s', 'K/s'), { factor: 5 / 9, offset: 0 });
  assert.equal(unitConversion('dB', '1'), undefined);
  assert.deepEqual(unitConversion('dB', 'dB'), { factor: 1, offset: 0 });
  assert.deepEqual(
    conversionTargets('N·m·rad/s').map((item) => item.family),
    ['Power'],
  );
  // Saved conversions between registered units keep their exact factors.
  assert.equal(
    unitConversion('lbf·ft', 'Nm')!.factor,
    4.4482216152605 * 0.3048,
  );
  assert.equal(unitConversion('kg/h', 'g/s')!.factor, 1 / 3600 / 1e-3);
});

void test('unrecognised units must be fixed, chosen as no unit, or kept', () => {
  assert.deepEqual(unitSuggestions('C'), ['°C']);
  assert.deepEqual(unitSuggestions('KPA'), ['kPa']);
  assert.deepEqual(unitSuggestions('-'), ['']);
  assert.deepEqual(unitSuggestions('mg/stk'), []);
  assert.equal(importUnitProblem('Speed', 'rpm'), undefined);
  assert.equal(importUnitProblem('Ratio', ''), undefined);
  assert.match(importUnitProblem('Speed', '—')!, /“Speed” has no unit/);
  assert.match(
    importUnitProblem('Fuel', 'mg/stk')!,
    /does not recognise “mg\/stk”/,
  );
  assert.equal(importUnitProblem('Fuel', 'mg/stk', ['mg/stk']), undefined);
});

void test('add and subtract accept spellings of one unit and name conversions', () => {
  assert.equal(arithmeticUnit('add', 'Nm', 'N·m'), 'Nm');
  assert.throws(
    () => arithmeticUnit('subtract', 'kPa', 'bar'),
    /not kPa and bar\. Convert bar to kPa first/,
  );
  assert.throws(
    () => arithmeticUnit('add', 'kPa', 'rpm'),
    /require matching unit labels/,
  );
  assert.equal(arithmeticUnit('divide', 'Nm', 'N·m'), '1');
});

const MULTI = [
  'Time A [ms],Speed [rpm],Torque,Time B [s],Temp [C],Note',
  '0,1000,10,0,20,ok',
  '100,1100,11,0.5,21,ok',
  '200,1200,12,1,22,ok',
  '300,1300,13,,,',
  '',
].join('\n');

void test('delimited text suggests a time axis per time column and skips text', async () => {
  const recording = await openRecording(new File([MULTI], 'rig.csv'));
  assert.deepEqual(recording.layout, [
    { role: 'time', unit: 'ms' },
    { role: 'signal', time: 0 },
    { role: 'signal', time: 0 },
    { role: 'time', unit: 's' },
    { role: 'signal', time: 3 },
    { role: 'skip' },
  ]);
  assert.deepEqual(
    recording.tables.map((table) => [
      table.name,
      table.channels.map((c) => `${c.name} [${c.unit}]`),
    ]),
    [
      ['Time A', ['Speed [rpm]', 'Torque [—]']],
      ['Time B', ['Temp [C]']],
    ],
  );
  assert.deepEqual(recording.columns?.numeric, [
    true,
    true,
    true,
    true,
    true,
    false,
  ]);
  assert.match(recording.notes!.join(' '), /Column “Note” holds text/);
  // Milliseconds become seconds; the shorter axis ends at its last time.
  const a = await all(recording, 0);
  assert.deepEqual(a.time, [0, 0.1, 0.2, 0.3]);
  assert.deepEqual(a.values, [
    [1000, 1100, 1200, 1300],
    [10, 11, 12, 13],
  ]);
  const b = await all(recording, 1);
  assert.deepEqual(b.time, [0, 0.5, 1]);
  assert.deepEqual(b.values, [[20, 21, 22]]);
});

void test('a chosen layout moves signals between time axes and is validated', async () => {
  const file = new File([MULTI], 'rig.csv');
  const layout: DelimitedLayout = [
    { role: 'time', unit: 'ms' },
    { role: 'signal', time: 0 },
    { role: 'skip' },
    { role: 'time', unit: 'min' },
    { role: 'signal', time: 3 },
    { role: 'skip' },
  ];
  const recording = await openRecording(file, { layout });
  assert.deepEqual(layoutTables(layout), [
    { time: 0, signals: [1] },
    { time: 3, signals: [4] },
  ]);
  assert.deepEqual((await all(recording, 1)).time, [0, 30, 60]);
  await assert.rejects(
    openRecording(file, {
      layout: layout.map((column, c) =>
        c === 3 ? { role: 'time', unit: 'rpm' } : column,
      ),
    }),
    /Time column “Time B” is in rpm, which is not a unit of time/,
  );
  await assert.rejects(
    openRecording(file, { layout: layout.slice(1) }),
    /do not match the file’s columns/,
  );
  // A value without a time on a shorter axis is an error, not a guess.
  const broken = MULTI.replace('300,1300,13,,,', '300,1300,13,,23,');
  const reading = await openRecording(new File([broken], 'rig.csv'), {
    layout,
  });
  await assert.rejects(all(reading, 1), /Row 5, column “Time B \[s\]”/);
});

void test('the import dialog’s units are enforced; files keep their spelling', async (t) => {
  const e = new SignalEngine(undefined, crypto.randomUUID());
  await e.open();
  t.after(() => e.close());
  const file = () => new File([MULTI], 'rig.csv');
  const units = [['rpm', ''], ['°C']];
  await assert.rejects(
    e.importRecording(file(), { units: [['rpm', '—'], ['°C']] }),
    /rig\.csv: “Torque” has no unit/,
  );
  await assert.rejects(
    e.importRecording(file(), { units: [['rpm', ''], ['C']] }),
    /does not recognise “C”, the unit of “Temp”/,
  );
  assert.equal(e.project.sources.length, 0);
  const sources = await e.importRecording(file(), { units });
  assert.deepEqual(
    sources.map((source) => source.name),
    ['rig.csv · Time A', 'rig.csv · Time B'],
  );
  assert.deepEqual(
    sources.map((source) =>
      source.channels.map((id) => {
        const node = e.find(id);
        return `${node.name} [${node.unit}]`;
      }),
    ),
    [['Speed [rpm]', 'Torque []'], ['Temp [°C]']],
  );
  assert.deepEqual([sources[1].start, sources[1].end], [0, 1]);
  // A kept custom unit imports as written.
  const kept = await e.importRecording(file(), {
    units: [['rpm', 'mg/stk'], ['°C']],
    custom: ['mg/stk'],
  });
  assert.equal(e.find(kept[0].channels[1]).unit, 'mg/stk');
  // Without the dialog (batch runs), files import as they state units.
  const plain = await e.importCsv(
    new File(['Time,Torque [Nm],X\n0,1,2\n1,2,3\n'], 'plain.csv'),
  );
  assert.deepEqual(
    plain.channels.map((id) => e.find(id).unit),
    ['Nm', '—'],
  );
});

void test('batch channels without a unit take the unit the workflow expects', () => {
  const recipe = {
    channels: [
      { alias: 'speed', name: 'Speed', unit: 'rpm' },
      { alias: 'torque', name: 'Torque', unit: 'N·m' },
    ],
  };
  const channels = [
    { name: 'Torque', unit: 'Nm' },
    { name: 'Speed', unit: '—' },
  ];
  assert.deepEqual(
    bindChannels(recipe, channels).map((binding) => binding.problem),
    [undefined, undefined],
  );
  assert.deepEqual(recipeUnits(recipe, channels), [undefined, 'rpm']);
  assert.match(
    bindChannels(recipe, [
      { name: 'Torque', unit: 'kN·m' },
      { name: 'Speed', unit: 'rpm' },
    ])[1].problem!,
    /"Torque" is in kN·m, but the workflow expects N·m/,
  );
});
