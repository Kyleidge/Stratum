import { pageDimensions, type ReportDocument } from '@/lib/report-mockup';
import {
  bannerHeight,
  FRAME_ACCENT,
  reportDesign,
} from '@/lib/report-templates';
import {
  fitTextLine,
  REPORT_FONTS,
  type ReportTextStyle,
} from '@/lib/report-text';

type FrameProps = {
  width: number;
  height: number;
  accent: string;
  background: string;
  title: string;
  pageIndex: number;
  pageCount: number;
  pageSize: ReportDocument['pageSize'];
};

const INK = '#18242e';
const MUTED = '#6b7a86';

/** Blend two six-digit colours, so each design needs only one accent. */
function mix(color: string, other: string, amount: number): string {
  const channels = (value: string) =>
    [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
  if (!FRAME_ACCENT.test(color) || !FRAME_ACCENT.test(other)) return color;
  const to = channels(other);
  return `#${channels(color)
    .map((channel, index) =>
      Math.round(channel + (to[index] - channel) * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

const diamond = (x: number, y: number, radius: number) =>
  `M${x} ${y - radius}L${x + radius} ${y}L${x} ${y + radius}L${x - radius} ${y}Z`;

function FrameText({
  x,
  y,
  text,
  width,
  style,
  fill,
  anchor = 'start',
  italic = false,
}: {
  x: number;
  y: number;
  text: string;
  width: number;
  style: ReportTextStyle;
  fill: string;
  anchor?: 'start' | 'middle' | 'end';
  italic?: boolean;
}) {
  return (
    <text
      x={x}
      y={y}
      fill={fill}
      fontFamily={REPORT_FONTS[style.fontFamily]}
      fontSize={style.fontSize}
      fontWeight={style.bold ? 700 : 400}
      fontStyle={italic ? 'italic' : 'normal'}
      letterSpacing={style.letterSpacing}
      textAnchor={anchor}
    >
      {fitTextLine(text, Math.max(0, width), style)}
    </text>
  );
}

function ClassicFrame(props: FrameProps) {
  const { width, height, accent, background, title } = props;
  const outer = 26;
  const inner = 32;
  const corner = (outer + inner) / 2;
  const centre = width / 2;
  const footer = height - 68;
  const text: ReportTextStyle = {
    fontFamily: 'serif',
    fontSize: 10.5,
    letterSpacing: 0.4,
  };
  return (
    <g>
      <rect
        x={outer}
        y={outer}
        width={width - outer * 2}
        height={height - outer * 2}
        fill="none"
        stroke={accent}
        strokeWidth={2}
      />
      <rect
        x={inner}
        y={inner}
        width={width - inner * 2}
        height={height - inner * 2}
        fill="none"
        stroke={accent}
        strokeWidth={0.75}
      />
      {[
        [corner, corner],
        [width - corner, corner],
        [corner, height - corner],
        [width - corner, height - corner],
      ].map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <rect
            x={x - 7}
            y={y - 7}
            width={14}
            height={14}
            fill={background}
            stroke={accent}
            strokeWidth={1}
          />
          <path d={diamond(x, y, 3.5)} fill={accent} />
        </g>
      ))}
      <g stroke={accent} strokeWidth={0.75}>
        <line x1={centre - 78} y1={58} x2={centre - 12} y2={58} />
        <line x1={centre + 12} y1={58} x2={centre + 78} y2={58} />
      </g>
      <path
        d={diamond(centre, 58, 5.5)}
        fill="none"
        stroke={accent}
        strokeWidth={1}
      />
      <path d={diamond(centre, 58, 2.2)} fill={accent} />
      <circle cx={centre - 84} cy={58} r={1.6} fill={accent} />
      <circle cx={centre + 84} cy={58} r={1.6} fill={accent} />
      <line
        x1={inner + 24}
        y1={footer}
        x2={width - inner - 24}
        y2={footer}
        stroke={accent}
        strokeOpacity={0.45}
        strokeWidth={0.75}
      />
      <FrameText
        x={inner + 24}
        y={footer + 18}
        text={title}
        width={width - (inner + 24) * 2 - 120}
        style={text}
        fill={accent}
        italic
      />
      <FrameText
        x={width - inner - 24}
        y={footer + 18}
        text={`Page ${props.pageIndex + 1} of ${props.pageCount}`}
        width={110}
        style={text}
        fill={accent}
        anchor="end"
      />
    </g>
  );
}

function DrawingFrame(props: FrameProps) {
  const { width, height, accent, background, title } = props;
  const outer = 14;
  const inner = 30;
  const band = (outer + inner) / 2;
  const columns = Math.max(2, Math.round((width - inner * 2) / 190));
  const rows = Math.max(2, Math.round((height - inner * 2) / 190));
  const zoneWidth = (width - inner * 2) / columns;
  const zoneHeight = (height - inner * 2) / rows;
  const blockWidth = Math.min(340, (width - inner * 2) * 0.5);
  const blockHeight = 66;
  const left = width - inner - blockWidth;
  const top = height - inner - blockHeight;
  const split = top + 36;
  const cell = blockWidth / 3;
  const zone: ReportTextStyle = { fontFamily: 'sans', fontSize: 8.5 };
  const caption: ReportTextStyle = {
    fontFamily: 'sans',
    fontSize: 6.5,
    bold: true,
    letterSpacing: 0.8,
  };
  return (
    <g>
      <rect
        x={outer}
        y={outer}
        width={width - outer * 2}
        height={height - outer * 2}
        fill="none"
        stroke={accent}
        strokeWidth={0.8}
      />
      <rect
        x={inner}
        y={inner}
        width={width - inner * 2}
        height={height - inner * 2}
        fill="none"
        stroke={accent}
        strokeWidth={1.8}
      />
      <g stroke={accent} strokeWidth={0.8}>
        {Array.from({ length: columns - 1 }, (_, index) => {
          const x = inner + (index + 1) * zoneWidth;
          return (
            <g key={`column-${index}`}>
              <line x1={x} y1={outer} x2={x} y2={inner} />
              <line x1={x} y1={height - inner} x2={x} y2={height - outer} />
            </g>
          );
        })}
        {Array.from({ length: rows - 1 }, (_, index) => {
          const y = inner + (index + 1) * zoneHeight;
          return (
            <g key={`row-${index}`}>
              <line x1={outer} y1={y} x2={inner} y2={y} />
              <line x1={width - inner} y1={y} x2={width - outer} y2={y} />
            </g>
          );
        })}
      </g>
      {/* Centring marks, as on a printed drawing sheet. */}
      <g stroke={accent} strokeWidth={1.6}>
        <line x1={width / 2} y1={outer} x2={width / 2} y2={inner + 8} />
        <line
          x1={width / 2}
          y1={height - outer}
          x2={width / 2}
          y2={height - inner - 8}
        />
        <line x1={outer} y1={height / 2} x2={inner + 8} y2={height / 2} />
        <line
          x1={width - outer}
          y1={height / 2}
          x2={width - inner - 8}
          y2={height / 2}
        />
      </g>
      {Array.from({ length: columns }, (_, index) => {
        const x = inner + (index + 0.5) * zoneWidth;
        return (
          <g key={`column-label-${index}`}>
            <FrameText
              x={x}
              y={band + 3}
              text={String(index + 1)}
              width={zoneWidth}
              style={zone}
              fill={accent}
              anchor="middle"
            />
            <FrameText
              x={x}
              y={height - band + 3}
              text={String(index + 1)}
              width={zoneWidth}
              style={zone}
              fill={accent}
              anchor="middle"
            />
          </g>
        );
      })}
      {Array.from({ length: rows }, (_, index) => {
        const y = inner + (index + 0.5) * zoneHeight + 3;
        // Drawing zones skip I and O, which read as digits.
        const letter = 'ABCDEFGHJKLMNPQRSTUVWXYZ'[index % 24];
        return (
          <g key={`row-label-${index}`}>
            <FrameText
              x={band}
              y={y}
              text={letter}
              width={inner - outer}
              style={zone}
              fill={accent}
              anchor="middle"
            />
            <FrameText
              x={width - band}
              y={y}
              text={letter}
              width={inner - outer}
              style={zone}
              fill={accent}
              anchor="middle"
            />
          </g>
        );
      })}
      <rect
        x={left}
        y={top}
        width={blockWidth}
        height={blockHeight}
        fill={background}
        stroke={accent}
        strokeWidth={1.4}
      />
      <g stroke={accent} strokeWidth={0.8}>
        <line x1={left} y1={split} x2={left + blockWidth} y2={split} />
        <line
          x1={left + cell}
          y1={split}
          x2={left + cell}
          y2={top + blockHeight}
        />
        <line
          x1={left + cell * 2}
          y1={split}
          x2={left + cell * 2}
          y2={top + blockHeight}
        />
      </g>
      <FrameText
        x={left + 7}
        y={top + 11}
        text="TITLE"
        width={60}
        style={caption}
        fill={accent}
      />
      <FrameText
        x={left + blockWidth - 7}
        y={top + 11}
        text="STRATUM"
        width={80}
        style={caption}
        fill={mix(accent, background, 0.45)}
        anchor="end"
      />
      <FrameText
        x={left + 7}
        y={top + 29}
        text={title}
        width={blockWidth - 14}
        style={{ fontFamily: 'sans', fontSize: 12, bold: true }}
        fill={INK}
      />
      {[
        ['SIZE', props.pageSize === 'a4' ? 'A4' : 'LETTER'],
        ['SCALE', 'NTS'],
        ['SHEET', `${props.pageIndex + 1} / ${props.pageCount}`],
      ].map(([label, value], index) => (
        <g key={label}>
          <FrameText
            x={left + index * cell + 7}
            y={split + 10}
            text={label}
            width={cell - 14}
            style={caption}
            fill={accent}
          />
          <FrameText
            x={left + index * cell + 7}
            y={top + blockHeight - 9}
            text={value}
            width={cell - 14}
            style={{ fontFamily: 'sans', fontSize: 10 }}
            fill={INK}
          />
        </g>
      ))}
    </g>
  );
}

function BannerFrame(props: FrameProps) {
  const { width, height, accent, title, pageIndex } = props;
  const band = bannerHeight(pageIndex);
  const slant = band * 0.7;
  return (
    <g>
      <rect width={width} height={band} fill={accent} />
      {[
        { from: width - 330, to: width - 236, opacity: 0.07 },
        { from: width - 206, to: width - 150, opacity: 0.1 },
      ].map(({ from, to, opacity }) => (
        <path
          key={from}
          d={`M${from} 0H${to}L${to - slant} ${band}H${from - slant}Z`}
          fill="#ffffff"
          fillOpacity={opacity}
        />
      ))}
      <path
        d={`M${width - 120} 0H${width}V${band}H${width - 120 - slant}Z`}
        fill="#ffffff"
        fillOpacity={0.14}
      />
      <rect
        y={band}
        width={width}
        height={5}
        fill={mix(accent, '#ffffff', 0.55)}
      />
      {/* The title page introduces the report itself; later pages repeat it. */}
      {pageIndex > 0 && (
        <FrameText
          x={48}
          y={band / 2 + 5}
          text={title}
          width={width - 48 - 360}
          style={{
            fontFamily: 'sans',
            fontSize: 13,
            bold: true,
            letterSpacing: 0.3,
          }}
          fill="#ffffff"
        />
      )}
      <line
        x1={48}
        y1={height - 52}
        x2={width - 48}
        y2={height - 52}
        stroke="#d6dde2"
        strokeWidth={0.8}
      />
      <rect x={48} y={height - 53.5} width={40} height={3} fill={accent} />
      <FrameText
        x={width - 48}
        y={height - 34}
        text={`Page ${pageIndex + 1} of ${props.pageCount}`}
        width={140}
        style={{ fontFamily: 'sans', fontSize: 9.5 }}
        fill={MUTED}
        anchor="end"
      />
    </g>
  );
}

function SidebarFrame(props: FrameProps) {
  const { width, height, accent, title, pageIndex } = props;
  return (
    <g>
      <rect width={18} height={height} fill={accent} />
      <rect
        x={24}
        width={2.5}
        height={height}
        fill={accent}
        fillOpacity={0.35}
      />
      {pageIndex > 0 && (
        <FrameText
          x={66}
          y={46}
          text={title.toUpperCase()}
          width={width - 66 - 48 - 120}
          style={{
            fontFamily: 'sans',
            fontSize: 9.5,
            bold: true,
            letterSpacing: 1.2,
          }}
          fill="#5d6b75"
        />
      )}
      <FrameText
        x={width - 48}
        y={46}
        text={`Page ${pageIndex + 1} of ${props.pageCount}`}
        width={110}
        style={{ fontFamily: 'sans', fontSize: 9.5, letterSpacing: 0.4 }}
        fill="#8a97a0"
        anchor="end"
      />
      <line
        x1={66}
        y1={58}
        x2={width - 48}
        y2={58}
        stroke="#d9e0e4"
        strokeWidth={0.8}
      />
      <rect x={66} y={57} width={28} height={2} fill={accent} />
    </g>
  );
}

/**
 * A report's page design, drawn behind its blocks. The canvas, page previews
 * and PDF export share this artwork, so the export matches the editor.
 */
export function ReportFrameArt({
  report,
  pageIndex,
}: {
  report: ReportDocument;
  pageIndex: number;
}) {
  const frame = report.frame;
  if (!frame) return null;
  const { width, height } = pageDimensions(report);
  const props: FrameProps = {
    width,
    height,
    accent: FRAME_ACCENT.test(frame.accent)
      ? frame.accent
      : reportDesign(frame.style).accent,
    background: FRAME_ACCENT.test(report.background)
      ? report.background
      : '#ffffff',
    title: report.title.trim() || 'Untitled report',
    pageIndex: Math.max(0, pageIndex),
    pageCount: Math.max(1, report.pages.length),
    pageSize: report.pageSize,
  };
  switch (frame.style) {
    case 'classic':
      return <ClassicFrame {...props} />;
    case 'drawing':
      return <DrawingFrame {...props} />;
    case 'banner':
      return <BannerFrame {...props} />;
    case 'sidebar':
      return <SidebarFrame {...props} />;
    default:
      return null;
  }
}
