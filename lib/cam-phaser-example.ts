/**
 * Deterministic synthetic end-of-line test data for a vane-type cam phaser on
 * a static rig: the camshaft does not turn, the rig supplies hot oil at a
 * regulated pressure and steps the oil control valve (OCV) between 0 % and
 * 100 % duty, so the phaser travels from one end stop to the other. Each
 * recording comes from a small physical model sampled at 10 kHz, with a few
 * deliberately faulty units so batch checks have something to flag. The
 * committed files in examples/cam-phaser-eol are generated from this module.
 */
import { random } from './eol-example';

export type PhaserVariant =
  | 'nominal'
  | 'sticky'
  | 'short-stroke'
  | 'leaky'
  | 'lock-pin'
  | 'low-supply';

export const PHASER_UNITS: {
  serial: string;
  variant: PhaserVariant;
  expected: 'pass' | 'warning' | 'fail' | 'error';
  note: string;
}[] = [
  {
    serial: 'CP-24101',
    variant: 'nominal',
    expected: 'pass',
    note: 'Typical phaser.',
  },
  {
    serial: 'CP-24102',
    variant: 'nominal',
    expected: 'pass',
    note: 'Typical phaser.',
  },
  {
    serial: 'CP-24103',
    variant: 'sticky',
    expected: 'fail',
    note: 'A burr on a vane drags through mid-travel; the retard step, against the bias spring, is too slow.',
  },
  {
    serial: 'CP-24104',
    variant: 'short-stroke',
    expected: 'fail',
    note: 'Debris at the advance stop limits the authority to about 21.6°.',
  },
  {
    serial: 'CP-24105',
    variant: 'leaky',
    expected: 'fail',
    note: 'Worn vane-tip seals: leakage at both end stops is above 1 L/min.',
  },
  {
    serial: 'CP-24106',
    variant: 'lock-pin',
    expected: 'warning',
    note: 'The lock pin hangs on its first release, delaying the first advance step.',
  },
  {
    serial: 'CP-24107',
    variant: 'low-supply',
    expected: 'warning',
    note: 'The rig regulator drifted to about 2.5 bar; the test conditions are invalid.',
  },
];

/** Output sample rate (Hz) and the model's integration substeps per sample. */
export const PHASER_SAMPLE_RATE = 10_000;
const SUBSTEPS = 10;

/** Test sequence: oil on, then five 0 → 100 → 0 % valve cycles. */
export const PHASER_SEQUENCE = {
  supplyOn: 0.2,
  firstStep: 1,
  hold: 1,
  cycles: 5,
  duration: 11.5,
};

const fixed = (value: number, digits: number) =>
  Number.isFinite(value) ? String(Number(value.toFixed(digits))) : '';

/** Commanded OCV duty cycle (%) at time t. */
function dutyAt(t: number) {
  const { firstStep, hold, cycles } = PHASER_SEQUENCE;
  const local = t - firstStep;
  if (local < 0 || local >= cycles * 2 * hold) return 0;
  return local % (2 * hold) < hold ? 100 : 0;
}

/**
 * One recording: time, OCV duty and current, phaser angle (cam degrees from
 * the locked base position, advance positive), supply oil pressure and flow,
 * and oil temperature.
 */
