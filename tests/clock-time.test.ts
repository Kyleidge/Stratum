// Fixed zone first: local-time readings and offsets depend on it.
process.env.TZ = 'Europe/London';

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {
  ClockTextReader,
  clockTicks,
  detectDateOrder,
  formatClockTime,
  isoClockTime,
  localOffset,
  parseClockText,
} from '../lib/clock-time';
import { suggestLayout } from '../lib/formats/delimited-layout';
import { headerChannel } from '../lib/formats/recording';
import { SignalEngine } from '../lib/signal-engine';
import { SignalGraph } from '../lib/signal-graph';
import { validateWorkspace } from '../lib/workspace-archive';
import { parseWorkflow, serializeWorkflow } from '../lib/workflow-recipe';
import { referenceClock } from '../lib/time-types';
import type { TimeSettings } from '../lib/time-types';

const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 864e5;
const unix = (...parts: number[]) =>
  Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0) /
    1000 +
  (parts[5] ?? 0);

void test('dates and times of day read from common spellings', () => {
  assert.deepEqual(parseClockText('2026-10-10T14:03:22.120+01:00'), {
    day: day(2026, 10, 10),
    seconds: 14 * 3600 + 3 * 60 + 22.12,
    zone: 60,
    dated: true,
  });
  assert.equal(parseClockText('2026-10-10 14:03:22Z')?.zone, 0);
  assert.equal(parseClockText('2026/10/10 14:03 UTC')?.zone, 0);
  assert.equal(parseClockText('2026-10-10T14:03:22-0530')?.zone, -330);
  assert.equal(
    parseClockText('10.11.2026 14:03', 'mdy')?.day,
    day(2026, 11, 10),
  );
  assert.equal(parseClockText('10/11/2026', 'dmy')?.day, day(2026, 11, 10));
  const us = parseClockText('10/11/2026 2:03:22 PM', 'mdy');
  assert.equal(us?.day, day(2026, 10, 11));
  assert.equal(us?.seconds, 14 * 3600 + 3 * 60 + 22);
  assert.equal(parseClockText('12:00:00 AM')?.seconds, 0);
  assert.deepEqual(parseClockText('14:03:22.5'), {
    day: 0,
    seconds: 14 * 3600 + 3 * 60 + 22.5,
    dated: false,
  });
  for (const bad of [
    '31/04/2026',
    '2026-13-01',
    '25:00',
    '10:61',
    '13:00 PM',
    '10/10/26',
    '0.5',
    '2026-10-10 14:03 +25:00',
  ])
    assert.equal(parseClockText(bad), undefined, bad);
});

void test('the day/month order comes from the dates that settle it', () => {
  assert.deepEqual(detectDateOrder(['13/01/2026', '14/01/2026']), {
    order: 'dmy',
    ambiguous: false,
  });
  assert.deepEqual(detectDateOrder(['01/13/2026']), {
    order: 'mdy',
    ambiguous: false,
  });
  assert.deepEqual(detectDateOrder(['01/02/2026'], 'mdy'), {
    order: 'mdy',
    ambiguous: true,
  });
  assert.equal(detectDateOrder(['2026-01-02']).ambiguous, false);
});

void test('a clock column keeps one offset, honours stated zones and passes midnight', () => {
  // British Summer Time starts at 01:00 UTC on 29 March 2026; the offset of
  // the first cell is kept, so time never jumps within a recording.
  const local = new ClockTextReader('dmy', 'local');
  assert.equal(local.read('2026-03-29 00:30:00'), 0);
  assert.equal(local.read('2026-03-29 01:30:00.25'), 3600.25);
  assert.deepEqual(local.clock, { start: unix(2026, 3, 29, 0, 30), offset: 0 });
  const october = new ClockTextReader('dmy', 'local');
  october.read('10/10/2026 14:00');
  assert.deepEqual(october.clock, {
    start: unix(2026, 10, 10, 13),
    offset: 60,
  });
  assert.equal(localOffset(unix(2026, 10, 10, 14)), 60);
  const zoned = new ClockTextReader('dmy', 0);
  assert.equal(zoned.read('2026-10-10T12:00:00Z'), 0);
  assert.equal(zoned.read('2026-10-10T14:00:01+02:00'), 1);
  assert.equal(zoned.read('2026-10-10 12:00:02'), 2);
  assert.ok(Number.isNaN(zoned.read('12:00:03')), 'dated then undated');
  const undated = new ClockTextReader('dmy', 'local');
  assert.equal(undated.read('23:59:59.5'), 0);
  assert.equal(undated.read('00:00:01'), 1.5);
  assert.equal(undated.read('00:00:02'), 2.5);
  assert.deepEqual(undated.clock, {
    start: 86399.5,
    offset: 0,
    undated: true,
  });
});

