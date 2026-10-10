/**
 * Units Stratum recognises, and exact linear conversions between them.
 *
 * A unit is a registered label (with its aliases), an SI-prefixed unit such
 * as kN or mbar, or a compound of those written with ·, *, / and powers
 * (m/s², g/kWh, (N·m)·(rpm), W/(m²·K)). Every unit has a dimension and
 * converts to its coherent SI base as `value × factor + offset`; two units
 * convert when their dimensions match exactly. Angle is its own dimension,
 * so rpm never converts to Hz, and torque is energy per radian, so N·m never
 * converts to J while N·m × rad/s is W.
 *
 * Labels are matched exactly (case matters: mW is not MW); nothing is
 * guessed from similar spellings. `unitSuggestions` only offers fixes.
 */
type Unit = {
  label: string;
  aliases?: string[];
  factor: number;
  offset?: number;
};
/** Exponents of m, kg, s, A, K, mol, rad and count. */
type Dims = readonly number[];
type Family = {
  name: string;
  dims: Dims;
  units: Unit[];
  /** Converts only within itself and never appears in compounds. */
  isolated?: boolean;
};

const dims = (
  m = 0,
  kg = 0,
  s = 0,
  A = 0,
  K = 0,
  mol = 0,
  rad = 0,
  count = 0,
): Dims => [m, kg, s, A, K, mol, rad, count];

const LBF = 4.4482216152605;
const LB = 0.45359237;
const GALLON = 0.003785411784;

/**
 * Families keep the factors earlier releases used, so saved conversions
 * stay exact. Later families only add labels; a label's meaning never
 * changes (docs/file-format-stability.md).
 */
