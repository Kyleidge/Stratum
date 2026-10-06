/**
 * Deterministic synthetic end-of-line test data: one recording per motor, with
 * a few deliberately unusual units so batch checks have something to flag.
 * The committed files in examples/eol-rig are generated from this module.
 */
export type ComponentVariant =
  | 'nominal'
  | 'late-start'
  | 'low-torque'
  | 'missing-sweep'
  | 'dropout'
  | 'hot'
  | 'wrong-unit';

export const EOL_COMPONENTS: {
  serial: string;
  variant: ComponentVariant;
  expected: 'pass' | 'warning' | 'fail' | 'error';
  note: string;
}[] = [
  {
    serial: 'SN-24001',
    variant: 'nominal',
    expected: 'pass',
    note: 'Typical motor.',
  },
  {
    serial: 'SN-24002',
    variant: 'nominal',
    expected: 'pass',
    note: 'Typical motor.',
  },
  {
    serial: 'SN-24003',
    variant: 'low-torque',
    expected: 'fail',
    note: 'Average sweep torque below the 78 Nm limit.',
  },
  {
    serial: 'SN-24004',
    variant: 'late-start',
    expected: 'pass',
    note: 'Operator started the sweeps 12 s later; trigger segmentation still finds them.',
  },
  {
    serial: 'SN-24005',
    variant: 'missing-sweep',
    expected: 'fail',
    note: 'The rig aborted the third sweep; the count check stops further processing.',
  },
  {
    serial: 'SN-24006',
    variant: 'dropout',
    expected: 'warning',
    note: 'Torque logger dropped samples during sweep 2.',
  },
  {
    serial: 'SN-24007',
    variant: 'hot',
    expected: 'warning',
    note: 'Winding temperature exceeds 90 °C.',
  },
  {
    serial: 'SN-24008',
    variant: 'wrong-unit',
    expected: 'error',
    note: 'Torque logged in lbf·ft; torque steps are skipped, temperature and current still run.',
  },
];

/** Small seeded generator so every serial produces the same file each time. */
function random(seed: string) {
  let state = 2166136261;
  for (const char of seed)
    state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507);
    state = Math.imul(state ^ (state >>> 13), 3266489909);
    state ^= state >>> 16;
    return (state >>> 0) / 4294967296;
  };
}

const fixed = (value: number, digits: number) =>
  Number.isFinite(value) ? String(Number(value.toFixed(digits))) : '';

/** One recording at 10 Hz: speed sweeps with torque, current and temperature. */
export function componentRecording(serial: string, variant: ComponentVariant) {
  const next = random(serial);
  const noise = () => next() * 2 - 1;
  const bias = noise() * 1.5;
  const late = variant === 'late-start' ? 12 : 0;
  const sweeps = (variant === 'missing-sweep' ? [10, 65] : [10, 65, 120]).map(
    (start) => start + late,
  );
  const duration = 180 + late;
  const base = variant === 'low-torque' ? 66 : 77;
  const heat = variant === 'hot' ? 72 : 44;
  const torqueHeader =
    variant === 'wrong-unit' ? 'Torque [lbf·ft]' : 'Torque [Nm]';
  const lines = [
    `Time [s],Motor speed [rpm],${torqueHeader},Supply current [A],Winding temperature [°C]`,
  ];
  for (let i = 0; i <= duration * 10; i++) {
    const t = i / 10;
    const sweep = sweeps.findIndex((start) => t >= start && t < start + 40);
    const local = sweep >= 0 ? t - sweeps[sweep] : 0;
    const speed =
      sweep >= 0
        ? 900 + 120 * local + 4 * noise()
        : 600 + 6 * Math.sin(t * 3) + 2 * noise();
    let torque =
      sweep >= 0
        ? base +
          bias +
          12 * Math.sin((Math.PI * local) / 40) +
          sweep * 0.8 +
          1.4 * Math.sin(t * 19) +
          0.6 * noise()
        : 3 + 0.3 * Math.sin(t * 7) + 0.2 * noise();
    const current = 2 + 0.22 * torque + 0.3 * noise();
    const temperature =
      35 +
      heat * (1 - Math.exp(-t / 110)) +
      0.2 * Math.sin(t / 3) +
      0.05 * noise();
    if (variant === 'dropout' && sweep === 1 && local >= 15 && local < 24)
      torque = NaN;
    if (variant === 'wrong-unit') torque *= 0.7375621;
    lines.push(
      [
        fixed(t, 1),
        fixed(speed, 2),
        fixed(torque, 3),
        fixed(current, 3),
        fixed(temperature, 2),
      ].join(','),
    );
  }
  return { name: `${serial}.csv`, text: `${lines.join('\n')}\n` };
}