void test('clock times format in the file’s zone and tick at round times', () => {
  const clock = { start: unix(2026, 10, 10, 13, 3, 22.12), offset: 60 };
  assert.equal(formatClockTime(clock, 0), '2026-10-10 14:03:22.120');
  assert.equal(formatClockTime(clock, 0.8851), '2026-10-10 14:03:23.005');
  assert.equal(isoClockTime(clock, 1), '2026-10-10T14:03:23.120000+01:00');
  assert.equal(
    isoClockTime({ start: 0, offset: -330 }, 0, 0),
    '1969-12-31T18:30:00-05:30',
  );
  assert.equal(
    formatClockTime({ start: 3600, offset: 0, undated: true }, 1.5),
    '01:00:01.500',
  );
  const minutes = clockTicks(clock, 0, 600);
  assert.ok(minutes.ticks.length >= 3 && minutes.ticks.length <= 6);
  for (const [i, time] of minutes.ticks.entries()) {
    const wall = clock.start + clock.offset * 60 + time;
    assert.ok(Math.abs(wall - Math.round(wall / 120) * 120) < 1e-6);
    assert.match(minutes.labels[i], /^14:\d\d$/);
  }
  assert.equal(minutes.title, 'Clock time (UTC+01:00) · 2026-10-10');
  const night = clockTicks(
    { start: unix(2026, 10, 10, 22), offset: 60 },
    0,
    3 * 3600,
  );
  assert.ok(night.labels.includes('11 Oct'), night.labels.join());
  const fine = clockTicks(clock, 0.88, 0.95);
  assert.match(fine.labels[0], /^14:03:23\.0\d$/);
  assert.match(fine.labels[1], /^23\.0\d$/);
  assert.equal(
    clockTicks({ start: 0, offset: 0, undated: true }, 0, 60).title,
    'Time of day',
  );
});

void test('import suggestions recognise date, Unix and elapsed time columns', () => {
  const number = (cell: string) => (cell.trim() ? Number(cell) : NaN);
  const layout = (header: string, cells: string[]) =>
    suggestLayout(
      [headerChannel(header), headerChannel('Speed [rpm]')],
      cells.map((cell) => [cell, '1']),
      number,
    )[0];
  assert.deepEqual(
    layout('Timestamp', ['13/10/2026 14:00', '13/10/2026 14:01']),
    {
      role: 'time',
      unit: '',
      clock: { kind: 'text', order: 'dmy', zone: 'local' },
    },
  );
  assert.deepEqual(layout('Time [UTC]', ['2026-10-10 14:00']), {
    role: 'time',
    unit: '',
    clock: { kind: 'text', order: 'dmy', zone: 0 },
  });
  assert.deepEqual(layout('Time', ['1791370800123', '1791370800223']), {
    role: 'time',
    unit: 'ms',
    clock: { kind: 'unix', zone: 'local' },
  });
  assert.deepEqual(layout('Epoch [s]', ['12', '13']), {
    role: 'time',
    unit: 's',
    clock: { kind: 'unix', zone: 'local' },
  });
  assert.deepEqual(layout('Time [s]', ['0', '0.1']), {
    role: 'time',
    unit: 's',
  });
  // A later clock-time column named like time starts another time axis.
  const two = suggestLayout(
    ['Time [s]', 'Speed [rpm]', 'GPS time', 'Lat [°]'].map(headerChannel),
    [['0', '1', '14:00:00', '51.5']],
    number,
  );
  assert.deepEqual(two[2], {
    role: 'time',
    unit: '',
    clock: { kind: 'text', order: 'dmy', zone: 'local' },
  });
  assert.deepEqual(two[3], { role: 'signal', time: 2 });
});

async function engine(t: TestContext) {
  const e = new SignalEngine(undefined, crypto.randomUUID());
  await e.open();
  t.after(() => e.close());
  await e.initializeWorkflow();
  return e;
}
async function samples(e: SignalEngine, id: string) {
  const rows: number[][] = [];
  for await (const chunk of e.evaluate(id))
    for (let i = 0; i < chunk.time.length; i++)
      rows.push([chunk.time[i], chunk.values[i]]);
  return rows;
}
const byClock = (groups: string[][]): TimeSettings => ({
  kind: 'align',
  reference: { id: 'shared-clock', name: 'Clock', kind: 'absolute' },
  target: 0,
  groups: groups.map((inputIds) => ({ inputIds, anchor: { kind: 'clock' } })),
});

