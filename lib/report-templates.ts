import {
  createBlock,
  pageDimensions,
  type ReportBlock,
  type ReportDocument,
  type ReportFrame,
  type ReportFrameStyle,
} from './report-mockup';
import { wrapTextLines } from './report-text';
import { randomId } from './random-id';

export interface ReportDesign {
  style: ReportFrameStyle;
  name: string;
  detail: string;
  accent: string;
}

/** Page designs offered as report templates, in gallery order. */
export const REPORT_DESIGNS: readonly ReportDesign[] = [
  {
    style: 'classic',
    name: 'Classic',
    detail: 'Double rules, serif type',
    accent: '#1f3b5c',
  },
  {
    style: 'drawing',
    name: 'Drawing sheet',
    detail: 'Zoned border, title block',
    accent: '#24527a',
  },
  {
    style: 'banner',
    name: 'Banner',
    detail: 'Colour band, modern type',
    accent: '#0f6a72',
  },
  {
    style: 'sidebar',
    name: 'Sidebar',
    detail: 'Accent stripe, airy layout',
    accent: '#b0462c',
  },
];

export const FRAME_ACCENTS: readonly { name: string; value: string }[] = [
  { name: 'Navy', value: '#1f3b5c' },
  { name: 'Blueprint', value: '#24527a' },
  { name: 'Teal', value: '#0f6a72' },
  { name: 'Forest', value: '#2f6b3a' },
  { name: 'Rust', value: '#b0462c' },
  { name: 'Plum', value: '#6b3fa0' },
  { name: 'Graphite', value: '#3a4148' },
];

/** Design accents are opaque six-digit colours so tints can be derived. */
export const FRAME_ACCENT = /^#[0-9a-fA-F]{6}$/;

export function reportDesign(style: ReportFrameStyle): ReportDesign {
  return (
    REPORT_DESIGNS.find((design) => design.style === style) ?? REPORT_DESIGNS[0]
  );
}

/** Switch designs, keeping an accent the user chose over the old default. */
export function switchFrame(
  current: ReportFrame | undefined,
  style: ReportFrameStyle,
): ReportFrame {
  const customised =
    current &&
    current.accent.toLowerCase() !== reportDesign(current.style).accent;
  return {
    style,
    accent: customised ? current.accent : reportDesign(style).accent,
  };
}

export interface PageInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Banner title pages carry a deeper band than continuation pages. */
export function bannerHeight(pageIndex: number): number {
  return pageIndex === 0 ? 132 : 64;
}

/**
 * The area a design leaves clear of its border, header and footer. New and
 * captured blocks are placed inside it; reports without a design keep 48 px.
 */
export function frameInsets(
  report: Pick<ReportDocument, 'frame'>,
  pageIndex = 0,
): PageInsets {
  switch (report.frame?.style) {
    case 'classic':
      return { top: 84, right: 56, bottom: 88, left: 56 };
    case 'drawing':
      return { top: 48, right: 48, bottom: 112, left: 48 };
    case 'banner':
      return {
        top: bannerHeight(pageIndex) + 32,
        right: 48,
        bottom: 72,
        left: 48,
      };
    case 'sidebar':
      return { top: 84, right: 48, bottom: 48, left: 66 };
    default:
      return { top: 48, right: 48, bottom: 48, left: 48 };
  }
}

/**
 * Blocks that reach into a design's border, header or footer on any page.
 * `tolerance` ignores blocks that only enter the clear margin around them.
 */
export function blocksOutsideFrame(
  report: ReportDocument,
  tolerance = 1,
): number {
  const { width, height } = pageDimensions(report);
  return report.pages.reduce((count, page, pageIndex) => {
    const insets = frameInsets(report, pageIndex);
    return (
      count +
      page.blocks.filter(
        (block) =>
          block.x < insets.left - tolerance ||
          block.y < insets.top - tolerance ||
          block.x + block.width > width - insets.right + tolerance ||
          block.y + block.height > height - insets.bottom + tolerance,
      ).length
    );
  }, 0);
}

/**
 * Moves (and, when necessary, shrinks) blocks that reach into a design's
 * border, header or footer back into its clear area. Used only on request.
 */
export function fitBlocksInsideFrame(
  report: ReportDocument,
  tolerance = 1,
): ReportDocument {
  const { width, height } = pageDimensions(report);
  return {
    ...report,
    pages: report.pages.map((page, pageIndex) => {
      const insets = frameInsets(report, pageIndex);
      const right = width - insets.right,
        bottom = height - insets.bottom;
      return {
        ...page,
        blocks: page.blocks.map((block) => {
          if (
            block.x >= insets.left - tolerance &&
            block.y >= insets.top - tolerance &&
            block.x + block.width <= right + tolerance &&
            block.y + block.height <= bottom + tolerance
          )
            return block;
          const blockWidth = Math.min(block.width, right - insets.left);
          const blockHeight = Math.min(block.height, bottom - insets.top);
          return {
            ...block,
            width: blockWidth,
            height: blockHeight,
            x: Math.min(Math.max(block.x, insets.left), right - blockWidth),
            y: Math.min(Math.max(block.y, insets.top), bottom - blockHeight),
          };
        }),
      };
    }),
  };
}

const INK = '#16222c';
const BODY = '#44535e';
const MUTED = '#6b7a86';
const SUBTITLE = 'A one-line summary of what was tested, and why.';
const SUMMARY =
  'Summarise the purpose of the test, how it was run and what it found. Drag signals, values and plots onto the page to build the results.';

/**
 * A new report with a page design and an editable title page. Starter text
 * uses neutral ink, so it stays legible when the design or accent changes.
 */
