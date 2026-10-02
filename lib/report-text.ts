import type { ReportBlock } from './report-mockup';

export const REPORT_FONTS = {
  sans: 'Arial, Helvetica, sans-serif',
  serif: 'Georgia, Times New Roman, serif',
  mono: 'Courier New, Courier, monospace',
};

export type ReportTextStyle = Pick<ReportBlock, 'fontFamily' | 'fontSize'> & {
  bold?: boolean;
  letterSpacing?: number;
};

/** Approximate width; report pages are SVG strings that cannot measure text. */
export function estimateTextWidth(
  value: string,
  style: ReportTextStyle,
): number {
  const spacing = (style.letterSpacing ?? 0) * value.length;
  if (style.fontFamily === 'mono')
    return value.length * style.fontSize * 0.61 + spacing;
  let width = 0;
  for (const character of value) {
    width += /[ilI1.,' :;!|]/.test(character)
      ? 0.28
      : /[MW@%]/.test(character)
        ? 0.88
        : /[A-Z0-9]/.test(character)
          ? 0.63
          : 0.53;
  }
  return width * style.fontSize * (style.bold ? 1.055 : 1) + spacing;
}

/** Greedy word wrap, breaking words that are wider than a whole line. */
export function wrapTextLines(
  value: string,
  width: number,
  style: ReportTextStyle,
): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split('\n')) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (estimateTextWidth(next, style) <= width) {
        current = next;
        continue;
      }
      if (current) {
        lines.push(current);
        current = '';
      }
      for (const character of word) {
        if (current && estimateTextWidth(current + character, style) > width) {
          lines.push(current);
          current = '';
        }
        current += character;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/** Shorten one line with an ellipsis so it fits the given width. */
export function fitTextLine(
  value: string,
  width: number,
  style: ReportTextStyle,
): string {
  if (estimateTextWidth(value, style) <= width) return value;
  // Whole graphemes, so an ellipsis never splits an accent or emoji.
  const characters = Array.from(
    new Intl.Segmenter().segment(value),
    (part) => part.segment,
  );
  while (
    characters.length &&
    estimateTextWidth(`${characters.join('')}…`, style) > width
  )
    characters.pop();
  return characters.length ? `${characters.join('').trimEnd()}…` : '';
}
