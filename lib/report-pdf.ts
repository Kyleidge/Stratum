import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportPageSvg } from '@/components/report-content';
import { pageDimensions, type ReportDocument } from './report-mockup';

/** One local JPEG image and its intended physical PDF page dimensions. */
export interface RasterPdfPage {
  jpeg: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
  widthPoints: number;
  heightPoints: number;
}

const encoder = new TextEncoder();

function pdfUnicode(value: string): string {
  let encoded = 'feff';
  for (let index = 0; index < value.length; index++)
    encoded += value.charCodeAt(index).toString(16).padStart(4, '0');
  return `<${encoded}>`;
}

/** Build a byte-safe PDF without sending report content to an external service. */
export function encodeRasterPdf(
  pages: readonly RasterPdfPage[],
  title: string,
): Uint8Array<ArrayBuffer> {
  if (!pages.length)
    throw new Error('Add a page before exporting your report.');
  const chunks: Uint8Array[] = [];
  const offsets = [0];
  let length = 0;
  const append = (value: string | Uint8Array) => {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    chunks.push(bytes);
    length += bytes.byteLength;
  };
  const object = (id: number, content: string) => {
    offsets[id] = length;
    append(`${id} 0 obj\n${content}\nendobj\n`);
  };
  append('%PDF-1.4\n');
  append(new Uint8Array([37, 226, 227, 207, 211, 10]));
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(
    2,
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages
      .map((_, index) => `${4 + index * 3} 0 R`)
      .join(' ')}] >>`,
  );
  object(
    3,
    `<< /Title ${pdfUnicode(title)} /Creator (Stratum report mockup) >>`,
  );
  pages.forEach((page, index) => {
    if (
      ![
        page.pixelWidth,
        page.pixelHeight,
        page.widthPoints,
        page.heightPoints,
      ].every((value) => Number.isFinite(value) && value > 0) ||
      !Number.isInteger(page.pixelWidth) ||
      !Number.isInteger(page.pixelHeight) ||
      !page.jpeg.length
    )
      throw new Error('The report contains an invalid page image.');
    const id = 4 + index * 3;
    const width = Number(page.widthPoints.toFixed(4));
    const height = Number(page.heightPoints.toFixed(4));
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`,
    );
    offsets[id + 1] = length;
    append(
      `${id + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.byteLength} >>\nstream\n`,
    );
    append(page.jpeg);
    append('\nendstream\nendobj\n');
    const drawing = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
    object(
      id + 2,
      `<< /Length ${encoder.encode(drawing).byteLength} >>\nstream\n${drawing}endstream`,
    );
  });
  const xrefOffset = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1))
    append(`${String(offset).padStart(10, '0')} 00000 n \n`);
  append(
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );
  const result = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    result.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return result;
}

async function loadPageImage(source: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(
    new Blob([source], { type: 'image/svg+xml;charset=utf-8' }),
  );
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      const timeout = window.setTimeout(() => {
        image.onload = null;
        image.onerror = null;
        image.src = '';
        reject(new Error('The report page took too long to render.'));
      }, 30000);
      image.onload = () => {
        window.clearTimeout(timeout);
        resolve(image);
      };
      image.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('A report page could not be rendered for export.'));
      };
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Rasterize the same page SVG used on the canvas, at 192 dpi for normal pages. */
export async function createReportPdf(report: ReportDocument): Promise<Blob> {
  if (!report.pages.length)
    throw new Error('Add a page before exporting your report.');
  await document.fonts.ready;
  const { width, height } = pageDimensions(report);
  const scale = Math.min(2, Math.sqrt(16_000_000 / (width * height)));
  const pages: RasterPdfPage[] = [];
  for (const page of report.pages) {
    const svg = renderToStaticMarkup(
      createElement(ReportPageSvg, { report, page }),
    );
    const image = await loadPageImage(svg);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(width * scale);
    canvas.height = Math.floor(height * scale);
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The report export canvas is unavailable.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const jpeg = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob
              ? resolve(blob)
              : reject(new Error('A report page could not be encoded.')),
          'image/jpeg',
          0.97,
        ),
      );
      pages.push({
        jpeg: new Uint8Array(await jpeg.arrayBuffer()),
        pixelWidth: canvas.width,
        pixelHeight: canvas.height,
        widthPoints: (width * 72) / 96,
        heightPoints: (height * 72) / 96,
      });
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  return new Blob([encodeRasterPdf(pages, report.title)], {
    type: 'application/pdf',
  });
}

export async function downloadReportPdf(report: ReportDocument): Promise<void> {
  const pdf = await createReportPdf(report);
  const url = URL.createObjectURL(pdf);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${
    report.title
      .replace(/[^\p{L}\p{N} ._-]/gu, '_')
      .trim()
      .slice(0, 120) || 'Stratum report'
  }.pdf`;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