const FAMILIES: Family[] = [
  {
    name: 'Torque',
    dims: dims(2, 1, -2, 0, 0, 0, -1),
    units: [
      { label: 'N·m', aliases: ['Nm', 'N m', 'N*m', 'N.m'], factor: 1 },
      { label: 'kN·m', aliases: ['kNm', 'kN m'], factor: 1000 },
      { label: 'N·cm', aliases: ['Ncm'], factor: 0.01 },
      {
        label: 'lbf·ft',
        aliases: ['lbf ft', 'lb·ft', 'lb ft', 'lbft', 'ft·lbf', 'ft lbf'],
        factor: LBF * 0.3048,
      },
      {
        label: 'lbf·in',
        aliases: ['lbf in', 'lb·in', 'lb in', 'in·lbf'],
        factor: LBF * 0.0254,
      },
      { label: 'kgf·m', aliases: ['kgf m'], factor: 9.80665 },
    ],
  },
  {
    name: 'Rotational speed',
    dims: dims(0, 0, -1, 0, 0, 0, 1),
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
    dims: dims(0, 0, 0, 0, 1),
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
    dims: dims(-1, 1, -2),
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
    dims: dims(2, 1, -3),
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
    dims: dims(1, 0, -1),
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
    dims: dims(1),
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
    dims: dims(0, 1, -1),
    units: [
      { label: 'kg/s', factor: 1 },
      { label: 'kg/h', factor: 1 / 3600 },
      { label: 'kg/min', factor: 1 / 60 },
      { label: 'g/s', factor: 1e-3 },
      { label: 'g/min', factor: 1e-3 / 60 },
      { label: 'g/h', factor: 1e-3 / 3600 },
      { label: 'lb/h', factor: LB / 3600 },
      { label: 'lb/min', factor: LB / 60 },
    ],
  },
  {
    name: 'Volume flow',
    dims: dims(3, 0, -1),
    units: [
      { label: 'm³/s', aliases: ['m3/s'], factor: 1 },
      { label: 'm³/h', aliases: ['m3/h'], factor: 1 / 3600 },
      { label: 'L/s', aliases: ['l/s'], factor: 1e-3 },
      { label: 'L/min', aliases: ['l/min', 'lpm'], factor: 1e-3 / 60 },
      { label: 'L/h', aliases: ['l/h'], factor: 1e-3 / 3600 },
      { label: 'gal/min', aliases: ['gpm'], factor: GALLON / 60 },
      {
        label: 'cfm',
        aliases: ['ft³/min', 'ft3/min'],
        factor: 0.028316846592 / 60,
      },
    ],
  },
  {
    name: 'Force',
    dims: dims(1, 1, -2),
    units: [
      { label: 'N', factor: 1 },
      { label: 'kN', factor: 1e3 },
      { label: 'lbf', factor: LBF },
      { label: 'kgf', factor: 9.80665 },
    ],
  },
  {
    name: 'Mass',
    dims: dims(0, 1),
    units: [
      { label: 'kg', factor: 1 },
      { label: 'g', factor: 1e-3 },
      { label: 't', factor: 1e3 },
      { label: 'lb', aliases: ['lbs'], factor: LB },
    ],
  },
  {
    name: 'Energy',
    dims: dims(2, 1, -2),
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
    dims: dims(0, 0, 1),
    units: [
      { label: 's', aliases: ['sec'], factor: 1 },
      { label: 'µs', aliases: ['us'], factor: 1e-6 },
      { label: 'ms', factor: 1e-3 },
      { label: 'min', factor: 60 },
      { label: 'h', aliases: ['hr'], factor: 3600 },
    ],
  },
  {
    name: 'Angle',
    dims: dims(0, 0, 0, 0, 0, 0, 1),
    units: [
      { label: 'rad', factor: 1 },
      { label: '°', aliases: ['deg'], factor: Math.PI / 180 },
      { label: 'rev', factor: 2 * Math.PI },
    ],
  },
  {
    name: 'Acceleration',
    dims: dims(1, 0, -2),
    units: [
      { label: 'm/s²', aliases: ['m/s^2', 'm/s2'], factor: 1 },
      { label: 'g', aliases: ['gn'], factor: 9.80665 },
    ],
  },
  {
    name: 'Frequency',
    dims: dims(0, 0, -1),
    units: [
      { label: 'Hz', factor: 1 },
      { label: 'kHz', factor: 1e3 },
    ],
  },
  {
    name: 'Voltage',
    dims: dims(2, 1, -3, -1),
    units: [
      { label: 'V', factor: 1 },
      { label: 'mV', factor: 1e-3 },
      { label: 'kV', factor: 1e3 },
    ],
  },
  {
    name: 'Current',
    dims: dims(0, 0, 0, 1),
    units: [
      { label: 'A', factor: 1 },
      { label: 'mA', factor: 1e-3 },
      { label: 'kA', factor: 1e3 },
    ],
  },
  // Families below were added with compound units.
  {
    name: 'Ratio',
    dims: dims(),
    units: [
      { label: '1', factor: 1 },
      { label: '%', factor: 0.01 },
      { label: '‰', factor: 1e-3 },
      { label: 'ppm', factor: 1e-6 },
    ],
  },
  {
    name: 'Area',
    dims: dims(2),
    units: [
      { label: 'm²', aliases: ['m2', 'm^2'], factor: 1 },
      { label: 'cm²', aliases: ['cm2', 'cm^2'], factor: 1e-4 },
      { label: 'mm²', aliases: ['mm2', 'mm^2'], factor: 1e-6 },
      { label: 'in²', aliases: ['in2', 'in^2'], factor: 0.0254 ** 2 },
      { label: 'ft²', aliases: ['ft2', 'ft^2'], factor: 0.3048 ** 2 },
    ],
  },
  {
    name: 'Volume',
    dims: dims(3),
    units: [
      { label: 'm³', aliases: ['m3', 'm^3'], factor: 1 },
      { label: 'L', aliases: ['l'], factor: 1e-3 },
      { label: 'mL', aliases: ['ml'], factor: 1e-6 },
      { label: 'cm³', aliases: ['cm3', 'cc', 'ccm'], factor: 1e-6 },
      { label: 'gal', factor: GALLON },
      { label: 'ft³', aliases: ['ft3'], factor: 0.028316846592 },
    ],
  },
  {
    name: 'Density',
    dims: dims(-3, 1),
    units: [
      { label: 'kg/m³', aliases: ['kg/m3'], factor: 1 },
      { label: 'g/cm³', aliases: ['g/cm3', 'g/cc'], factor: 1e3 },
      { label: 'kg/L', aliases: ['kg/l'], factor: 1e3 },
      { label: 'g/L', aliases: ['g/l'], factor: 1 },
    ],
  },
  {
    name: 'Specific fuel consumption',
    dims: dims(-2, 0, 2),
    units: [
      { label: 'g/kWh', aliases: ['g/(kW·h)'], factor: 1e-3 / 3.6e6 },
      { label: 'kg/kWh', factor: 1 / 3.6e6 },
      {
        label: 'lb/(hp·h)',
        aliases: ['lb/hph', 'lb/hp·h'],
        factor: LB / (745.6998715822702 * 3600),
      },
    ],
  },
  {
    name: 'Angular acceleration',
    dims: dims(0, 0, -2, 0, 0, 0, 1),
    units: [
      { label: 'rad/s²', aliases: ['rad/s^2', 'rad/s2'], factor: 1 },
      { label: 'deg/s²', aliases: ['°/s²', 'deg/s^2'], factor: Math.PI / 180 },
      { label: 'rpm/s', factor: Math.PI / 30 },
    ],
  },
  {
    name: 'Resistance',
    dims: dims(2, 1, -3, -2),
    units: [
      { label: 'Ω', aliases: ['ohm', 'Ohm'], factor: 1 },
      { label: 'mΩ', aliases: ['mohm'], factor: 1e-3 },
      { label: 'kΩ', aliases: ['kohm', 'kOhm'], factor: 1e3 },
      { label: 'MΩ', aliases: ['Mohm', 'MOhm'], factor: 1e6 },
    ],
  },
  {
    name: 'Charge',
    dims: dims(0, 0, 1, 1),
    units: [
      { label: 'Ah', aliases: ['A·h'], factor: 3600 },
      { label: 'mAh', aliases: ['mA·h'], factor: 3.6 },
      { label: 'As', aliases: ['A·s'], factor: 1 },
    ],
  },
  {
    name: 'Amount',
    dims: dims(0, 0, 0, 0, 0, 1),
    units: [
      { label: 'mol', factor: 1 },
      { label: 'mmol', factor: 1e-3 },
    ],
  },
  {
    name: 'Count',
    dims: dims(0, 0, 0, 0, 0, 0, 0, 1),
    units: [{ label: 'count', aliases: ['counts', 'cnt'], factor: 1 }],
  },
  {
    name: 'Sound level',
    dims: dims(),
    isolated: true,
    units: [{ label: 'dB', factor: 1 }],
  },
  {
    name: 'Weighted sound level',
    dims: dims(),
    isolated: true,
    units: [{ label: 'dB(A)', aliases: ['dBA'], factor: 1 }],
  },
  {
    name: 'Full scale',
    dims: dims(),
    isolated: true,
    units: [{ label: 'FS', factor: 1 }],
  },
];

