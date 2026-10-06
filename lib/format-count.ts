/**
 * Formats a count with its noun in agreeing number: `1 signal`, `3 signals`.
 * Pass `plural` for irregular nouns.
 */
export function formatCount(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}