export function componentFiles(): File[] {
  return EOL_COMPONENTS.map(({ serial, variant }) => {
    const { name, text } = componentRecording(serial, variant);
    return new File([text], name, { type: 'text/csv' });
  });
}

export const EOL_WORKFLOW_NAME = 'Motor EOL test.stratum.yaml';

/** The example workflow, with checks and a report template. */
export const EOL_WORKFLOW = `# Stratum workflow · Motor EOL test
# Inputs bind by CSV column name. Steps refer to channels and earlier steps
# by id; step[2] is the second output of a step. Open it in Stratum with
# Import → Open a workflow file…, or edit it in any text editor.
format: stratum-workflow
version: 1
name: Motor EOL test
revision: '1'
description: >-
  End-of-line test for the motor rig. Three speed sweeps are found with speed
  triggers, then torque, temperature and current are checked against limits.
item:
  label: Serial number
  id: { from: file-name, pattern: '^(?<id>SN-[0-9]+)' }
input:
  channels:
    speed: { name: Motor speed, unit: rpm }
    torque: { name: Torque, unit: Nm }
    current: { name: Supply current, unit: A }
    temperature: { name: Winding temperature, unit: °C }
steps:
  - id: smoothed-torque
    name: Smooth measured torque
    derive: { function: smooth, input: torque, parameter: 5 }
    outputs: Smoothed torque
    checks:
      - missing: { max: 0.01 }
        severity: warning
        message: Torque has dropouts.

  - id: power
    name: Multiply torque and speed
    derive: { function: multiply, input: smoothed-torque, with: speed }
    outputs: Torque × speed

  # Triggers find the sweeps wherever they occur in the recording.
  - id: sweeps
    name: Find the speed sweeps
    segment:
      input: smoothed-torque
      triggers:
        start: { signal: speed, edge: rising, threshold: 850 }
        end: { signal: speed, edge: falling, threshold: 850 }
        minimum-duration: 20
      boundary: discard
    outputs: Sweep {n} · Torque
    checks:
      - count: 3
        severity: fail
        message: The rig should record three speed sweeps.
    on-fail: stop

  - id: sweep-torque
    name: Average torque by sweep
    value: { function: time-average, input: sweeps }
    outputs: Sweep {n} · Average torque
    checks:
      - limits: { min: 78, max: 95, unit: Nm }
        severity: fail

  - id: sweep-2-halves
    name: Split sweep 2 into halves
    segment:
      input: sweeps[2]
      windows: { start: 0, end: 40, duration: 20, step: 20, partial: false }
      time-origin: input-start
      boundary: clip
    outputs: [Sweep 2 · First half · Torque, Sweep 2 · Second half · Torque]

  - id: half-peaks
    name: Peak torque within sweep 2
    value: { function: maximum, input: sweep-2-halves }
    outputs: Sweep 2 · Half {n} · Peak torque

  - id: peak-temperature
    name: Peak winding temperature
    value: { function: maximum, input: temperature }
    outputs: Peak winding temperature
    checks:
      - limits: { max: 90, unit: °C }
        severity: warning
        message: The winding ran hot.

  - id: average-current
    name: Average supply current
    value: { function: time-average, input: current }
    outputs: Average supply current
    checks:
      - limits: { max: 20, unit: A }
        severity: fail

report:
  title: Motor EOL report · {{item.id}}
  page-size: a4
  orientation: portrait
  pages:
    - blocks:
        - type: text
          name: Eyebrow
          y: 40
          width: 698
          height: 24
          text: STRATUM · END-OF-LINE TEST
          font-size: 11
          bold: true
          color: '#167f8c'
          padding: 0
        - type: text
          name: Title
          y: 70
          width: 698
          height: 80
          text: |-
            Motor EOL report
            {{item.label}} {{item.id}}
          font-size: 28
          bold: true
          color: '#173447'
          padding: 0
        - type: text
          name: Summary
          y: 160
          width: 698
          height: 100
          text: |-
            Result: {{run.status}} · {{run.flags}}
            Recording: {{file.name}} · processed {{run.date}}
            Workflow: {{workflow.name}} revision {{workflow.revision}} · {{workflow.hash}}
          font-size: 12
          color: '#33495a'
        - type: plot
          name: Torque plot
          y: 270
          width: 698
          height: 300
          text: Smoothed torque
          bind: { signal: smoothed-torque }
        - type: table
          name: Key results
          y: 590
          width: 698
          height: 230
          text: Key results
          bind:
            values: [sweep-torque, peak-temperature, average-current]
        - type: table
          name: Checks
          y: 840
          width: 698
          height: 240
          text: Checks
          bind: { checks: all }
`;