/** Base symbols that take SI prefixes inside prefixed and compound units. */
const PREFIXABLE: Record<
  string,
  { factor: number; dims: Dims; family: string }
> = {
  m: { factor: 1, dims: dims(1), family: 'Length' },
  g: { factor: 1e-3, dims: dims(0, 1), family: 'Mass' },
  s: { factor: 1, dims: dims(0, 0, 1), family: 'Time' },
  A: { factor: 1, dims: dims(0, 0, 0, 1), family: 'Current' },
  K: { factor: 1, dims: dims(0, 0, 0, 0, 1), family: 'Temperature' },
  mol: { factor: 1, dims: dims(0, 0, 0, 0, 0, 1), family: 'Amount' },
  rad: { factor: 1, dims: dims(0, 0, 0, 0, 0, 0, 1), family: 'Angle' },
  Hz: { factor: 1, dims: dims(0, 0, -1), family: 'Frequency' },
  N: { factor: 1, dims: dims(1, 1, -2), family: 'Force' },
  Pa: { factor: 1, dims: dims(-1, 1, -2), family: 'Pressure' },
  bar: { factor: 1e5, dims: dims(-1, 1, -2), family: 'Pressure' },
  J: { factor: 1, dims: dims(2, 1, -2), family: 'Energy' },
  Wh: { factor: 3600, dims: dims(2, 1, -2), family: 'Energy' },
  W: { factor: 1, dims: dims(2, 1, -3), family: 'Power' },
  V: { factor: 1, dims: dims(2, 1, -3, -1), family: 'Voltage' },
  Ω: { factor: 1, dims: dims(2, 1, -3, -2), family: 'Resistance' },
  L: { factor: 1e-3, dims: dims(3), family: 'Volume' },
};
const PREFIXES: Record<string, number> = {
  G: 1e9,
  M: 1e6,
  k: 1e3,
  h: 1e2,
  d: 1e-1,
  c: 1e-2,
  m: 1e-3,
  µ: 1e-6,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
};

