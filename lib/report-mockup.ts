export type ReportBlockType = 'text' | 'plot' | 'image' | 'table';

export interface ReportBlock {
  id: string;
  type: ReportBlockType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  fontFamily: 'sans' | 'serif' | 'mono';
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  color: string;
  fill: string;
  borderColor: string;
  borderWidth: number;
  radius: number;
  padding: number;
  opacity: number;
  accent: string;
  showGrid: boolean;
  showLegend: boolean;
  lineWidth: number;
  plot: 'power' | 'torque' | 'temperature';
  src: string;
  objectFit: 'cover' | 'contain';
  tableData: string[][];
  striped: boolean;
  source?: {
    kind: 'signal' | 'values' | 'plot' | 'checks';
    label: string;
    capturedAt: string;
    outputIds: string[];
    sourceNames: string[];
    timeReferences: string[];
  };
  signalPlot?: {
    points: [number, number | null][];
    unit: string;
    timeLabel: string;
    range: [number, number];
    label: string;
  };
  plotSnapshot?: { svg: string; width: number; height: number };
  /** Saved plot settings of a capture, so a report can become a template. */
  plotSheet?: import('./plot-scratchpad').PlotSheet;
}

export interface ReportPage {
  id: string;
  blocks: ReportBlock[];
}

export interface ReportDocument {
  title: string;
  pages: ReportPage[];
  pageSize: 'a4' | 'letter';
  orientation: 'portrait' | 'landscape';
  background: string;
}

const sampleIllustration = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="440" viewBox="0 0 720 440">
  <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#e7edf1"/><stop offset="1" stop-color="#f5f8fa"/></linearGradient><linearGradient id="case" x2="1" y2=".8"><stop stop-color="#788c9b"/><stop offset=".5" stop-color="#c1ccd3"/><stop offset="1" stop-color="#516779"/></linearGradient><linearGradient id="front" x2="1" y2="1"><stop stop-color="#e3e9ed"/><stop offset="1" stop-color="#7c909f"/></linearGradient></defs>
  <rect width="720" height="440" fill="url(#bg)"/>
  <path d="M0 340H720M0 370H720M0 400H720M110 300L50 440M240 300L220 440M370 300L390 440M500 300L560 440M630 300L720 440" stroke="#c8d5dc" stroke-width="1"/>
  <ellipse cx="366" cy="337" rx="217" ry="28" fill="#637b8e" opacity=".13"/>
  <path d="M202 290L166 326H482L508 290Z" fill="#526b7b"/><path d="M186 322H507V340H186Z" fill="#253f51"/>
  <path d="M236 157L414 120L480 164V275L301 310L236 267Z" fill="url(#case)"/>
  <path d="M236 157L414 120L480 164L302 207Z" fill="#ccd7de"/>
  <path d="M302 207L480 164V275L301 310Z" fill="#7991a3"/>
  <g stroke="#425e71" stroke-width="7"><path d="M322 208V300M344 203V296M366 197V291M388 192V287M410 187V282M432 182V278M454 177V274"/></g>
  <ellipse cx="270" cy="234" rx="53" ry="79" fill="url(#front)" stroke="#547080" stroke-width="3"/><ellipse cx="270" cy="234" rx="39" ry="61" fill="#6c8495"/><ellipse cx="270" cy="234" rx="26" ry="44" fill="#304d60"/>
  <path d="M186 221L265 207V249L186 264Z" fill="#a2b4c0"/><ellipse cx="186" cy="242" rx="14" ry="23" fill="#d4dfe5"/><ellipse cx="186" cy="242" rx="7" ry="12" fill="#75909f"/>
  <path d="M341 157V120L398 107L424 124V146L367 160Z" fill="#2c8290"/><path d="M341 120L398 107L424 124L367 138Z" fill="#73b0b6"/>
  <path d="M393 113V84C393 64 433 65 450 62L538 62" fill="none" stroke="#d2a54c" stroke-width="7" stroke-linecap="round"/>
  <rect x="520" y="38" width="77" height="56" rx="7" fill="#f8fafb" stroke="#c1cfd8"/><text x="558" y="62" font-family="Arial,sans-serif" font-size="10" fill="#536e7f" text-anchor="middle">TEST RIG</text><text x="558" y="80" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="#284756" text-anchor="middle">MTR-04</text>
  <circle cx="246" cy="181" r="4" fill="#e7eef2"/><circle cx="289" cy="287" r="4" fill="#e7eef2"/>
  <path d="M485 238H572V286" stroke="#25878c" stroke-width="2" fill="none"/><circle cx="485" cy="238" r="5" fill="#25878c"/><text x="574" y="307" font-family="Arial,sans-serif" font-size="12" fill="#3f6575" text-anchor="middle">DYNAMOMETER</text>
</svg>`;

export const SAMPLE_IMAGE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sampleIllustration)}`;

export function blockLabel(type: ReportBlockType): string {
  return { text: 'Text', plot: 'Plot', image: 'Image', table: 'Table' }[type];
}

export function pageDimensions(
  report: Pick<ReportDocument, 'pageSize' | 'orientation'>,
): { width: number; height: number } {
  const dimensions =
    report.pageSize === 'a4'
      ? { width: 794, height: 1123 }
      : { width: 816, height: 1056 };
  return report.orientation === 'landscape'
    ? { width: dimensions.height, height: dimensions.width }
    : dimensions;
}