export function phaserRecording(serial: string, variant: PhaserVariant) {
  const next = random(serial);
  // Roughly Gaussian unit noise from three uniform draws.
  const gauss = () => next() + next() + next() - 1.5;
  const spread = () => next() * 2 - 1;

  // Unit-to-unit and rig variation.
  const authority =
    variant === 'short-stroke' ? 21.7 + 0.1 * spread() : 24.8 + 0.25 * spread();
  const coilResistance20 = 6.9 * (1 + 0.02 * spread()); // Ω at 20 °C
  const friction = (variant === 'sticky' ? 0.85 : 0.2) + 0.03 * spread(); // bar
  const burr = variant === 'sticky' ? 1.8 : 0; // bar, 9–14°
  const leakage = (variant === 'leaky' ? 1.45 : 0.33) * (1 + 0.08 * spread());
  const pinRelease = 0.022 + 0.004 * spread(); // s
  const firstPinRelease = variant === 'lock-pin' ? 0.078 : pinRelease;
  const supplySet = (variant === 'low-supply' ? 2.5 : 3.0) + 0.02 * spread();
  const oilStart = 70 + 0.4 * spread();
  const speedScale = 1 + 0.04 * spread();
  const pumpPhase = next() * 2 * Math.PI;

  // Rig and phaser constants.
  const voltage = 13.5; // V, OCV supply
  const inductance = 0.022; // H with the armature out
  const inductanceRise = 0.024; // H more at full stroke (air gap closed)
  const spoolTau = 0.002; // s
  const spoolStart = 0.45; // A, spring preload
  const spoolFull = 1; // A, full stroke
  const overlap = 0.06; // spool land overlap around null
  const chamberTau = 0.006; // s
  const velocityTau = 0.009; // s
  const advanceRate = 235 * speedScale; // °/s at 2.6 bar net
  const retardRate = 220 * speedScale;
  const spring = 0.15; // bar equivalent, assists advance
  const displacement = 0.46; // cm³ per degree of travel
  const lineResistance = 0.075; // bar per L/min
  const lineHz = 21;
  const lineDamping = 0.38;
  const compliance = 0.012; // L/min per bar/s, hoses and accumulator
  const meterTau = 0.008; // s, flow meter
  const pumpRipple = 0.018; // bar at 225 Hz
  const encoder = 360 / 65536; // °, 16-bit absolute encoder

  const dt = 1 / (PHASER_SAMPLE_RATE * SUBSTEPS);
  const omega = 2 * Math.PI * lineHz;

  let current = 0;
  let coilTemperature = oilStart;
  let spool = 0;
  let drive = 0; // signed chamber drive pressure, bar (+ advances)
  let angle = 0;
  let velocity = 0;
  let pressure = 0;
  let pressureRate = 0;
  let flowReading = 0;
  let locked = true;
  let lockTimer = 0;
  let releaseTimer = 0;
  let releases = 0;
  let ringAmplitude = 0;
  let ringTime = 0;
  let hammer = 0; // bar, pressure spike when the vanes hit a stop
  let previousDuty = 0;
  let stroke = 1; // Each move varies slightly in friction and speed.

  const lines = [
    'Time [s],OCV duty cycle [%],OCV current [A],Phaser angle [°],Oil pressure [bar],Oil flow [L/min],Oil temperature [°C]',
  ];
  const samples = Math.round(PHASER_SEQUENCE.duration * PHASER_SAMPLE_RATE);
  for (let i = 0; i <= samples; i++) {
    const t = i / PHASER_SAMPLE_RATE;
    const duty = dutyAt(t);
    const oil = oilStart + 0.3 * (t / PHASER_SEQUENCE.duration);
    const viscosity = Math.exp(-0.025 * (oil - 70));
    if (duty !== previousDuty) stroke = 1 + 0.03 * spread();
    previousDuty = duty;
    for (let step = 0; step < SUBSTEPS; step++) {
      const time = t + step * dt;
      // Solenoid: PWM average voltage, temperature-dependent coil resistance
      // and an inductance that rises as the armature closes its air gap, so
      // the current dips while it moves; freewheel diode when switched off.
      const resistance =
        coilResistance20 * (1 + 0.0039 * (coilTemperature - 20));
      const spoolTarget = Math.min(
        1,
        Math.max(0, (current - spoolStart) / (spoolFull - spoolStart)),
      );
      const spoolRate = (spoolTarget - spool) / spoolTau;
      const applied =
        duty > 0 ? (voltage * duty) / 100 : current > 0 ? -0.7 : 0;
      current +=
        (dt *
          (applied -
            resistance * current -
            inductanceRise * spoolRate * current)) /
        (inductance + inductanceRise * spool);
      current = Math.max(0, current);
      spool += dt * spoolRate;
      coilTemperature +=
        (dt * (oil + 3 * current * current * resistance - coilTemperature)) /
        45;

      // Spool metering: 0 feeds the retard chambers, 1 the advance chambers.
      const open = (x: number) =>
        Math.min(1, Math.max(0, (x - overlap) / (0.5 - overlap)));
      const command = open(spool - 0.5) - open(0.5 - spool);
      const supplyOpen = Math.min(
        1,
        Math.max(0, (time - PHASER_SEQUENCE.supplyOn) / 0.05),
      );
      drive += (dt * (command * pressure - drive)) / chamberTau;

      // Lock pin at the base stop: engages after the advance side has been
      // vented for a moment, releases once advance pressure has acted on it.
      if (locked) {
        if (drive > 0.8) {
          releaseTimer += dt;
          if (releaseTimer >= (releases ? pinRelease : firstPinRelease)) {
            locked = false;
            releases++;
            releaseTimer = 0;
          }
        } else releaseTimer = 0;
      } else if (angle <= 0 && drive < 0.3) {
        lockTimer += dt;
        if (lockTimer > 0.03) {
          locked = true;
          lockTimer = 0;
        }
      } else lockTimer = 0;

      // Vanes: velocity follows the flow the valve can pass against
      // friction, the bias spring and, on one unit, a burr in mid-travel.
      let target = 0;
      if (!locked && Math.abs(command) > 0) {
        const advancing = drive > 0;
        const moving = Math.abs(velocity) > 2;
        const drag =
          friction * stroke * (moving ? 1 : 1.3) +
          (angle > 9 && angle < 14 ? burr : 0) +
          (advancing ? -spring : spring);
        const net = Math.abs(drive) - drag;
        if (net > 0)
          target =
            Math.sign(drive) *
            Math.abs(command) *
            (advancing ? advanceRate : retardRate) *
            (2 - stroke) *
            Math.sqrt(net / 2.6) *
            viscosity ** -0.15 *
            (1 - 0.05 * (leakage - 0.33));
      }
      velocity += (dt * (target - velocity)) / velocityTau;
      angle += dt * velocity;
      if (angle >= authority || angle <= 0) {
        const impact = Math.abs(velocity);
        if (impact > 5) {
          ringAmplitude = impact * 0.0009 * (angle > 0 ? 1 : -1);
          hammer = impact * 0.0015;
          ringTime = 0;
        }
        angle = angle > 0 ? authority : 0;
        velocity = 0;
      }
      ringTime += dt;

      // Rig supply: regulated pressure falls with flow through the line, and
      // the line rings when the flow changes suddenly.
      const valveLeak = 0.18 + 0.9 * Math.exp(-(((spool - 0.5) / 0.08) ** 2));
      const internalLeak =
        ((leakage * pressure) / 3) * viscosity ** -1 * (locked ? 0.88 : 1);
      const loadFlow =
        supplyOpen > 0
          ? valveLeak * supplyOpen +
            internalLeak +
            displacement * Math.abs(velocity) * 0.06
          : 0;
      const targetPressure = supplyOpen * supplySet - lineResistance * loadFlow;
      pressureRate +=
        dt *
        (omega * omega * (targetPressure - pressure) -
          2 * lineDamping * omega * pressureRate);
      pressure += dt * pressureRate;
      const meteredFlow = Math.max(0, loadFlow + compliance * pressureRate);
      flowReading += (dt * (meteredFlow - flowReading)) / meterTau;
    }

    const ring =
      ringAmplitude *
      Math.exp(-ringTime / 0.012) *
      Math.sin(2 * Math.PI * 55 * ringTime);
    const measuredAngle =
      Math.round((angle + ring + 0.004 * gauss()) / encoder) * encoder;
    const ripple =
      pressure > 0.05
        ? pumpRipple * Math.sin(2 * Math.PI * 225 * t + pumpPhase)
        : 0;
    const spike =
      hammer *
      Math.exp(-ringTime / 0.0025) *
      Math.cos(2 * Math.PI * 160 * ringTime);
    lines.push(
      [
        fixed(t, 4),
        String(duty),
        fixed(current + 0.004 * gauss(), 3),
        fixed(measuredAngle, 3),
        fixed(pressure + ripple + spike + 0.004 * gauss() + 0.01, 3),
        fixed(Math.max(0, flowReading + 0.015 * gauss()), 3),
        fixed(oil + 0.05 * gauss(), 1),
      ].join(','),
    );
  }
  return { name: `${serial}.csv`, text: `${lines.join('\n')}\n` };
}

