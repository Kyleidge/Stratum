/**
 * Linear unit conversions within explicit families. A unit converts to its
 * family's base as `value × factor + offset`. Labels are matched exactly
 * against each unit's aliases (case matters: mW is not MW); nothing is
 * guessed from similar spellings.
 */
type Unit = {
  label: string;
  aliases?: string[];
  factor: number;
  offset?: number;
};
type Family = { name: string; units: Unit[] };

const FAMILIES: Family[] = [
  {
    name: 'Torque',
    units: [
      { label: 'N·m', aliases: ['Nm', 'N m', 'N*m', 'N.m'], factor: 1 },
      { label: 'kN·m', aliases: ['kNm', 'kN m'], factor: 1000 },
      { label: 'N·cm', aliases: ['Ncm'], factor: 0.01 },
      {
        label: 'lbf·ft',
        aliases: ['lbf ft', 'lb·ft', 'lb ft', 'lbft', 'ft·lbf', 'ft lbf'],
        factor: 4.4482216152605 * 0.3048,
      },
      {
        label: 'lbf·in',
        aliases: ['lbf in', 'lb·in', 'lb in', 'in·lbf'],
        factor: 4.4482216152605 * 0.0254,
      },
      { label: 'kgf·m', aliases: ['kgf m'], factor: 9.80665 },
    ],
  },
  {
    name: 'Rotational speed',
    units: [
      { label: 'rad/s', factor: 1 },
      {
        label: 'rpm',
        aliases: ['RPM', 'r/min', '1/min', 'min⁻¹', 'min^-1'],
        factor: Math.PI / 30,
      },
      { label: 'rev/s', aliases: ['rps'], factor: 2 * Math.PI },
      { label: 'deg/s', aliases: ['°/s'], factor: Math.PI / 180 },
    ],
  },
  {
    name: 'Temperature',
    units: [
      { label: 'K', factor: 1 },
      {
        label: '°C',
        aliases: ['degC', '℃', 'deg C'],
        factor: 1,
        offset: 273.15,
      },
      {
        label: '°F',
        aliases: ['degF', '℉', 'deg F'],
        factor: 5 / 9,
        offset: 273.15 - (32 * 5) / 9,
      },
    ],
  },
  {
    name: 'Pressure',
    units: [
      { label: 'Pa', factor: 1 },
      { label: 'hPa', factor: 100 },
      { label: 'kPa', factor: 1e3 },
      { label: 'MPa', factor: 1e6 },
      { label: 'mbar', factor: 100 },
      { label: 'bar', factor: 1e5 },
      {
        label: 'psi',
        aliases: ['lbf/in²', 'lbf/in2'],
        factor: 6894.757293168361,
      },
      { label: 'atm', factor: 101325 },
      { label: 'mmHg', factor: 133.322387415 },
      { label: 'inHg', factor: 3386.388640341 },
    ],
  },
  {
    name: 'Power',
    units: [
      { label: 'W', factor: 1 },
      { label: 'kW', factor: 1e3 },
      { label: 'MW', factor: 1e6 },
      { label: 'hp', aliases: ['HP', 'bhp'], factor: 745.6998715822702 },
      { label: 'PS', aliases: ['CV'], factor: 735.49875 },
    ],
  },
  {
    name: 'Speed',
    units: [
      { label: 'm/s', factor: 1 },
      { label: 'km/h', aliases: ['kph', 'kmh'], factor: 1 / 3.6 },
      { label: 'mph', factor: 0.44704 },
      { label: 'ft/s', factor: 0.3048 },
      { label: 'kn', aliases: ['kt', 'knot'], factor: 1852 / 3600 },
    ],
  },
  {
    name: 'Length',
    units: [
      { label: 'm', factor: 1 },
      { label: 'µm', aliases: ['um'], factor: 1e-6 },
      { label: 'mm', factor: 1e-3 },
      { label: 'cm', factor: 1e-2 },
      { label: 'km', factor: 1e3 },
      { label: 'in', aliases: ['inch'], factor: 0.0254 },
      { label: 'ft', factor: 0.3048 },
    ],
  },
  {
    name: 'Mass flow',
    units: [
      { label: 'kg/s', factor: 1 },
      { label: 'kg/h', factor: 1 / 3600 },
      { label: 'kg/min', factor: 1 / 60 },
      { label: 'g/s', factor: 1e-3 },
      { label: 'g/min', factor: 1e-3 / 60 },
      { label: 'g/h', factor: 1e-3 / 3600 },
      { label: 'lb/h', factor: 0.45359237 / 3600 },
      { label: 'lb/min', factor: 0.45359237 / 60 },
    ],
  },
  {
    name: 'Volume flow',
    units: [
      { label: 'm³/s', aliases: ['m3/s'], factor: 1 },
      { label: 'm³/h', aliases: ['m3/h'], factor: 1 / 3600 },
      { label: 'L/s', aliases: ['l/s'], factor: 1e-3 },
      { label: 'L/min', aliases: ['l/min', 'lpm'], factor: 1e-3 / 60 },
      { label: 'L/h', aliases: ['l/h'], factor: 1e-3 / 3600 },
      { label: 'gal/min', aliases: ['gpm'], factor: 0.003785411784 / 60 },
      {
        label: 'cfm',
        aliases: ['ft³/min', 'ft3/min'],
        factor: 0.028316846592 / 60,
      },
    ],
  },
  {
    name: 'Force',
    units: [
      { label: 'N', factor: 1 },
      { label: 'kN', factor: 1e3 },
      { label: 'lbf', factor: 4.4482216152605 },
      { label: 'kgf', factor: 9.80665 },
    ],
  },
  {
    name: 'Mass',
    units: [
      { label: 'kg', factor: 1 },
      { label: 'g', factor: 1e-3 },
      { label: 't', factor: 1e3 },
      { label: 'lb', aliases: ['lbs'], factor: 0.45359237 },
    ],
  },
  {
    name: 'Energy',
    units: [
      { label: 'J', factor: 1 },
      { label: 'kJ', factor: 1e3 },
      { label: 'MJ', factor: 1e6 },
      { label: 'Wh', factor: 3600 },
      { label: 'kWh', factor: 3.6e6 },
    ],
  },
  {
    name: 'Time',
    units: [
      { label: 's', aliases: ['sec'], factor: 1 },
      { label: 'µs', aliases: ['us'], factor: 1e-6 },
      { label: 'ms', factor: 1e-3 },
      { label: 'min', factor: 60 },
      { label: 'h', factor: 3600 },
    ],
  },
  {
    name: 'Angle',
    units: [
      { label: 'rad', factor: 1 },
      { label: '°', aliases: ['deg'], factor: Math.PI / 180 },
      { label: 'rev', factor: 2 * Math.PI },
    ],
  },
  {
    name: 'Acceleration',
    units: [
      { label: 'm/s²', aliases: ['m/s^2', 'm/s2'], factor: 1 },
      { label: 'g', aliases: ['gn'], factor: 9.80665 },
    ],
  },
  {
    name: 'Frequency',
    units: [
      { label: 'Hz', factor: 1 },
      { label: 'kHz', factor: 1e3 },
    ],
  },
  {
    name: 'Voltage',
    units: [
      { label: 'V', factor: 1 },
      { label: 'mV', factor: 1e-3 },
      { label: 'kV', factor: 1e3 },
    ],
  },
  {
    name: 'Current',
    units: [
      { label: 'A', factor: 1 },
      { label: 'mA', factor: 1e-3 },
      { label: 'kA', factor: 1e3 },
    ],
  },
];

/** Families a unit label belongs to (mass "g" and acceleration "g" both). */
function find(label: string): { family: Family; unit: Unit }[] {
  const text = label.trim();
  return FAMILIES.flatMap((family) =>
    family.units
      .filter((unit) => unit.label === text || unit.aliases?.includes(text))
      .map((unit) => ({ family, unit })),
  );
}

/** Units a label can be converted to, by family, excluding itself. */
export function conversionTargets(
  label: string,
): { family: string; units: string[] }[] {
  return find(label).map(({ family, unit }) => ({
    family: family.name,
    units: family.units
      .filter((item) => item !== unit)
      .map((item) => item.label),
  }));
}

/**
 * The exact linear map from one unit to another, `out = in × factor +
 * offset`, or undefined when Stratum has no such conversion.
 */
export function unitConversion(
  from: string,
  to: string,
): { factor: number; offset: number } | undefined {
  for (const source of find(from))
    for (const target of find(to)) {
      if (source.family !== target.family) continue;
      const factor = source.unit.factor / target.unit.factor;
      const offset =
        ((source.unit.offset ?? 0) - (target.unit.offset ?? 0)) /
        target.unit.factor;
      return { factor, offset };
    }
  return undefined;
}