export function createBlock(
  type: ReportBlockType,
  overrides: Partial<ReportBlock> = {},
): ReportBlock {
  const sizes = {
    text: { width: 320, height: 120 },
    plot: { width: 560, height: 300 },
    image: { width: 320, height: 210 },
    table: { width: 560, height: 180 },
  };
  return {
    id: crypto.randomUUID(),
    type,
    name: blockLabel(type),
    x: 48,
    y: 48,
    ...sizes[type],
    text:
      type === 'text'
        ? 'Add your story here.\nSelect this block to edit and format your text.'
        : type === 'plot'
          ? 'Power vs. speed'
          : type === 'table'
            ? 'Performance summary'
            : '',
    fontSize: type === 'text' ? 18 : 13,
    fontFamily: 'sans',
    bold: type === 'plot',
    italic: false,
    align: 'left',
    color: '#243746',
    fill: type === 'text' || type === 'image' ? 'transparent' : '#ffffff',
    borderColor: '#dce4e8',
    borderWidth: type === 'plot' || type === 'table' ? 1 : 0,
    radius: type === 'plot' || type === 'table' ? 8 : 0,
    padding: type === 'text' ? 4 : 18,
    opacity: 1,
    accent: '#167f8c',
    showGrid: true,
    showLegend: true,
    lineWidth: 3,
    plot: 'power',
    src: SAMPLE_IMAGE,
    objectFit: 'cover',
    tableData: [
      ['Metric', 'Measured', 'Target', 'Result'],
      ['Peak power', '82.4 kW', '80.0 kW', 'PASS'],
      ['Peak torque', '248 Nm', '240 Nm', 'PASS'],
      ['Efficiency', '94.2%', '> 92%', 'PASS'],
    ],
    striped: true,
    ...overrides,
  };
}

export function createBlankReport(): ReportDocument {
  return {
    title: 'Untitled report',
    pages: [{ id: 'blank-page', blocks: [] }],
    pageSize: 'a4',
    orientation: 'portrait',
    background: '#ffffff',
  };
}

export function createExampleReport(): ReportDocument {
  const text = (overrides: Partial<ReportBlock>) =>
    createBlock('text', overrides);
  return {
    title: 'Motor performance — Test summary',
    pageSize: 'a4',
    orientation: 'portrait',
    background: '#ffffff',
    pages: [
      {
        id: 'example-page',
        blocks: [
          text({
            name: 'Report eyebrow',
            x: 48,
            y: 40,
            width: 460,
            height: 24,
            text: 'STRATUM  /  ENGINEERING REPORT',
            fontSize: 11,
            bold: true,
            color: '#167f8c',
            padding: 0,
          }),
          text({
            name: 'Report title',
            x: 48,
            y: 90,
            width: 680,
            height: 108,
            text: 'Motor performance\nTest summary',
            fontSize: 39,
            bold: true,
            color: '#173447',
            padding: 0,
          }),
          text({
            name: 'Report introduction',
            x: 48,
            y: 208,
            width: 682,
            height: 57,
            text: 'A closer look at the MTR-04 motor across the operating range.\nSteady-state dynamometer sweep · 23 September 2026',
            fontSize: 14,
            color: '#667b88',
            padding: 0,
          }),
          text({
            name: 'Peak power',
            x: 48,
            y: 286,
            width: 222,
            height: 92,
            text: '82.4 kW\nPeak power',
            fontSize: 22,
            bold: true,
            fill: '#eff5f6',
            color: '#176a78',
            padding: 15,
            radius: 7,
          }),
          text({
            name: 'Peak torque',
            x: 286,
            y: 286,
            width: 222,
            height: 92,
            text: '248 Nm\nPeak torque',
            fontSize: 22,
            bold: true,
            fill: '#eff5f6',
            color: '#176a78',
            padding: 15,
            radius: 7,
          }),
          text({
            name: 'Efficiency',
            x: 524,
            y: 286,
            width: 222,
            height: 92,
            text: '94.2%\nPeak efficiency',
            fontSize: 22,
            bold: true,
            fill: '#eff5f6',
            color: '#176a78',
            padding: 15,
            radius: 7,
          }),
          createBlock('plot', {
            name: 'Power curve',
            x: 48,
            y: 400,
            width: 698,
            height: 290,
            text: 'Power across the operating range',
            plot: 'power',
            padding: 20,
            fontSize: 13,
            radius: 7,
          }),
          createBlock('image', {
            name: 'Motor test rig',
            x: 48,
            y: 712,
            width: 250,
            height: 178,
            padding: 0,
            radius: 7,
          }),
          text({
            name: 'Key findings',
            x: 320,
            y: 713,
            width: 426,
            height: 178,
            text: 'CONSISTENT BY DESIGN\n\nPower delivery remains stable through the mid-range, with peak output at 4,800 rpm. All measured targets were met.\n\nIllustrative test data for layout exploration.',
            fontSize: 14,
            color: '#415c6d',
            padding: 3,
          }),
          createBlock('table', {
            name: 'Performance summary',
            x: 48,
            y: 912,
            width: 698,
            height: 138,
            text: '',
            fontSize: 12,
            padding: 0,
            radius: 7,
          }),
          text({
            name: 'Report footer',
            x: 48,
            y: 1080,
            width: 610,
            height: 20,
            text: 'MTR-04  ·  LAB REPORT  /  ILLUSTRATIVE DATA',
            fontSize: 10,
            color: '#8295a0',
            padding: 0,
          }),
          text({
            name: 'Page number',
            x: 698,
            y: 1080,
            width: 48,
            height: 20,
            text: '01',
            fontSize: 10,
            color: '#8295a0',
            padding: 0,
            align: 'right',
          }),
        ].map((block, index) => ({
          ...block,
          id: `example-block-${index + 1}`,
        })),
      },
    ],
  };
}