export function phaserFiles(): File[] {
  return PHASER_UNITS.map(({ serial, variant }) => {
    const { name, text } = phaserRecording(serial, variant);
    return new File([text], name, { type: 'text/csv' });
  });
}

export const PHASER_WORKFLOW_NAME = 'Cam phaser static EOL test.stratum.yaml';

/** The example workflow, with checks and a report template. */
export const PHASER_WORKFLOW = `# Stratum workflow · Cam phaser static EOL test
# Inputs bind by CSV column name. Steps refer to channels and earlier steps
# by id; step[2] is the second output of a step. Open it in Stratum with
# Import → Open a workflow file…, or edit it in any text editor.
format: stratum-workflow
version: 2
name: Cam phaser static EOL test
revision: '1'
description: >-
  Static full-range test of a vane-type cam phaser. With the camshaft held
  still and oil supplied at 3 bar and 70 °C, the oil control valve is stepped
  0 → 100 → 0 % five times, driving the phaser from end stop to end stop.
  Checks cover authority, response in both directions, lock-pin release,
  leakage at the end stops, OCV current and the rig's test conditions.
item:
  label: Serial number
  id: { from: file-name, pattern: '^(?<id>CP-[0-9]+)' }
input:
  channels:
    duty: { name: OCV duty cycle, unit: '%' }
    current: { name: OCV current, unit: A }
    angle: { name: Phaser angle, unit: ° }
    pressure: { name: Oil pressure, unit: bar }
    flow: { name: Oil flow, unit: L/min }
    oil: { name: Oil temperature, unit: °C }
steps:
  # Each valve step starts a segment that lasts until the next step.
  - id: advance-steps
    name: Find the advance steps (0 → 100 %)
    segment:
      triggers:
        start: { signal: duty, edge: rising, threshold: 50 }
        end: { signal: duty, edge: falling, threshold: 50 }
        minimum-duration: 0.5
      boundary: discard
    outputs: Advance {n}
    checks:
      - count: 5
        severity: fail
        message: The rig should step the valve to 100 % five times.
    on-fail: stop

  # The last hold runs to the end of the recording, so a retard step ends
  # 0.85 s after the phaser is back within 0.5° of its base stop.
  - id: retard-steps
    name: Find the retard steps (100 → 0 %)
    segment:
      triggers:
        start: { signal: duty, edge: falling, threshold: 50 }
        end: { signal: angle, edge: falling, threshold: 0.5, offset: 0.85 }
        minimum-duration: 0.5
      boundary: discard
    outputs: Retard {n}
    checks:
      - count: 5
        severity: fail
        message: The rig should step the valve back to 0 % five times.
    on-fail: stop

  # One 0.4 s window from 0.5 s after each valve step, once the phaser
  # has settled at its stop.
  - id: advance-held
    name: Settled at the advance stop
    segment:
      within: advance-steps
      windows: { start: 0.5, end: 0.95, duration: 0.4, step: 1 }
      boundary: clip
    outputs: '{segment} · Held'

  - id: retard-held
    name: Settled at the base stop
    segment:
      within: retard-steps
      windows: { start: 0.5, end: 0.95, duration: 0.4, step: 1 }
      boundary: clip
    outputs: '{segment} · Held'

  - id: authority
    name: Authority (advance stop angle)
    value: { function: time-average, input: angle, within: advance-held }
    outputs: '{segment} · Authority'
    checks:
      - limits: { min: 23.5, max: 26, unit: ° }
        severity: fail
        message: The phaser does not reach its full advance stop.

  - id: base-angle
    name: Base stop angle
    value: { function: time-average, input: angle, within: retard-held }
    outputs: '{segment} · Base angle'
    checks:
      - limits: { min: -0.3, max: 0.3, unit: ° }
        severity: warning
        message: The phaser does not return to its locked base position.

  # Times are seconds from each valve step.
  - id: advance-dead-time
    name: Advance dead time (to 0.5°)
    value:
      function: first-crossing
      input: angle
      within: advance-steps
      threshold: 0.5
    outputs: '{segment} · Dead time'
    checks:
      - limits: { max: 0.08, unit: s }
        severity: warning
        message: Slow lock-pin release.

  - id: advance-response
    name: Advance response (to 90 % of stroke)
    value:
      function: first-crossing
      input: angle
      within: advance-steps
      threshold: { value: 'authority[1]', factor: 0.9 }
    outputs: '{segment} · Response time'
    checks:
      - limits: { max: 0.22, unit: s }
        severity: fail
        message: The phaser responds too slowly.

  - id: retard-response
    name: Retard response (to 10 % of stroke)
    value:
      function: first-crossing
      input: angle
      within: retard-steps
      threshold: { value: 'authority[1]', factor: 0.1 }
      edge: falling
    outputs: '{segment} · Response time'
    checks:
      - limits: { max: 0.22, unit: s }
        severity: fail
        message: The phaser responds too slowly.

  - id: advance-leakage
    name: Leakage at the advance stop
    value: { function: time-average, input: flow, within: advance-held }
    outputs: '{segment} · Leakage'
    checks:
      - limits: { max: 1, unit: L/min }
        severity: fail
        message: Internal leakage is too high.

  - id: base-leakage
    name: Leakage at the base stop
    value: { function: time-average, input: flow, within: retard-held }
    outputs: '{segment} · Leakage'
    checks:
      - limits: { max: 1, unit: L/min }
        severity: fail
        message: Internal leakage is too high.

  - id: peak-flow
    name: Peak flow while moving
    value: { function: maximum, input: flow, within: advance-steps }
    outputs: '{segment} · Peak flow'

  - id: ocv-current
    name: OCV current at 100 %
    value: { function: time-average, input: current, within: advance-held }
    outputs: '{segment} · OCV current'
    checks:
      - limits: { min: 1.45, max: 1.85, unit: A }
        severity: fail
        message: OCV coil current out of range.

  # Test conditions: the result is only valid at the specified supply.
  - id: supply-pressure
    name: Supply pressure at the base stop
    value: { function: time-average, input: pressure, within: retard-held }
    outputs: '{segment} · Supply pressure'
    checks:
      - limits: { min: 2.8, max: 3.2, unit: bar }
        severity: warning
        message: Rig oil supply out of range; retest the phaser.

  - id: oil-temperature
    name: Average oil temperature
    value: { function: time-average, input: oil }
    outputs: Average oil temperature
    checks:
      - limits: { min: 67, max: 73, unit: °C }
        severity: warning
        message: Oil temperature out of range; retest the phaser.

report:
  title: Cam phaser EOL report · {{item.id}}
  page-size: a4
  orientation: portrait
  pages:
    - blocks:
        - type: text
          name: Eyebrow
          y: 40
          width: 698
          height: 24
          text: STRATUM · CAM PHASER STATIC TEST
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
            Cam phaser EOL report
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
          name: Test traces
          y: 270
          width: 698
          height: 800
          text: Valve, phaser and oil supply
          bind:
            plot:
              traces:
                - ref: duty
                - ref: angle
                - ref: pressure
                - ref: flow
    - blocks:
        - type: table
          name: Key results
          y: 40
          width: 698
          height: 620
          text: Key results
          bind:
            values:
              - authority
              - advance-dead-time
              - advance-response
              - retard-response
              - advance-leakage
              - base-leakage
        - type: table
          name: Checks
          y: 680
          width: 698
          height: 400
          text: Checks
          bind: { checks: flagged }
`;
