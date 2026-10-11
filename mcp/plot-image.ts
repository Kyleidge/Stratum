/**
 * A quick PNG of engine plots (min/max envelopes) so a model can look at a
 * signal without the UI: one lane per unit sharing the time axis. Envelope
 * points are drawing candidates only, never samples.
 */
import { createRequire } from 'node:module';
import type { Plot } from '../lib/signal-types';
import { formatAxisTick, niceDomain, niceTicks } from '../lib/plot-ticks';

export type PlotSeries = { label: string; unit: string; plot: Plot };

// Fixed, high-contrast colours for a standalone image on a light ground.
const COLOURS = [
  '#1f6fd1',
  '#d1561f',
  '#1f9d55',
  '#9b3fd1',
  '#c2185b',
  '#00838f',
  '#8d6e00',
  '#455a64',
];

const escape = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!,
  );

export function plotSvg(
  series: PlotSeries[],
  options: { width?: number; laneHeight?: number; title?: string } = {},
) {
  const width = options.width ?? 960;
  const laneHeight = options.laneHeight ?? 220;
  const left = 78,
    right = 16,
    top = options.title ? 34 : 14,
    gap = 26,
    bottom = 40;
  const units = [...new Set(series.map((item) => item.unit))];
  const height = top + units.length * (laneHeight + gap) - gap + bottom;
  const points = series.flatMap((item) => item.plot.points);
  const times = points.map(([time]) => time).filter(Number.isFinite);
  const t0 = times.length ? Math.min(...times) : 0;
  const t1 = times.length ? Math.max(...times) : 1;
  const x = niceTicks(t0, t1 > t0 ? t1 : t0 + 1, 8);
  const xLo = t0,
    xHi = t1 > t0 ? t1 : t0 + 1;
  const plotWidth = width - left - right;
  const px = (time: number) => left + ((time - xLo) / (xHi - xLo)) * plotWidth;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="DejaVu Sans, Arial, sans-serif" font-size="11">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
  ];
  if (options.title)
    parts.push(
      `<text x="${left}" y="20" font-size="13" font-weight="bold" fill="#1b1f23">${escape(options.title)}</text>`,
    );
  units.forEach((unit, lane) => {
    const laneTop = top + lane * (laneHeight + gap);
    const members = series.filter((item) => item.unit === unit);
    const values = members
      .flatMap((item) => item.plot.points.map(([, value]) => value))
      .filter(Number.isFinite);
    const lo = values.length ? Math.min(...values) : 0;
    const hi = values.length ? Math.max(...values) : 1;
    const y = niceDomain(lo, hi > lo ? hi : lo + 1, 5);
    const py = (value: number) =>
      laneTop + laneHeight - ((value - y.lo) / (y.hi - y.lo)) * laneHeight;
    parts.push(
      `<rect x="${left}" y="${laneTop}" width="${plotWidth}" height="${laneHeight}" fill="none" stroke="#c9ced6"/>`,
    );
    for (const tick of y.ticks)
      parts.push(
        `<line x1="${left}" x2="${left + plotWidth}" y1="${py(tick)}" y2="${py(tick)}" stroke="#eceef2"/>`,
        `<text x="${left - 6}" y="${py(tick) + 4}" text-anchor="end" fill="#3d444d">${escape(formatAxisTick(tick, y.step))}</text>`,
      );
    for (const tick of x.ticks)
      parts.push(
        `<line x1="${px(tick)}" x2="${px(tick)}" y1="${laneTop}" y2="${laneTop + laneHeight}" stroke="#eceef2"/>`,
      );
    parts.push(
      `<text transform="translate(16 ${laneTop + laneHeight / 2}) rotate(-90)" text-anchor="middle" fill="#3d444d">${escape(unit || 'No unit')}</text>`,
    );
    members.forEach((item) => {
      const colour = COLOURS[series.indexOf(item) % COLOURS.length];
      // Gaps (non-finite values) break the line.
      const runs: string[] = [];
      let run = '';
      for (const [time, value] of item.plot.points) {
        if (!Number.isFinite(value) || !Number.isFinite(time)) {
          if (run) runs.push(run);
          run = '';
          continue;
        }
        run += `${run ? 'L' : 'M'}${px(time).toFixed(1)},${py(value).toFixed(1)}`;
      }
      if (run) runs.push(run);
      parts.push(
        `<path d="${runs.join('')}" fill="none" stroke="${colour}" stroke-width="1.3"/>`,
      );
    });
    members.forEach((item, position) =>
      parts.push(
        `<text x="${left + 8}" y="${laneTop + 16 + position * 14}" fill="${COLOURS[series.indexOf(item) % COLOURS.length]}" font-weight="bold">${escape(item.label)}</text>`,
      ),
    );
  });
  const axisY = height - bottom + 16;
  for (const tick of x.ticks)
    parts.push(
      `<text x="${px(tick)}" y="${axisY}" text-anchor="middle" fill="#3d444d">${escape(formatAxisTick(tick, x.step))}</text>`,
    );
  parts.push(
    `<text x="${left + plotWidth / 2}" y="${axisY + 16}" text-anchor="middle" fill="#3d444d">Time (s)</text>`,
    '</svg>',
  );
  return parts.join('');
}

/** The few sharp calls used here (its bundled typings resolve as unknown). */
type Sharp = (input: Buffer) => { png(): { toBuffer(): Promise<Buffer> } };

export async function plotPng(
  series: PlotSeries[],
  options: { width?: number; laneHeight?: number; title?: string } = {},
) {
  // Loaded on first use: the native module is slow to start.
  const sharp = createRequire(import.meta.url)('sharp') as Sharp;
  return sharp(Buffer.from(plotSvg(series, options)))
    .png()
    .toBuffer();
}
