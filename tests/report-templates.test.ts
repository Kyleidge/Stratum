import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBlankReport,
  createBlock,
  pageDimensions,
  type ReportDocument,
  type ReportFrame,
} from '../lib/report-mockup';
import {
  blocksOutsideFrame,
  createTemplateReport,
  fitBlocksInsideFrame,
  frameInsets,
  REPORT_DESIGNS,
  reportDesign,
  switchFrame,
} from '../lib/report-templates';
import {
  estimateTextWidth,
  fitTextLine,
  wrapTextLines,
} from '../lib/report-text';
import {
  readTemplate,
  templateFromReport,
  templateYaml,
} from '../lib/workflow-report-template';
import { parseYaml, stringifyYaml } from '../lib/workflow-yaml';

const fail = (message: string): never => {
  throw new Error(message);
};

void test('every template fits its title page inside the design on each paper format', () => {
  for (const design of REPORT_DESIGNS)
    for (const pageSize of ['a4', 'letter'] as const)
      for (const orientation of ['portrait', 'landscape'] as const) {
        const report = createTemplateReport(design.style, {
          pageSize,
          orientation,
        });
        const where = `${design.name} ${pageSize} ${orientation}`;
        assert.deepEqual(report.frame, {
          style: design.style,
          accent: design.accent,
        });
        assert.equal(report.pageSize, pageSize, where);
        assert.equal(report.orientation, orientation, where);
        assert.equal(report.pages.length, 1, where);
        assert.ok(report.pages[0].blocks.length >= 7, where);
        assert.equal(blocksOutsideFrame(report), 0, where);
        const { width, height } = pageDimensions(report);
        for (const block of report.pages[0].blocks) {
          assert.equal(block.type, 'text', where);
          assert.ok(block.x >= 0 && block.x + block.width <= width, where);
          assert.ok(block.y >= 0 && block.y + block.height <= height, where);
          // Each block shows all of its text, wrapped as the renderer wraps it.
          const lines = wrapTextLines(
            block.text,
            block.width - block.padding * 2,
            block,
          ).length;
          assert.ok(
            block.height >= lines * block.fontSize * 1.35 + block.padding * 2,
            `${where}: ${block.name}`,
          );
        }
        assert.equal(
          new Set(report.pages[0].blocks.map((block) => block.id)).size,
          report.pages[0].blocks.length,
        );
      }
});

void test('templates carry a chosen title and make room for a long one', () => {
  const titled = createTemplateReport('classic', undefined, {
    title: '  Rig 4 endurance  ',
    date: new Date(2026, 9, 2),
  });
  assert.equal(titled.title, 'Rig 4 endurance');
  assert.ok(
    titled.pages[0].blocks.some((block) => block.text === 'Rig 4 endurance'),
  );
  assert.equal(createTemplateReport('banner').title, 'Test report');

  const long = 'Very long endurance qualification '.repeat(5).trim();
  const crowded = createTemplateReport(
    'banner',
    { pageSize: 'letter', orientation: 'landscape' },
    { title: long },
  );
  const title = crowded.pages[0].blocks.find((block) => block.name === 'Title');
  assert.ok(title && title.height > title.fontSize * 1.35 * 2);
  assert.equal(blocksOutsideFrame(crowded), 0);
});

void test('page designs reserve their border, header and footer', () => {
  const plain = createBlankReport();
  assert.deepEqual(frameInsets(plain), {
    top: 48,
    right: 48,
    bottom: 48,
    left: 48,
  });
  const banner = { frame: { style: 'banner', accent: '#0f6a72' } } as const;
  assert.ok(frameInsets(banner, 0).top > frameInsets(banner, 1).top);
  for (const design of REPORT_DESIGNS) {
    const insets = frameInsets({
      frame: { style: design.style, accent: design.accent },
    });
    assert.ok(Object.values(insets).every((value) => value >= 48));
  }

  const report: ReportDocument = {
    ...plain,
    frame: { style: 'drawing', accent: '#24527a' },
    pages: [
      {
        id: 'page',
        blocks: [
          createBlock('text', { x: 48, y: 48, width: 200, height: 40 }),
          // Over the drawing sheet's title block.
          createBlock('text', { x: 500, y: 1040, width: 200, height: 40 }),
        ],
      },
    ],
  };
  assert.equal(blocksOutsideFrame(report), 1);
  // Entering only the clear margin around the artwork is tolerated.
  report.pages[0].blocks[0].x = 40;
  assert.equal(blocksOutsideFrame(report), 2);
  assert.equal(blocksOutsideFrame(report, 16), 1);
});