export function createTemplateReport(
  style: ReportFrameStyle,
  format: Pick<ReportDocument, 'pageSize' | 'orientation'> = {
    pageSize: 'a4',
    orientation: 'portrait',
  },
  options: { title?: string; date?: Date } = {},
): ReportDocument {
  const title = options.title?.trim() || 'Test report';
  const date = (options.date ?? new Date()).toLocaleDateString(undefined, {
    dateStyle: 'long',
  });
  const report: ReportDocument = {
    title,
    pageSize: format.pageSize,
    orientation: format.orientation,
    background: '#ffffff',
    frame: { style, accent: reportDesign(style).accent },
    pages: [],
  };
  const { width, height } = pageDimensions(report);
  const insets = frameInsets(report, 0);
  const left = insets.left;
  const span = width - insets.left - insets.right;
  const blocks: ReportBlock[] = [];
  let y =
    insets.top + { classic: 20, drawing: 8, banner: 0, sidebar: 12 }[style];
  const add = (
    name: string,
    blockHeight: number,
    text: string,
    patch: Partial<ReportBlock>,
    gap: number,
  ) => {
    blocks.push(
      createBlock('text', {
        name,
        x: left,
        y,
        width: span,
        height: blockHeight,
        text,
        color: INK,
        padding: 0,
        ...patch,
      }),
    );
    y += blockHeight + gap;
  };
  // The renderer's own wrapping, so the title block holds exactly its lines.
  const titleHeight = (patch: Partial<ReportBlock> & { fontSize: number }) => {
    const lines = wrapTextLines(title, span, {
      fontFamily: patch.fontFamily ?? 'sans',
      fontSize: patch.fontSize,
      bold: patch.bold,
    }).length;
    return Math.ceil(Math.min(3, lines) * patch.fontSize * 1.35) + 4;
  };
  const details = (
    blockHeight: number,
    patch: Partial<ReportBlock>,
    gap: number,
  ) => {
    const spacing = 12;
    const column = (span - spacing * 2) / 3;
    [
      ['Prepared by', 'Your name'],
      ['Date', date],
      ['Reference', 'TR-0001'],
    ].forEach(([label, value], index) =>
      blocks.push(
        createBlock('text', {
          name: label,
          x: left + index * (column + spacing),
          y,
          width: column,
          height: blockHeight,
          text: `${label.toUpperCase()}\n${value}`,
          fontSize: 11,
          color: INK,
          padding: 0,
          ...patch,
        }),
      ),
    );
    y += blockHeight + gap;
  };

  if (style === 'classic') {
    const serif = { fontFamily: 'serif', align: 'center' } as const;
    const heading = { fontFamily: 'serif', fontSize: 18, bold: true } as const;
    const titleStyle = { ...serif, fontSize: 40 };
    add(
      'Eyebrow',
      24,
      'Technical report',
      {
        ...serif,
        fontSize: 14,
        italic: true,
        color: MUTED,
      },
      8,
    );
    add('Title', titleHeight(titleStyle), title, titleStyle, 6);
    add(
      'Subtitle',
      26,
      SUBTITLE,
      {
        ...serif,
        fontSize: 15,
        italic: true,
        color: BODY,
      },
      12,
    );
    add(
      'Details',
      22,
      `Prepared by Your name   ·   ${date}   ·   Ref. TR-0001`,
      {
        ...serif,
        fontSize: 12,
        color: MUTED,
      },
      40,
    );
    add('Summary heading', 30, 'Summary', heading, 8);
    add(
      'Summary',
      72,
      SUMMARY,
      {
        fontFamily: 'serif',
        fontSize: 13,
        color: BODY,
      },
      28,
    );
    add('Results heading', 30, 'Results', heading, 0);
  } else if (style === 'drawing') {
    const heading = { fontSize: 15, bold: true } as const;
    const titleStyle = { fontSize: 34, bold: true };
    add(
      'Eyebrow',
      20,
      'TEST REPORT',
      {
        fontFamily: 'mono',
        fontSize: 11,
        bold: true,
        color: MUTED,
      },
      6,
    );
    add('Title', titleHeight(titleStyle), title, titleStyle, 4);
    add('Subtitle', 24, SUBTITLE, { fontSize: 14, color: BODY }, 20);
    details(
      46,
      {
        fontFamily: 'mono',
        fontSize: 10,
        padding: 8,
        borderWidth: 1,
        borderColor: '#c3ced6',
      },
      36,
    );
    add('Summary heading', 26, '1 Summary', heading, 8);
    add('Summary', 72, SUMMARY, { fontSize: 13, color: BODY }, 28);
    add('Results heading', 26, '2 Results', heading, 0);
  } else {
    const heading = { fontSize: 18, bold: true } as const;
    const titleStyle = { fontSize: 38, bold: true };
    add(
      'Eyebrow',
      20,
      'TEST REPORT',
      {
        fontSize: 11,
        bold: true,
        color: MUTED,
      },
      6,
    );
    add('Title', titleHeight(titleStyle), title, titleStyle, 4);
    add('Subtitle', 26, SUBTITLE, { fontSize: 15, color: BODY }, 22);
    if (style === 'banner')
      details(56, { padding: 12, radius: 8, fill: '#f2f5f7' }, 36);
    else details(32, {}, 40);
    add('Summary heading', 30, 'Summary', heading, 8);
    add('Summary', 72, SUMMARY, { fontSize: 13, color: BODY }, 28);
    add('Results heading', 30, 'Results', heading, 0);
  }
  return {
    ...report,
    pages: [
      {
        id: randomId(),
        // A very long title on a landscape page can push the last blocks off.
        blocks: blocks.filter(
          (block) => block.y + block.height <= height - insets.bottom,
        ),
      },
    ],
  };
}
