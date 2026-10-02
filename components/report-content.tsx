import { useId } from 'react';
import {
  pageDimensions,
  type ReportBlock,
  type ReportDocument,
  type ReportPage,
} from '@/lib/report-mockup';
import { formatAxisTick, niceDomain, niceTicks } from '@/lib/plot-ticks';
import {
  REPORT_FONTS as fontFamilies,
  wrapTextLines as wrapText,
} from '@/lib/report-text';
import { ReportFrameArt } from '@/components/report-frame';

function TextLines({
  block,
  text,
  x,
  y,
  width,
  height,
  bold = block.bold,
  color = block.color,
  align = block.align,
}: {
  block: ReportBlock;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  bold?: boolean;
  color?: string;
  align?: ReportBlock['align'];
}) {
  const lineHeight = block.fontSize * 1.35;
  const count = Math.max(0, Math.floor(height / lineHeight));
  const lines = wrapText(text, Math.max(1, width), { ...block, bold }).slice(
    0,
    count,
  );
  const textX =
    x + (align === 'center' ? width / 2 : align === 'right' ? width : 0);
  return (
    <text
      fill={color}
      fontSize={block.fontSize}
      fontFamily={fontFamilies[block.fontFamily]}
      fontWeight={bold ? 700 : 400}
      fontStyle={block.italic ? 'italic' : 'normal'}
      textAnchor={
        align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
      }
    >
      {lines.map((line, index) => (
        <tspan
          key={`${index}-${line}`}
          x={textX}
          y={y + block.fontSize + index * lineHeight}
        >
          {line || '\u00a0'}
        </tspan>
      ))}
    </text>
  );
}