type Entry = { family: Family; unit: Unit };
/** Every label and alias, in family order (mass "g" before acceleration). */
const LABELS = new Map<string, Entry[]>();
for (const family of FAMILIES)
  for (const unit of family.units)
    for (const label of [unit.label, ...(unit.aliases ?? [])])
      LABELS.set(label, [...(LABELS.get(label) ?? []), { family, unit }]);
/**
 * Registered products such as N·m, longest first: a compound reads them as
 * one factor, so N·m/s is a torque rate rather than a power.
 */
const JOINED = [...LABELS.keys()]
  .filter((label) => /[·*. ]/.test(label) && !/[/()]/.test(label))
  .sort((a, b) => b.length - a.length);

/** A unit with its meaning, as one interpretation of a label. */
type Meaning = {
  /** The label Stratum writes for it: aliases become their unit's label. */
  label: string;
  factor: number;
  offset: number;
  dims: Dims;
  family?: Family;
};

const sameDims = (a: Dims, b: Dims) => a.every((value, i) => value === b[i]);
const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const SEPARATOR = /[·*×⋅.]/;
const STOP = /[·*×⋅. /()^⁰¹²³⁴⁵⁶⁷⁸⁹⁻0-9]/;

function normalise(label: string) {
  // Greek mu and the ohm sign read as the micro sign and capital omega.
  return label
    .trim()
    .replace(/\u03bc/g, '\u00b5')
    .replace(/\u2126/g, '\u03a9');
}

/** One factor of a compound: a symbol and its power. */
type Part = { label: string; power: number; meaning: Meaning };

/**
 * Parses a compound unit. After a slash, every factor up to the next slash
 * divides (W/m²·K is W/(m²·K)), as engineers read it.
 */
function parseCompound(text: string): Part[] | undefined {
  let at = 0;
  const peek = () => text[at] ?? '';
  const skipSpaces = () => {
    while (peek() === ' ') at++;
  };
  function power(): number | undefined {
    if (peek() === '^') {
      at++;
      const match = /^-?\d+/.exec(text.slice(at));
      if (!match) return undefined;
      at += match[0].length;
      return Number(match[0]);
    }
    let sign = 1;
    let digits = '';
    if (peek() === '⁻') {
      sign = -1;
      at++;
    }
    while (SUPERSCRIPT.includes(peek()) && peek()) {
      digits += SUPERSCRIPT.indexOf(peek());
      at++;
    }
    if (!digits) {
      if (sign < 0) return undefined;
      while (/\d/.test(peek())) digits += text[at++];
      return digits ? Number(digits) : 1;
    }
    return sign * Number(digits);
  }
  function factor(): Part[] | undefined {
    skipSpaces();
    if (peek() === '(') {
      at++;
      const inner = expression();
      skipSpaces();
      if (!inner || peek() !== ')') return undefined;
      at++;
      const p = power();
      if (p === undefined || p === 0) return undefined;
      return inner.map((part) => ({ ...part, power: part.power * p }));
    }
    if (peek() === '1' && !/\d/.test(text[at + 1] ?? '')) {
      at++;
      return [];
    }
    const joined = JOINED.find((label) => {
      if (!text.startsWith(label, at)) return false;
      const next = text[at + label.length] ?? '';
      return !next || STOP.test(next);
    });
    let symbol: string;
    if (joined) {
      symbol = joined;
      at += joined.length;
    } else {
      const start = at;
      while (at < text.length && !STOP.test(peek())) at++;
      symbol = text.slice(start, at);
    }
    if (!symbol) return undefined;
    const meaning = symbolMeaning(symbol);
    if (!meaning) return undefined;
    const p = power();
    if (p === undefined || p === 0) return undefined;
    return [{ label: meaning.label, power: p, meaning }];
  }
  function product(): Part[] | undefined {
    const parts = factor();
    if (!parts) return undefined;
    for (;;) {
      const save = at;
      skipSpaces();
      // A space alone also multiplies: “kg m/s”.
      if (peek() && SEPARATOR.test(peek())) at++;
      else if (at === save || !peek() || peek() === '/' || peek() === ')') {
        at = save;
        return parts;
      }
      const next = factor();
      if (!next) return undefined;
      parts.push(...next);
    }
  }
  function expression(): Part[] | undefined {
    const parts = product();
    if (!parts) return undefined;
    for (;;) {
      skipSpaces();
      if (peek() !== '/') return parts;
      at++;
      const divisor = product();
      if (!divisor) return undefined;
      parts.push(...divisor.map((part) => ({ ...part, power: -part.power })));
    }
  }
  const parts = expression();
  skipSpaces();
  return parts && at === text.length ? parts : undefined;
}

