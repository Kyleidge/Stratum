import { formatNumber } from './workflow-checks';

/**
 * Report text for a calculated value. Ordinary magnitudes use the Data
 * Inspector value tiles' format (`formatValue(value, 3)`: grouped digits, three
 * decimals); tiny or huge magnitudes keep four significant digits so they never
 * collapse to `0.000`. Exact values stay in the Values CSV export.
 */
export function formatReportValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Unavailable';
  const magnitude = Math.abs(value);
  if (value !== 0 && (magnitude < 0.01 || magnitude >= 1e12))
    return formatNumber(value);
  return value.toLocaleString('en-GB', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

/** An unambiguous capture time, such as `6 Oct 2026, 14:03`. */
export function formatCaptureTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'an unknown time';
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A safe download name: letters, digits, spaces and `._-·` only. */
export function safeFileName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N} ._\-·]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return cleaned || fallback;
}
