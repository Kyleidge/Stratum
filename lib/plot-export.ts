import { resolveColor, seriesColor } from './plot-scratchpad';

/**
 * Capture rendered panels with their computed styles and no transient cursor.
 * Theme tokens resolve to concrete colours, so the SVG stands alone.
 */
export function capturePlotSvg(
  host: HTMLElement,
  name: string,
  legend: { label: string; color: string }[] = [],
): { svg: string; width: number; height: number; background: string } {
  const charts = [...host.querySelectorAll<SVGSVGElement>('.signal-chart svg')];
  if (!charts.length) throw new Error('There is no rendered plot to export.');
  // Unit lanes share one clock label and sit together above their time axis.
  const continued = charts.map(
    (chart) =>
      !!chart
        .closest('.scratchpad-lane')
        ?.previousElementSibling?.classList.contains('scratchpad-lane'),
  );
  const ns = 'http://www.w3.org/2000/svg';
  const output = document.createElementNS(ns, 'svg');
  const width = Math.max(
    600,
    ...charts.map((chart) => chart.viewBox.baseVal.width),
  );
  const legendHeight =
    legend.length > 1
      ? Math.ceil(Math.min(30, legend.length) / 3) * 18 +
        (legend.length > 30 ? 18 : 0)
      : 0;
  const height =
    60 +
    legendHeight +
    charts.reduce(
      (sum, chart, i) =>
        sum + chart.viewBox.baseVal.height + (continued[i] ? 4 : 34),
      0,
    );
  output.setAttribute('xmlns', ns);
  output.setAttribute('width', String(width));
  output.setAttribute('height', String(height));
  output.setAttribute('viewBox', `0 0 ${width} ${height}`);
  // Export what is displayed: the current theme's surface and ink.
  const theme = getComputedStyle(host);
  const surface = theme.getPropertyValue('--surface').trim() || '#1a1a19';
  const ink = theme.getPropertyValue('--ink-1').trim() || '#f4f4f1';
  const font = theme.getPropertyValue('--font-ui').trim() || 'sans-serif';
  const background = document.createElementNS(ns, 'rect');
  background.setAttribute('width', '100%');
  background.setAttribute('height', '100%');
  background.setAttribute('fill', surface);
  output.appendChild(background);
  const text = (value: string, y: number, size = 12) => {
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', '14');
    label.setAttribute('y', String(y));
    label.setAttribute('fill', ink);
    label.setAttribute('font-family', font);
    label.setAttribute('font-size', String(size));
    label.textContent = value;
    output.appendChild(label);
  };
  text(name, 26, 17);
  if (legend.length > 1)
    legend.slice(0, 30).forEach((item, i) => {
      const group = document.createElementNS(ns, 'g');
      const x = ((i % 3) * width) / 3 + 14,
        y = 44 + Math.floor(i / 3) * 18;
      const swatch = document.createElementNS(ns, 'line');
      for (const [key, value] of Object.entries({
        x1: String(x),
        x2: String(x + 16),
        y1: String(y - 4),
        y2: String(y - 4),
        stroke: resolveColor(seriesColor(item.color), host),
        'stroke-width': '2',
      }))
        swatch.setAttribute(key, value);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(x + 22));
      label.setAttribute('y', String(y));
      label.setAttribute('fill', ink);
      label.setAttribute('font-size', '11');
      label.setAttribute('font-family', font);
      const limit = Math.floor((width / 3 - 38) / 6);
      label.textContent =
        item.label.length > limit
          ? `${item.label.slice(0, limit - 1)}…`
          : item.label;
      const title = document.createElementNS(ns, 'title');
      title.textContent = item.label;
      label.appendChild(title);
      group.appendChild(swatch);
      group.appendChild(label);
      output.appendChild(group);
    });
  if (legend.length > 30)
    text(`Legend: first 30 of ${legend.length} traces`, 40 + legendHeight);
  let y = 48 + legendHeight;
  for (const [i, original] of charts.entries()) {
    const label =
      original
        .closest('.scratchpad-stack')
        ?.querySelector('.scratchpad-axis-label') ??
      host.querySelector('.scratchpad-axis-label');
    if (continued[i]) y -= 30;
    else
      text(
        (label
          ? [...label.children]
              .map((part) => part.textContent?.trim())
              .filter(Boolean)
              .join(' · ') || label.textContent?.trim()
          : null) ??
          original.getAttribute('aria-label') ??
          '',
        y + 12,
      );
    const clone = original.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('x', '0');
    clone.setAttribute('y', String(y + 22));
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(original.viewBox.baseVal.height));
    clone.removeAttribute('style');
    clone.removeAttribute('tabindex');
    const originals = [original, ...original.querySelectorAll<SVGElement>('*')];
    const copies = [clone, ...clone.querySelectorAll<SVGElement>('*')];
    originals.forEach((element, i) => {
      const style = getComputedStyle(element);
      for (const property of [
        'fill',
        'stroke',
        'stroke-width',
        'stroke-dasharray',
        'stroke-linejoin',
        // Direct value labels draw a surface-coloured halo behind their text.
        'paint-order',
        'font-family',
        'font-size',
        'font-weight',
        'opacity',
      ])
        copies[i].style.setProperty(property, style.getPropertyValue(property));
    });
    clone
      .querySelectorAll('[data-plot-transient]')
      .forEach((node) => node.remove());
    output.appendChild(clone);
    y += original.viewBox.baseVal.height + 34;
  }
  return {
    svg: new XMLSerializer().serializeToString(output),
    width,
    height,
    background: surface,
  };
}

/** Standalone, local plot image. DOM text is escaped by XMLSerializer. */
export async function exportPlotImage(
  host: HTMLElement,
  name: string,
  format: 'svg' | 'png',
  legend: { label: string; color: string }[] = [],
): Promise<void> {
  const { svg, width, height } = capturePlotSvg(host, name, legend);
  const blob = new Blob([svg], {
    type: 'image/svg+xml;charset=utf-8',
  });
  let delivery = blob;
  if (format === 'png') {
    if (width * height > 32_000_000)
      throw new Error(
        'This image is too large for PNG. Export SVG or fewer stacked panels.',
      );
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context)
        throw new Error('Image rendering is unavailable. Export SVG instead.');
      context.drawImage(image, 0, 0);
      delivery = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error('Could not create PNG.')),
          'image/png',
        ),
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const url = URL.createObjectURL(delivery);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[^a-z0-9 ._-]/gi, '_').slice(0, 80) || 'Plot'}.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