/** A single symbol: a registered label, a base symbol, or prefix + base. */
function symbolMeaning(symbol: string): Meaning | undefined {
  const entry = LABELS.get(symbol)?.find((item) => !item.family.isolated);
  if (entry)
    return {
      label: entry.unit.label,
      factor: entry.unit.factor,
      // Inside a compound a temperature is a difference: no offset.
      offset: 0,
      dims: entry.family.dims,
      family: entry.family,
    };
  const base = PREFIXABLE[symbol];
  if (base)
    return {
      label: symbol,
      factor: base.factor,
      offset: 0,
      dims: base.dims,
      family: FAMILIES.find((family) => family.name === base.family),
    };
  for (const [prefix, scale] of Object.entries(PREFIXES)) {
    if (!symbol.startsWith(prefix)) continue;
    const rest = PREFIXABLE[symbol.slice(prefix.length)];
    if (rest)
      return {
        label: `${prefix === 'u' ? 'µ' : prefix}${symbol.slice(prefix.length)}`,
        factor: scale * rest.factor,
        offset: 0,
        dims: rest.dims,
        family: FAMILIES.find((family) => family.name === rest.family),
      };
  }
  return undefined;
}

const power = (exponent: number) =>
  exponent === 1
    ? ''
    : exponent === 2
      ? '²'
      : exponent === 3
        ? '³'
        : `^${exponent}`;

/** Writes parts as `a·b/(c·d²)`, merging repeated symbols. */
function formatParts(parts: Part[]) {
  const merged = new Map<string, number>();
  for (const part of parts)
    merged.set(part.label, (merged.get(part.label) ?? 0) + part.power);
  const top: string[] = [];
  const bottom: string[] = [];
  // N·m stays one factor on top (N·m/s); below a slash it needs brackets.
  const wrap = (label: string, exponent: number, below: boolean) =>
    `${/\//.test(label) || (/·/.test(label) && (below || exponent !== 1)) ? `(${label})` : label}${power(exponent)}`;
  for (const [label, exponent] of merged) {
    if (exponent > 0) top.push(wrap(label, exponent, false));
    if (exponent < 0) bottom.push(wrap(label, -exponent, true));
  }
  const numerator = top.join('·') || '1';
  if (!bottom.length) return numerator;
  return `${numerator}/${bottom.length > 1 ? `(${bottom.join('·')})` : bottom[0]}`;
}

/** Every meaning of a label: usually one; "g" is a mass and an acceleration. */
function meanings(label: string): Meaning[] {
  const text = normalise(label);
  if (!text) return [];
  const registered = LABELS.get(text);
  if (registered)
    return registered.map(({ family, unit }) => ({
      label: unit.label,
      factor: unit.factor,
      offset: unit.offset ?? 0,
      dims: family.dims,
      family,
    }));
  const symbol = symbolMeaning(text);
  if (symbol) return [symbol];
  const parts = parseCompound(text);
  if (!parts) return [];
  let factor = 1;
  const total = [...dims()];
  for (const part of parts) {
    factor *= part.meaning.factor ** part.power;
    part.meaning.dims.forEach((value, i) => (total[i] += value * part.power));
  }
  const formatted = formatParts(parts);
  // A compound that is a registered unit (m/s/s) reads as that unit.
  const known = LABELS.get(formatted);
  if (known)
    return meanings(formatted).filter((item) => sameDims(item.dims, total));
  return [
    {
      label: formatted,
      factor,
      offset: 0,
      dims: total,
      family: FAMILIES.find(
        (family) => !family.isolated && sameDims(family.dims, total),
      ),
    },
  ];
}

const convertible = (a: Meaning, b: Meaning) =>
  a.family?.isolated || b.family?.isolated
    ? a.family === b.family
    : sameDims(a.dims, b.dims);

/** What a recognised unit is, for labels and status text. */
export type UnitInfo = {
  /** The label Stratum stores: aliases become their unit's label. */
  label: string;
  /** The quantity, such as “Pressure”, when Stratum names it. */
  quantity?: string;
};