void test('switching designs keeps a chosen accent and follows default ones', () => {
  const classic: ReportFrame = {
    style: 'classic',
    accent: reportDesign('classic').accent,
  };
  assert.deepEqual(switchFrame(classic, 'banner'), {
    style: 'banner',
    accent: reportDesign('banner').accent,
  });
  assert.deepEqual(switchFrame({ ...classic, accent: '#123456' }, 'sidebar'), {
    style: 'sidebar',
    accent: '#123456',
  });
  assert.deepEqual(switchFrame(undefined, 'drawing'), {
    style: 'drawing',
    accent: reportDesign('drawing').accent,
  });
});

void test('frame text is shortened by whole characters to fit', () => {
  const style = { fontFamily: 'sans', fontSize: 10 } as const;
  assert.equal(fitTextLine('Short', 200, style), 'Short');
  const fitted = fitTextLine('Motor endurance qualification', 80, style);
  assert.ok(fitted.endsWith('…'));
  assert.ok(estimateTextWidth(fitted, style) <= 80);
  assert.equal(fitTextLine('Anything', 1, style), '');
  // A base letter and its combining accent are kept or dropped together.
  const accent = String.fromCharCode(0x301);
  const accented = fitTextLine(`e${accent}`.repeat(20), 60, style);
  assert.ok(accented.endsWith(`${accent}…`), accented);
});

void test('workflow report templates keep the page design', () => {
  const report = createTemplateReport('sidebar');
  report.frame = { style: 'sidebar', accent: '#2f6b3a' };
  const { template, problems } = templateFromReport(report, new Map(), []);
  assert.deepEqual(problems, []);
  assert.deepEqual(template.frame, report.frame);

  const yaml = templateYaml(template);
  assert.deepEqual(yaml.frame, { style: 'sidebar', accent: '#2f6b3a' });
  const read = readTemplate(parseYaml(stringifyYaml(yaml)).value, fail);
  assert.deepEqual(read, template);

  // Templates without a design serialise exactly as before.
  const plain = templateYaml({ ...template, frame: undefined });
  assert.ok(!('frame' in plain));
  assert.ok(!('frame' in readTemplate(plain, fail)));

  // A missing accent takes the design's default.
  assert.deepEqual(
    readTemplate({ ...yaml, frame: { style: 'classic' } }, fail).frame,
    { style: 'classic', accent: reportDesign('classic').accent },
  );
  for (const [frame, message] of [
    [{ style: 'ornate' }, /frame style must be one of/],
    [{ style: 'banner', accent: 'teal' }, /frame accent must be a colour/],
    [{ style: 'banner', accent: '#0f6a7280' }, /frame accent must be a colour/],
    [{ style: 'banner', border: 2 }, /Unknown frame setting "border"/],
    ['banner', /frame must be a mapping/],
  ] as const)
    assert.throws(() => readTemplate({ ...yaml, frame }, fail), message);
});

void test('Move inside fits overlapping blocks into the design clear area only on request', () => {
  const report: ReportDocument = {
    ...createBlankReport(),
    frame: { style: 'banner', accent: '#0f6a72' },
  };
  const { width, height } = pageDimensions(report);
  const inside = createBlock('text', { x: 60, y: 200, width: 200, height: 40 });
  const header = createBlock('text', { x: 0, y: 0, width: 300, height: 60 });
  const tall = createBlock('table', {
    x: 40,
    y: 100,
    width: width,
    height: height,
  });
  report.pages[0].blocks.push(inside, header, tall);
  assert.equal(blocksOutsideFrame(report, 16), 2);
  const fitted = fitBlocksInsideFrame(report, 16);
  assert.equal(blocksOutsideFrame(fitted), 0);
  assert.equal(fitted.pages[0].blocks[0], inside);
  const insets = frameInsets(report, 0);
  assert.deepEqual(
    [fitted.pages[0].blocks[1].x, fitted.pages[0].blocks[1].y],
    [insets.left, insets.top],
  );
  assert.equal(
    fitted.pages[0].blocks[2].width,
    width - insets.left - insets.right,
  );
  // The original draft is unchanged, so Undo can restore it.
  assert.equal(report.pages[0].blocks[1].y, 0);
});