function PlotContent({
  block,
  clipId,
}: {
  block: ReportBlock;
  clipId: string;
}) {
  const padding = block.padding;
  const chartLeft = padding + 39;
  const chartTop = padding + (block.showLegend ? 62 : 44);
  const chartWidth = Math.max(1, block.width - chartLeft - padding - 10);
  const chartHeight = Math.max(1, block.height - chartTop - padding - 33);
  const maximum =
    block.plot === 'power' ? 100 : block.plot === 'torque' ? 300 : 100;
  const unit =
    block.plot === 'power' ? 'kW' : block.plot === 'torque' ? 'Nm' : '°C';
  const seriesLabel =
    block.plot === 'power'
      ? 'Shaft power'
      : block.plot === 'torque'
        ? 'Motor torque'
        : 'Winding temperature';
  const values = Array.from({ length: 49 }, (_, index) => {
    const position = index / 48;
    if (block.plot === 'power') {
      return 8 + 80 * Math.sin(position * 1.62) - 10 * position ** 8;
    }
    if (block.plot === 'torque') {
      return 215 + 34 * Math.sin(position * 3.7) - 50 * position ** 3;
    }
    return 24 + 56 * (1 - Math.exp(-position * 2.7));
  });
  const points = values.map((value, index) => ({
    x: chartLeft + (index / (values.length - 1)) * chartWidth,
    y: chartTop + chartHeight * (1 - value / maximum),
  }));
  const line = points
    .map(
      (point, index) =>
        `${index ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
    )
    .join(' ');
  const fillPath = `${line} L${chartLeft + chartWidth} ${chartTop + chartHeight} L${chartLeft} ${chartTop + chartHeight} Z`;
  const labels = {
    ...block,
    fontSize: Math.min(block.fontSize, 11),
    bold: false,
  };
  const title = {
    ...block,
    fontSize: block.fontSize,
  };
  const xTicks = [0, 1500, 3000, 4500, 6000];
  return (
    <g>
      <defs>
        <clipPath id={`${clipId}-chart`}>
          <rect
            x={chartLeft}
            y={chartTop}
            width={chartWidth}
            height={chartHeight}
          />
        </clipPath>
        <linearGradient id={`${clipId}-area`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={block.accent} stopOpacity="0.18" />
          <stop offset="1" stopColor={block.accent} stopOpacity="0.015" />
        </linearGradient>
      </defs>
      <TextLines
        block={title}
        text={block.text}
        x={padding}
        y={padding}
        width={block.width - padding * 2}
        height={title.fontSize * 1.5}
      />
      {block.showLegend && (
        <g>
          <line
            x1={padding}
            y1={padding + 34}
            x2={padding + 19}
            y2={padding + 34}
            stroke={block.accent}
            strokeWidth={block.lineWidth}
            strokeLinecap="round"
          />
          <text
            x={padding + 26}
            y={padding + 38}
            fontSize={11}
            fontFamily={fontFamilies[block.fontFamily]}
            fill={block.color}
          >
            {seriesLabel}
          </text>
          <text
            x={block.width - padding}
            y={padding + 38}
            textAnchor="end"
            fontSize={10}
            fontFamily={fontFamilies[block.fontFamily]}
            fill={block.color}
            opacity="0.55"
          >
            Illustrative data
          </text>
        </g>
      )}
      {[0, 1, 2, 3, 4].map((tick) => {
        const y = chartTop + (tick / 4) * chartHeight;
        return (
          <g key={`y-${tick}`}>
            {block.showGrid && (
              <line
                x1={chartLeft}
                y1={y}
                x2={chartLeft + chartWidth}
                y2={y}
                stroke={block.color}
                strokeOpacity="0.1"
              />
            )}
            <text
              x={chartLeft - 9}
              y={y + 4}
              textAnchor="end"
              fontSize={labels.fontSize}
              fontFamily={fontFamilies[block.fontFamily]}
              fill={block.color}
              opacity="0.65"
            >
              {Math.round(maximum * (1 - tick / 4))}
            </text>
          </g>
        );
      })}
      {xTicks.map((tick, index) => {
        const x = chartLeft + (index / 4) * chartWidth;
        return (
          <g key={`x-${tick}`}>
            {block.showGrid && (
              <line
                x1={x}
                y1={chartTop}
                x2={x}
                y2={chartTop + chartHeight}
                stroke={block.color}
                strokeOpacity="0.07"
              />
            )}
            <text
              x={x}
              y={chartTop + chartHeight + 18}
              textAnchor="middle"
              fontSize={labels.fontSize}
              fontFamily={fontFamilies[block.fontFamily]}
              fill={block.color}
              opacity="0.65"
            >
              {block.plot === 'temperature'
                ? tick / 100
                : tick.toLocaleString('en-US')}
            </text>
          </g>
        );
      })}
      <g clipPath={`url(#${clipId}-chart)`}>
        <path d={fillPath} fill={`url(#${clipId}-area)`} />
        <path
          d={line}
          fill="none"
          stroke={block.accent}
          strokeWidth={block.lineWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <line
        x1={chartLeft}
        y1={chartTop + chartHeight}
        x2={chartLeft + chartWidth}
        y2={chartTop + chartHeight}
        stroke={block.color}
        strokeOpacity="0.2"
      />
      <text
        x={chartLeft - 10}
        y={chartTop - 8}
        textAnchor="end"
        fontSize={10}
        fontFamily={fontFamilies[block.fontFamily]}
        fill={block.color}
        opacity="0.65"
      >
        {unit}
      </text>
      <text
        x={chartLeft + chartWidth / 2}
        y={block.height - padding + 2}
        textAnchor="middle"
        fontSize={11}
        fontFamily={fontFamilies[block.fontFamily]}
        fill={block.color}
        opacity="0.65"
      >
        {block.plot === 'temperature' ? 'Time (s)' : 'Motor speed (rpm)'}
      </text>
    </g>
  );
}

/** The envelope carries evaluated timestamps and explicit gaps, never sample metrics. */
function SignalPlotContent({
  block,
  clipId,
}: {
  block: ReportBlock;
  clipId: string;
}) {
  const plot = block.signalPlot!;
  const fontSize = Math.max(9, block.fontSize - 2);
  const top = block.padding + block.fontSize * (block.showLegend ? 4.5 : 2.6);
  const height = Math.max(
    1,
    block.height - top - block.padding - fontSize * 3.6,
  );
  let low = Infinity;
  let high = -Infinity;
  for (const [, value] of plot.points) {
    if (value === null || !Number.isFinite(value)) continue;
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const hasData = Number.isFinite(low);
  if (!hasData) {
    low = 0;
    high = 1;
  }
  if (low === high) {
    const pad = Math.max(Math.abs(low) * 0.05, 0.000001);
    low -= pad;
    high += pad;
  }
  // Round 1/2/5 × 10ⁿ ticks, as in the workspace plots; the value axis is
  // extended outward so its ends fall on ticks.
  const valueAxis = niceDomain(low, high, 5);
  low = valueAxis.lo;
  high = valueAxis.hi;
  const yTicks = valueAxis.ticks.map((value) => ({
    value,
    label: formatAxisTick(value, valueAxis.step),
  }));
  const yLabels = yTicks.map((tick) => tick.label);
  const left =
    block.padding +
    Math.max(
      48,
      Math.min(
        block.width * 0.35,
        Math.max(...yLabels.map((label) => label.length)) * fontSize * 0.64 +
          12,
      ),
    );
  const width = Math.max(1, block.width - left - block.padding - 24);
  const start =
    plot.range[0] === plot.range[1] ? plot.range[0] - 0.5 : plot.range[0];
  const end =
    plot.range[0] === plot.range[1] ? plot.range[1] + 0.5 : plot.range[1];
  const x = (time: number) => left + ((time - start) / (end - start)) * width;
  const y = (value: number) =>
    top + height - ((value - low) / (high - low)) * height;
  const timeAxis = niceTicks(
    start,
    end,
    Math.max(3, Math.min(8, Math.floor(width / 110))),
  );
  let connected = false;
  const commands: string[] = [];
  for (const [time, value] of plot.points) {
    if (value === null || !Number.isFinite(value)) {
      connected = false;
      continue;
    }
    commands.push(
      `${connected ? 'L' : 'M'}${x(time).toFixed(3)} ${y(value).toFixed(3)}`,
    );
    connected = true;
  }
  const path = commands.join(' ');
  const singletons = plot.points.filter(
    (point, index) =>
      point[1] !== null &&
      (index === 0 || plot.points[index - 1][1] === null) &&
      (index === plot.points.length - 1 || plot.points[index + 1][1] === null),
  );
  return (
    <g
      fontFamily={fontFamilies[block.fontFamily]}
      fontStyle={block.italic ? 'italic' : 'normal'}
      fontWeight={block.bold ? 700 : 400}
    >
      <defs>
        <clipPath id={`${clipId}-signal`}>
          <rect x={left} y={top} width={width} height={height} />
        </clipPath>
      </defs>
      <TextLines
        block={block}
        text={block.text}
        x={block.padding}
        y={block.padding}
        width={block.width - block.padding * 2}
        height={block.fontSize * 1.5}
      />
      {block.showLegend && (
        <g>
          <line
            x1={block.padding}
            x2={block.padding + 20}
            y1={block.padding + block.fontSize * 2.8}
            y2={block.padding + block.fontSize * 2.8}
            stroke={block.accent}
            strokeWidth={block.lineWidth}
          />
          <TextLines
            block={{ ...block, fontSize }}
            text={plot.label}
            x={block.padding + 28}
            y={block.padding + block.fontSize * 2}
            width={block.width - block.padding * 2 - 28}
            height={fontSize * 1.5}
            align="left"
          />
        </g>
      )}
      {yTicks.map((tick) => (
        <g key={`y-${tick.value}`}>
          {block.showGrid && (
            <line
              x1={left}
              y1={y(tick.value)}
              x2={left + width}
              y2={y(tick.value)}
              stroke={block.color}
              strokeOpacity="0.12"
            />
          )}
          {hasData && (
            <text
              x={left - 8}
              y={y(tick.value) + fontSize / 3}
              textAnchor="end"
              fontSize={fontSize}
              fill={block.color}
            >
              {tick.label}
            </text>
          )}
        </g>
      ))}
      {timeAxis.ticks.map((time) => (
        <g key={`x-${time}`}>
          {block.showGrid && (
            <line
              x1={x(time)}
              y1={top}
              x2={x(time)}
              y2={top + height}
              stroke={block.color}
              strokeOpacity="0.08"
            />
          )}
          <text
            x={x(time)}
            y={top + height + fontSize * 1.7}
            textAnchor="middle"
            fontSize={fontSize}
            fill={block.color}
          >
            {formatAxisTick(time, timeAxis.step)}
          </text>
        </g>
      ))}
      <text
        x={left - 8}
        y={top - 9}
        textAnchor="end"
        fontSize={fontSize}
        fill={block.color}
      >
        {plot.unit}
      </text>
      <g clipPath={`url(#${clipId}-signal)`}>
        <path
          d={path}
          fill="none"
          stroke={block.accent}
          strokeWidth={block.lineWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {singletons.map(([time, value], index) => (
          <circle
            key={index}
            cx={x(time)}
            cy={y(value!)}
            r={Math.max(2, block.lineWidth)}
            fill={block.accent}
          />
        ))}
      </g>
      {!hasData && (
        <text
          x={left + width / 2}
          y={top + height / 2}
          textAnchor="middle"
          fontSize={fontSize}
          fill={block.color}
        >
          No finite samples
        </text>
      )}
      <TextLines
        block={{ ...block, fontSize }}
        text={plot.timeLabel}
        x={left}
        y={top + height + fontSize * 2.1}
        width={width}
        height={fontSize * 1.5}
        align="center"
      />
    </g>
  );
}

function TableContent({ block }: { block: ReportBlock }) {
  const columns = Math.max(1, ...block.tableData.map((row) => row.length));
  const titleHeight = block.text ? block.fontSize * 1.5 + 14 : 0;
  const top = block.padding + titleHeight;
  const width = Math.max(1, block.width - block.padding * 2);
  const height = Math.max(1, block.height - top - block.padding);
  const rows = Math.max(1, block.tableData.length);
  const rowHeight = height / rows;
  const cellWidth = width / columns;
  return (
    <g>
      {block.text && (
        <TextLines
          block={block}
          text={block.text}
          x={block.padding}
          y={block.padding}
          width={width}
          height={titleHeight}
          bold
        />
      )}
      {block.tableData.map((row, rowIndex) => (
        <g key={rowIndex}>
          {(rowIndex === 0 || (block.striped && rowIndex % 2 === 0)) && (
            <rect
              x={block.padding}
              y={top + rowIndex * rowHeight}
              width={width}
              height={rowHeight}
              fill={block.accent}
              fillOpacity={rowIndex === 0 ? 0.1 : 0.035}
            />
          )}
          {rowIndex > 0 && (
            <line
              x1={block.padding}
              y1={top + rowIndex * rowHeight}
              x2={block.padding + width}
              y2={top + rowIndex * rowHeight}
              stroke={block.borderColor}
              strokeWidth={Math.max(0.5, block.borderWidth)}
            />
          )}
          {Array.from({ length: columns }, (_, columnIndex) => (
            <TextLines
              key={columnIndex}
              block={block}
              text={row[columnIndex] ?? ''}
              x={block.padding + columnIndex * cellWidth + 12}
              y={
                top +
                rowIndex * rowHeight +
                Math.max(
                  3,
                  (rowHeight -
                    Math.min(
                      wrapText(
                        row[columnIndex] ?? '',
                        Math.max(1, cellWidth - 24),
                        { ...block, bold: rowIndex === 0 || block.bold },
                      ).length,
                      Math.max(
                        0,
                        Math.floor((rowHeight - 6) / (block.fontSize * 1.35)),
                      ),
                    ) *
                      block.fontSize *
                      1.35) /
                    2,
                )
              }
              width={Math.max(1, cellWidth - 24)}
              height={rowHeight - 6}
              bold={rowIndex === 0 || block.bold}
              color={
                rowIndex > 0 && row[columnIndex] === 'PASS'
                  ? block.accent
                  : block.color
              }
            />
          ))}
        </g>
      ))}
    </g>
  );
}

export function ReportBlockContent({ block }: { block: ReportBlock }) {
  const clipId = `report-block-${useId().replace(/:/g, '')}`;
  const inset = block.borderWidth / 2;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={block.width}
      height={block.height}
      viewBox={`0 0 ${block.width} ${block.height}`}
      fill="none"
      opacity={block.opacity}
      aria-hidden="true"
      style={{ display: 'block', overflow: 'hidden' }}
    >
      <defs>
        <clipPath id={clipId}>
          <rect width={block.width} height={block.height} rx={block.radius} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect
          width={block.width}
          height={block.height}
          fill={block.fill}
          rx={block.radius}
        />
        {block.type === 'text' && (
          <TextLines
            block={block}
            text={block.text}
            x={block.padding}
            y={block.padding}
            width={Math.max(1, block.width - block.padding * 2)}
            height={Math.max(1, block.height - block.padding * 2)}
          />
        )}
        {block.type === 'plot' &&
          (block.plotSnapshot ? (
            <image
              href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(block.plotSnapshot.svg)}`}
              x={block.padding}
              y={block.padding}
              width={Math.max(1, block.width - block.padding * 2)}
              height={Math.max(1, block.height - block.padding * 2)}
              preserveAspectRatio="xMidYMid meet"
            />
          ) : block.signalPlot ? (
            <SignalPlotContent block={block} clipId={clipId} />
          ) : (
            <PlotContent block={block} clipId={clipId} />
          ))}
        {block.type === 'table' && <TableContent block={block} />}
        {block.type === 'image' &&
          (block.src ? (
            <image
              href={block.src}
              x={block.padding}
              y={block.padding}
              width={Math.max(1, block.width - block.padding * 2)}
              height={Math.max(1, block.height - block.padding * 2)}
              preserveAspectRatio={
                block.objectFit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'
              }
            />
          ) : (
            <g>
              <rect
                x={block.padding}
                y={block.padding}
                width={Math.max(1, block.width - block.padding * 2)}
                height={Math.max(1, block.height - block.padding * 2)}
                fill="#f3f6f7"
                stroke="#a7b6bf"
                strokeDasharray="5 5"
              />
              <TextLines
                block={block}
                text="Upload an image"
                x={block.padding + 12}
                y={block.height / 2 - block.fontSize}
                width={Math.max(1, block.width - block.padding * 2 - 24)}
                height={block.fontSize * 1.5}
                align="center"
              />
            </g>
          ))}
      </g>
      {block.borderWidth > 0 && (
        <rect
          x={inset}
          y={inset}
          width={Math.max(0, block.width - block.borderWidth)}
          height={Math.max(0, block.height - block.borderWidth)}
          rx={Math.max(0, block.radius - inset)}
          stroke={block.borderColor}
          strokeWidth={block.borderWidth}
        />
      )}
    </svg>
  );
}

export function ReportPageSvg({
  report,
  page,
}: {
  report: ReportDocument;
  page: ReportPage;
}) {
  const { width, height } = pageDimensions(report);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      <rect width={width} height={height} fill={report.background} />
      <ReportFrameArt
        report={report}
        pageIndex={report.pages.findIndex((item) => item.id === page.id)}
      />
      {page.blocks.map((block) => (
        <g key={block.id} transform={`translate(${block.x} ${block.y})`}>
          <ReportBlockContent block={block} />
        </g>
      ))}
    </svg>
  );
}