/** Describes a unit Stratum recognises, or undefined. */
export function describeUnit(label: string): UnitInfo | undefined {
  const [first] = meanings(label);
  if (!first) return undefined;
  return {
    label: first.label,
    ...(first.family ? { quantity: first.family.name } : {}),
  };
}

/** True for a label Stratum recognises. */
export const isKnownUnit = (label: string) => meanings(label).length > 0;

/**
 * The label to store for a unit: a recognised label is written its standard
 * way (Nm → N·m, m/s^2 → m/s²); anything else is kept as it was.
 */
export function standardUnit(label: string) {
  return describeUnit(label)?.label ?? label.trim();
}

/** True when two labels name the same unit (Nm and N·m). */
export function sameUnit(a: string, b: string) {
  if (a.trim() === b.trim()) return true;
  const first = describeUnit(a);
  return !!first && first.label === describeUnit(b)?.label;
}

/** Units a label can be converted to, by family, excluding itself. */
export function conversionTargets(
  label: string,
): { family: string; units: string[] }[] {
  const result: { family: string; units: string[] }[] = [];
  for (const meaning of meanings(label)) {
    const families = meaning.family
      ? [meaning.family]
      : FAMILIES.filter(
          (family) => !family.isolated && sameDims(family.dims, meaning.dims),
        );
    for (const family of families) {
      const units = family.units
        .map((unit) => unit.label)
        .filter((unit) => unit !== meaning.label);
      if (units.length && !result.some((item) => item.family === family.name))
        result.push({ family: family.name, units });
    }
  }
  return result;
}

/**
 * The exact linear map from one unit to another, `out = in × factor +
 * offset`, or undefined when the units measure different quantities.
 */
export function unitConversion(
  from: string,
  to: string,
): { factor: number; offset: number } | undefined {
  for (const source of meanings(from))
    for (const target of meanings(to)) {
      if (!convertible(source, target)) continue;
      const factor = source.factor / target.factor;
      const offset = (source.offset - target.offset) / target.factor;
      return { factor, offset };
    }
  return undefined;
}

/** Recognised units grouped by quantity, for unit pickers. */
export const UNIT_GROUPS: readonly { family: string; units: string[] }[] =
  FAMILIES.map((family) => ({
    family: family.name,
    units: family.units.map((unit) => unit.label),
  }));

/** Labels files use for “no unit”. */
const NO_UNIT = /^(-+|—|–|none|n\/a|na|null)$/i;

/**
 * Likely fixes for a label Stratum does not recognise: another case or
 * spacing of a known unit, a temperature written without its degree sign, or
 * no unit for placeholders such as “-”. Empty when nothing is close.
 */
export function unitSuggestions(label: string): string[] {
  const text = normalise(label);
  if (!text || isKnownUnit(text)) return [];
  if (NO_UNIT.test(text)) return [''];
  const found: string[] = [];
  const add = (candidate: string) => {
    const unit = standardUnit(candidate);
    if (isKnownUnit(unit) && !found.includes(unit)) found.push(unit);
  };
  if (/^(deg\.?\s?|°\s)?[CF]$/i.test(text))
    add(`°${text.slice(-1).toUpperCase()}`);
  const squeezed = text.replace(/\s+/g, '');
  if (squeezed !== text) add(squeezed);
  const lower = text.toLowerCase();
  for (const key of LABELS.keys())
    if (
      key.toLowerCase() === lower ||
      key.toLowerCase() === squeezed.toLowerCase()
    )
      add(key);
  return found.slice(0, 3);
}

/** The label imports store when a file names no unit. */
export const UNSTATED_UNIT = '—';

/**
 * Why a signal cannot be imported with this unit, or undefined. A unit must
 * be one Stratum recognises, '' (no unit) or a label the user chose to keep
 * as a custom unit; an unstated unit ('—') must be chosen.
 */
export function importUnitProblem(
  name: string,
  unit: string,
  custom: readonly string[] = [],
): string | undefined {
  const label = unit.trim();
  if (label === UNSTATED_UNIT)
    return `“${name}” has no unit. Choose its unit, or No unit.`;
  if (label.length > 40) return `The unit of “${name}” is too long.`;
  if (!label || isKnownUnit(label) || custom.includes(label)) return undefined;
  return `Stratum does not recognise “${label}”, the unit of “${name}”. Choose a unit it knows, No unit, or keep “${label}” as a custom unit.`;
}
