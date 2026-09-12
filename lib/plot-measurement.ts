import type { Point, SeriesChunk } from './signal-types';

export type PlotMeasurement = {
  id: string;
  a: Point | null;
  b: Point | null;
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  rms: number | null;
  integral: number | null;
};

/** One streaming pass; no envelope values or interpolation in measurements. */
export async function measurePlot(
  id: string,
  chunks: AsyncIterable<SeriesChunk>,
  a: number,
  b: number,
  check: () => void = () => {},
): Promise<PlotMeasurement> {
  if (!Number.isFinite(a) || !Number.isFinite(b))
    throw new Error('Cursor times must be finite.');
  const low = Math.min(a, b),
    high = Math.max(a, b);
  const result: PlotMeasurement = {
    id,
    a: null,
    b: null,
    count: 0,
    min: null,
    max: null,
    mean: null,
    rms: null,
    integral: null,
  };
  let start = Infinity,
    end = -Infinity,
    mean = 0,
    rms = 0,
    integral = 0;
  let previous: Point | undefined;
  for await (const chunk of chunks) {
    check();
    for (let i = 0; i < chunk.time.length; i++) {
      const t = chunk.time[i],
        y = chunk.values[i];
      start = Math.min(start, t);
      end = Math.max(end, t);
      // First sample wins equal-distance ties, including missing samples.
      if (!result.a || Math.abs(t - a) < Math.abs(result.a[0] - a))
        result.a = [t, y];
      if (!result.b || Math.abs(t - b) < Math.abs(result.b[0] - b))
        result.b = [t, y];
      if (t < low || t > high || !Number.isFinite(y)) {
        previous = undefined;
        continue;
      }
      result.count++;
      const n = result.count;
      mean = mean * ((n - 1) / n) + y / n;
      rms = Math.hypot(rms * Math.sqrt((n - 1) / n), y / Math.sqrt(n));
      result.min = Math.min(result.min ?? Infinity, y);
      result.max = Math.max(result.max ?? -Infinity, y);
      if (previous && t > previous[0])
        integral += (y / 2 + previous[1] / 2) * (t - previous[0]);
      previous = [t, y];
    }
  }
  if (a < start || a > end) result.a = null;
  if (b < start || b > end) result.b = null;
  if (result.count) Object.assign(result, { mean, rms, integral });
  return result;
}