void test('imported clock times stay relative, line recordings up and export', async (t) => {
  const e = await engine(t);
  const a = await e.importCsv(
    new File(
      [
        'Timestamp,Speed [rpm]\n2026-10-10 14:00:00.000,1\n2026-10-10 14:00:00.500,2\n2026-10-10 14:00:01.000,3\n2026-10-10 14:00:01.500,4',
      ],
      'A.csv',
    ),
  );
  const b = await e.importCsv(
    new File(
      [
        'Unix time [ms],Torque [Nm]\n1791637200250,10\n1791637200750,20\n1791637201250,30',
      ],
      'B.csv',
    ),
  );
  assert.deepEqual(a.clock, { start: unix(2026, 10, 10, 13), offset: 60 });
  assert.deepEqual(b.clock, { start: 1791637200.25, offset: 60 });
  assert.equal(a.start, 0);
  assert.deepEqual(
    (await samples(e, a.channels[0])).map(([time]) => time),
    [0, 0.5, 1, 1.5],
  );
  const graph = new SignalGraph(e.project);
  assert.equal(graph.timeReferences.get(a.channels[0])?.kind, 'absolute');

  const [x, y] = await e.applyTimeOperation(
    byClock([[a.channels[0]], [b.channels[0]]]),
  );
  assert.deepEqual(
    (await samples(e, y.id)).map(([time]) => time),
    [0.25, 0.75, 1.25],
  );
  assert.deepEqual(
    (await samples(e, x.id)).map(([time]) => time),
    [0, 0.5, 1, 1.5],
  );
  const aligned = new SignalGraph(e.project);
  assert.deepEqual(referenceClock(aligned.timeReferences.get(y.id)), {
    start: unix(2026, 10, 10, 13),
    offset: 60,
  });
  // Now on one time reference, they resample onto a shared grid.
  const shared = await e.applyTimeOperation({
    kind: 'resample',
    inputIds: [x.id, y.id],
    grid: { kind: 'uniform', start: 0.25, end: 1.25, rate: 2 },
    interpolation: 'linear',
    maxGap: 1,
  });
  assert.equal(shared.length, 2);

  // A zeroed signal's clock starts where the signal starts.
  const zeroed = await e.derive(y.id, 'zero-time', 0);
  assert.equal(
    referenceClock(new SignalGraph(e.project).timeReferences.get(zeroed.id))
      ?.start,
    unix(2026, 10, 10, 13) + 0.25,
  );

  const lines = (await (await e.exportSamples([a.channels[0]])).text())
    .trim()
    .split('\r\n');
  assert.ok(lines[0].endsWith(',Time (s),Value,Clock time'));
  assert.ok(
    lines[2].endsWith(',0.5,2,2026-10-10T14:00:00.500000+01:00'),
    lines[2],
  );

  const backup = await e.backupWorkspace();
  await e.restoreWorkspace(new File([backup], 'clock.stratum'));
  validateWorkspace(e.project);
  assert.deepEqual(
    e.project.sources.map((source) => source.clock),
    [
      { start: unix(2026, 10, 10, 13), offset: 60 },
      { start: 1791637200.25, offset: 60 },
    ],
  );
});

void test('clock alignment refuses signals without a matching clock', async (t) => {
  const e = await engine(t);
  const elapsed = await e.importCsv(new File(['t,x\n0,1\n1,2'], 'elapsed.csv'));
  const dated = await e.importCsv(
    new File(['Time,x\n2026-10-10 14:00,1\n2026-10-10 14:01,2'], 'dated.csv'),
  );
  const undated = await e.importCsv(
    new File(['Time,x\n14:00:00,1\n14:00:01,2'], 'undated.csv'),
  );
  assert.equal(elapsed.clock, undefined);
  assert.deepEqual(undated.clock, {
    start: 14 * 3600,
    offset: 0,
    undated: true,
  });
  await assert.rejects(
    e.applyTimeOperation(byClock([[elapsed.channels[0]], [dated.channels[0]]])),
    /elapsed\.csv has no clock time/,
  );
  await assert.rejects(
    e.applyTimeOperation(byClock([[dated.channels[0]], [undated.channels[0]]])),
    /only times of day/,
  );
  // Clock anchors need a timeline that tells clock time.
  const relative = byClock([[dated.channels[0]]]);
  if (relative.kind !== 'align') throw new Error('fixture');
  relative.reference = {
    id: elapsed.id,
    name: 'elapsed.csv',
    kind: 'relative',
  };
  await assert.rejects(
    e.applyTimeOperation(relative),
    /does not tell clock time/,
  );
  assert.equal(e.project.workflowSteps?.length, 3);
});

void test('date errors name the row and say how to read the column', async (t) => {
  const e = await engine(t);
  await assert.rejects(
    e.importCsv(
      new File(
        ['Time,x\n2026-10-10 14:00:01,1\n2026-10-10 14:00:00,2'],
        'back.csv',
      ),
    ),
    /back\.csv: Row 3: time “2026-10-10 14:00:00” does not come after the previous row’s time/,
  );
  await assert.rejects(
    e.importRecording(
      new File(['Time,x\n2026-10-10 14:00,1\n2026-10-10 14:01,2'], 'set.csv'),
      {
        layout: [
          { role: 'time', unit: 's' },
          { role: 'signal', time: 0 },
        ],
      },
    ),
    /Row 2: time “2026-10-10 14:00” is a date or clock time, but the column is read as elapsed time/,
  );
});

void test('workflow files line groups up by clock time', () => {
  const text = `format: stratum-workflow
version: 2
name: Clock
input:
  channels:
    speed: { name: Speed, unit: rpm }
steps:
  - id: aligned
    time:
      align:
        reference: { name: Clock, kind: absolute }
        target: 0
        groups:
          - input: speed
            anchor: { kind: clock }
`;
  const recipe = parseWorkflow(text);
  const again = parseWorkflow(serializeWorkflow(recipe));
  assert.deepEqual(again.steps, recipe.steps);
  assert.match(serializeWorkflow(recipe), /anchor:\s*\{?\s*kind: clock/);
});
