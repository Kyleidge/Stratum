'use client';

import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  Check,
  ChevronDown,
  Copy,
  Download,
  Eye,
  FilePlus2,
  FileText,
  GripVertical,
  ImagePlus,
  Italic,
  Layers,
  LayoutTemplate,
  Minus,
  Moon,
  MousePointer2,
  Plus,
  Redo2,
  Settings2,
  Sun,
  Table2,
  Trash2,
  Type,
  Undo2,
  Upload,
  Waves,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTheme } from '@/hooks/use-theme';
import {
  createBlankReport,
  createBlock,
  createExampleReport,
  pageDimensions,
  type ReportBlock,
  type ReportBlockType,
  type ReportDocument,
  type ReportFrameStyle,
} from '@/lib/report-mockup';
import {
  blocksOutsideFrame,
  createTemplateReport,
  FRAME_ACCENTS,
  frameInsets,
  REPORT_DESIGNS,
  reportDesign,
  switchFrame,
} from '@/lib/report-templates';
import { ReportBlockContent, ReportPageSvg } from '@/components/report-content';
import { ReportFrameArt } from '@/components/report-frame';
import { downloadReportPdf } from '@/lib/report-pdf';
import type {
  ReportBuilderHandle,
  ReportWorkspace,
} from '@/lib/report-integration';
import { WORKFLOW_DRAG_TYPE } from '@/lib/workflow-drag';
import {
  ReportDataLibrary,
  REPORT_ASSET_DRAG_TYPE,
} from '@/components/report-data-library';

const DRAG_TYPE = 'application/x-stratum-report-block';
const BLOCKS: {
  type: ReportBlockType;
  label: string;
  detail: string;
  icon: LucideIcon;
}[] = [
  {
    type: 'plot',
    label: 'Plot',
    detail: 'A signal, beautifully told',
    icon: Waves,
  },
  {
    type: 'text',
    label: 'Text',
    detail: 'Headings, notes & findings',
    icon: Type,
  },
  {
    type: 'image',
    label: 'Image',
    detail: 'Photos, diagrams & logos',
    icon: ImagePlus,
  },
  {
    type: 'table',
    label: 'Table',
    detail: 'The numbers that matter',
    icon: Table2,
  },
];
type History = {
  report: ReportDocument;
  past: ReportDocument[];
  future: ReportDocument[];
};
type Gesture = {
  pointerId: number;
  block: ReportBlock;
  startX: number;
  startY: number;
  mode: 'move' | 'resize';
  before: ReportDocument;
};
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function Tool({
  icon: Icon,
  label,
  active,
  children,
  ...props
}: {
  icon?: LucideIcon;
  label: string;
  active?: boolean;
  children?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn('rb-tool', active && 'is-active', props.className)}
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
    >
      {Icon && <Icon size={16} />}
      {children}
    </button>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="rb-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 2000,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Field label={label}>
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={draft ?? Math.round(value * 100) / 100}
        onChange={(event) => {
          setDraft(event.target.value);
          if (
            event.target.value !== '' &&
            Number.isFinite(event.target.valueAsNumber) &&
            event.target.valueAsNumber >= min &&
            event.target.valueAsNumber <= max &&
            event.target.valueAsNumber !== value
          )
            onChange(event.target.valueAsNumber);
        }}
        onBlur={() => {
          if (
            draft !== null &&
            draft.trim() &&
            Number.isFinite(Number(draft))
          ) {
            const committed = clamp(Number(draft), min, max);
            if (committed !== value) onChange(committed);
          }
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </Field>
  );
}
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <span className="rb-color-field">
        <input
          aria-label={label}
          type="color"
          value={value === 'transparent' ? '#ffffff' : value}
          onChange={(event) => onChange(event.target.value)}
        />
        <span>{value === 'transparent' ? 'None' : value.toUpperCase()}</span>
      </span>
    </Field>
  );
}

export default function ReportBuilderMockup({
  workspace,
  ref,
}: {
  workspace?: ReportWorkspace;
  ref?: Ref<ReportBuilderHandle>;
}) {
  const [history, setHistory] = useState<History>(() => ({
    report: workspace ? createBlankReport() : createExampleReport(),
    past: [],
    future: [],
  }));
  const { report } = history;
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [libraryTab, setLibraryTab] = useState<
    'data' | 'insert' | 'templates' | 'pages'
  >(workspace ? 'data' : 'insert');
  const [capturing, setCapturing] = useState(false);
  const captureRef = useRef<AbortController | null>(null);
  const currentRef = useRef({ report, workspace });
  // The editor shares the application's device-local theme.
  const [theme, setTheme] = useTheme();
  const [zoom, setZoom] = useState<number | null>(null);
  const [fitZoom, setFitZoom] = useState(0.65);
  const [snap, setSnap] = useState(true);
  const [preview, setPreview] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [gestureActive, setGestureActive] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageTarget = useRef<string | null>(null);
  const reportEpoch = useRef(0);
  const gesture = useRef<Gesture | null>(null);
  const { width, height } = pageDimensions(report);
  const scale = zoom ?? fitZoom;
  const shownPageIndex = Math.min(pageIndex, report.pages.length - 1);
  const page = report.pages[shownPageIndex];
  const insets = frameInsets(report, shownPageIndex);
  const selected = page.blocks.find((block) => block.id === selectedId);
  // Gallery previews follow the draft's paper, so a template keeps its format.
  const templatePreviews = useMemo(
    () =>
      REPORT_DESIGNS.map((design) =>
        createTemplateReport(design.style, {
          pageSize: report.pageSize,
          orientation: report.orientation,
        }),
      ),
    [report.pageSize, report.orientation],
  );

  useEffect(() => {
    currentRef.current = { report, workspace };
  }, [report, workspace]);
  useEffect(() => () => captureRef.current?.abort(), []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => {
      setFitZoom(clamp((entry.contentRect.width - 96) / width, 0.25, 1));
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [width, preview]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  function commit(
    next: ReportDocument | ((current: ReportDocument) => ReportDocument),
  ) {
    setHistory((current) => {
      const changed = typeof next === 'function' ? next(current.report) : next;
      return changed === current.report
        ? current
        : {
            report: changed,
            past: [...current.past.slice(-39), current.report],
            future: [],
          };
    });
  }
  function undo() {
    setHistory((current) => {
      const previous = current.past.at(-1);
      return previous
        ? {
            report: previous,
            past: current.past.slice(0, -1),
            future: [current.report, ...current.future],
          }
        : current;
    });
    setSelectedId(null);
  }
  function redo() {
    setHistory((current) =>
      current.future.length
        ? {
            report: current.future[0],
            past: [...current.past, current.report],
            future: current.future.slice(1),
          }
        : current,
    );
    setSelectedId(null);
  }
  function updateBlock(id: string, patch: Partial<ReportBlock>) {
    const next = {
      ...report,
      pages: report.pages.map((item) =>
        item.id === page.id
          ? {
              ...item,
              blocks: item.blocks.map((block) => {
                if (block.id !== id) return block;
                const changed = { ...block, ...patch };
                changed.width = clamp(changed.width, 48, width);
                changed.height = clamp(changed.height, 28, height);
                changed.x = clamp(changed.x, 0, width - changed.width);
                changed.y = clamp(changed.y, 0, height - changed.height);
                return changed;
              }),
            }
          : item,
      ),
    };
    commit(next);
  }
  function updateSelected(patch: Partial<ReportBlock>) {
    if (selected) updateBlock(selected.id, patch);
  }
  function addBlock(
    type: ReportBlockType,
    at?: { x: number; y: number },
    patch?: Partial<ReportBlock>,
  ) {
    if (workspace && type === 'plot' && !patch?.source) {
      setLibraryTab('data');
      setPreview(false);
      setNotice('Choose a signal or saved plot from Data Inspector.');
      return;
    }
    const defaults = workspace
      ? type === 'image'
        ? { src: '' }
        : type === 'table'
          ? {
              text: 'Table',
              tableData: [
                ['Column 1', 'Column 2', 'Column 3'],
                ['', '', ''],
              ],
            }
          : undefined
      : undefined;
    const block = createBlock(type, { ...defaults, ...patch });
    block.width = Math.min(block.width, width - 80);
    block.height = Math.min(block.height, height - 80);
    block.x = clamp(
      at?.x ?? insets.left + (page.blocks.length % 5) * 16,
      0,
      width - block.width,
    );
    block.y = clamp(
      at?.y ?? insets.top + 16 + (page.blocks.length % 5) * 32,
      0,
      height - block.height,
    );
    commit({
      ...report,
      pages: report.pages.map((item) =>
        item.id === page.id
          ? { ...item, blocks: [...item.blocks, block] }
          : item,
      ),
    });
    setSelectedId(block.id);
    setPreview(false);
    return block.id;
  }
  function cancelCapture() {
    captureRef.current?.abort();
    captureRef.current = null;
    setCapturing(false);
  }
  function insertBlocks(
    blocks: ReportBlock[],
    pageId: string,
    at?: { x: number; y: number },
  ) {
    if (!blocks.length || gesture.current) return;
    const inserted = blocks.map((block) => ({
      ...block,
      id: crypto.randomUUID(),
    }));
    const newPageIds = blocks.map(() => crypto.randomUUID());
    function place(current: ReportDocument) {
      const index = current.pages.findIndex((item) => item.id === pageId);
      if (index < 0) return { report: current, firstPage: 0 };
      const size = pageDimensions(current);
      const pages = current.pages.map((item) => ({
        ...item,
        blocks: [...item.blocks],
      }));
      let targetIndex = index;
      let area = frameInsets(current, index);
      let y =
        at?.y ??
        Math.max(
          area.top,
          ...pages[index].blocks.map((block) => block.y + block.height + 24),
        );
      let firstPage = index;
      inserted.forEach((source, blockIndex) => {
        const block = { ...source };
        block.width = Math.min(
          block.width,
          size.width - area.left - area.right,
        );
        block.height = Math.min(
          block.height,
          size.height - area.top - area.bottom,
        );
        if (
          y + block.height > size.height - area.bottom &&
          (!at || blockIndex > 0)
        ) {
          pages.push({ id: newPageIds[blockIndex], blocks: [] });
          targetIndex = pages.length - 1;
          area = frameInsets(current, targetIndex);
          y = area.top;
        }
        block.x = clamp(at?.x ?? area.left, 0, size.width - block.width);
        block.y = clamp(y, 0, size.height - block.height);
        pages[targetIndex].blocks.push(block);
        y = block.y + block.height + 24;
        if (blockIndex === 0) {
          firstPage = targetIndex;
        }
      });
      return { report: { ...current, pages }, firstPage };
    }
    // Async captures append to the latest draft, including edits made while waiting.
    commit((current) => place(current).report);
    setPageIndex(place(currentRef.current.report).firstPage);
    setSelectedId(inserted[0].id);
    setPreview(false);
    setNotice(
      `${blocks.length} ${blocks.length === 1 ? 'snapshot added' : 'snapshots added'} to report.`,
    );
  }
  function addBlocks(blocks: ReportBlock[]) {
    insertBlocks(blocks, page.id);
  }
  async function addAssets(ids: string[], at?: { x: number; y: number }) {
    if (!workspace || !ids.length || captureRef.current || workspace.busy)
      return;
    const controller = new AbortController();
    captureRef.current = controller;
    setCapturing(true);
    setLibraryTab('data');
    setPreview(false);
    const epoch = reportEpoch.current;
    const revision = workspace.revision;
    const pageId = page.id;
    try {
      const blocks = await workspace.resolveAssets(ids, controller.signal);
      if (controller.signal.aborted || epoch !== reportEpoch.current) return;
      if (revision !== currentRef.current.workspace?.revision) {
        setNotice('Workspace changed during capture. Add the item again.');
        return;
      }
      if (gesture.current) {
        setNotice('Finish moving the block, then add the item again.');
        return;
      }
      if (!currentRef.current.report.pages.some((item) => item.id === pageId)) {
        setNotice('The destination page was removed. Add the item again.');
        return;
      }
      insertBlocks(blocks, pageId, at);
    } catch (error) {
      if (!controller.signal.aborted)
        setNotice(
          error instanceof Error
            ? error.message
            : 'Could not capture report data.',
        );
    } finally {
      if (captureRef.current === controller) {
        captureRef.current = null;
        setCapturing(false);
      }
    }
  }

  function deleteSelected() {
    if (!selected) return;
    editorRef.current?.focus({ preventScroll: true });
    commit({
      ...report,
      pages: report.pages.map((item) =>
        item.id === page.id
          ? {
              ...item,
              blocks: item.blocks.filter((block) => block.id !== selected.id),
            }
          : item,
      ),
    });
    setSelectedId(null);
  }
  function duplicateSelected() {
    if (selected)
      addBlock(
        selected.type,
        { x: selected.x + 20, y: selected.y + 20 },
        { ...selected, id: crypto.randomUUID(), name: selected.name + ' copy' },
      );
  }
  function reorder(front: boolean) {
    if (!selected) return;
    const rest = page.blocks.filter((block) => block.id !== selected.id);
    commit({
      ...report,
      pages: report.pages.map((item) =>
        item.id === page.id
          ? {
              ...item,
              blocks: front ? [...rest, selected] : [selected, ...rest],
            }
          : item,
      ),
    });
  }
  function addPage() {
    commit({
      ...report,
      pages: [...report.pages, { id: crypto.randomUUID(), blocks: [] }],
    });
    setPageIndex(report.pages.length);
    setSelectedId(null);
    setLibraryTab('pages');
  }
  function deletePage() {
    if (report.pages.length < 2) return;
    commit({
      ...report,
      pages: report.pages.filter((item) => item.id !== page.id),
    });
    setPageIndex(Math.max(0, pageIndex - 1));
    setSelectedId(null);
  }
  function replaceReport(next: ReportDocument) {
    cancelCapture();
    reportEpoch.current++;
    commit(next);
    setPageIndex(0);
    setSelectedId(null);
    setPreview(false);
    setZoom(null);
  }
  function startFromTemplate(style: ReportFrameStyle) {
    // A title the user already typed carries over to the new title page.
    const title = report.title.trim();
    replaceReport(
      createTemplateReport(style, report, {
        title: title === createBlankReport().title ? undefined : title,
      }),
    );
    setNotice(
      `Started from the ${reportDesign(style).name} template. Undo restores your previous draft.`,
    );
  }
  function applyDesign(style: ReportFrameStyle | 'none') {
    if (style === (report.frame?.style ?? 'none')) return;
    if (style === 'none') {
      const { frame: _frame, ...plain } = report;
      void _frame;
      commit(plain);
      return;
    }
    const next = { ...report, frame: switchFrame(report.frame, style) };
    commit(next);
    // Designs keep about 16 px clear around their artwork.
    const overlapping = blocksOutsideFrame(next, 16);
    setNotice(
      overlapping
        ? `${reportDesign(style).name} page design applied. ${overlapping} ${overlapping === 1 ? 'block overlaps' : 'blocks overlap'} its border, header or footer.`
        : `${reportDesign(style).name} page design applied.`,
    );
  }
  function setFrameAccent(accent: string) {
    if (report.frame && accent !== report.frame.accent)
      commit({ ...report, frame: { ...report.frame, accent } });
  }
  useImperativeHandle(ref, () => ({
    addAssets,
    addBlocks,
    getReport: () => currentRef.current.report,
    loadReport: replaceReport,
  }));
  function setPageLayout(patch: Partial<ReportDocument>) {
    const next = { ...report, ...patch };
    const size = pageDimensions(next);
    next.pages = report.pages.map((item) => ({
      ...item,
      blocks: item.blocks.map((block) => {
        const w = Math.min(block.width, size.width),
          h = Math.min(block.height, size.height);
        return {
          ...block,
          width: w,
          height: h,
          x: clamp(block.x, 0, size.width - w),
          y: clamp(block.y, 0, size.height - h),
        };
      }),
    }));
    commit(next);
  }
  function startGesture(
    event: PointerEvent<HTMLElement>,
    block: ReportBlock,
    mode: 'move' | 'resize',
  ) {
    if (event.button !== 0 || preview) return;
    event.preventDefault();
    event.stopPropagation();
    const captureTarget =
      event.currentTarget.closest<HTMLElement>('.rb-block') ??
      event.currentTarget;
    captureTarget.focus({ preventScroll: true });
    setSelectedId(block.id);
    gesture.current = {
      pointerId: event.pointerId,
      block,
      startX: event.clientX,
      startY: event.clientY,
      mode,
      before: report,
    };
    captureTarget.setPointerCapture(event.pointerId);
    setGestureActive(true);
  }
  function moveGesture(event: PointerEvent<HTMLElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = (event.clientX - current.startX) / scale;
    const dy = (event.clientY - current.startY) / scale;
    const round = (value: number) =>
      snap && !event.altKey ? Math.round(value / 8) * 8 : Math.round(value);
    const block = current.block;
    const patch =
      current.mode === 'move'
        ? {
            x: clamp(round(block.x + dx), 0, width - block.width),
            y: clamp(round(block.y + dy), 0, height - block.height),
          }
        : {
            width: clamp(round(block.width + dx), 48, width - block.x),
            height: clamp(round(block.height + dy), 28, height - block.y),
          };
    setHistory((old) => ({
      ...old,
      report: {
        ...old.report,
        pages: old.report.pages.map((item) =>
          item.id === page.id
            ? {
                ...item,
                blocks: item.blocks.map((itemBlock) =>
                  itemBlock.id === block.id
                    ? { ...itemBlock, ...patch }
                    : itemBlock,
                ),
              }
            : item,
        ),
      },
    }));
  }
  function finishGesture(event: PointerEvent<HTMLElement>, cancel = false) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setHistory((old) =>
      cancel
        ? { ...old, report: current.before }
        : JSON.stringify(old.report) === JSON.stringify(current.before)
          ? old
          : {
              ...old,
              past: [...old.past.slice(-39), current.before],
              future: [],
            },
    );
    setGestureActive(false);
  }
  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    const type = event.dataTransfer.getData(DRAG_TYPE);
    const plot = event.dataTransfer.getData('text/plain');
    const rect = paperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const at = {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    };
    const assets = event.dataTransfer.getData(REPORT_ASSET_DRAG_TYPE);
    if (workspace && assets) {
      try {
        const ids: unknown = JSON.parse(assets);
        if (
          Array.isArray(ids) &&
          ids.every((id): id is string => typeof id === 'string')
        )
          void addAssets(ids, at);
      } catch {
        setNotice(
          'This data could not be added. Choose it from the Data library.',
        );
      }
      return;
    }
    const output = event.dataTransfer.getData(WORKFLOW_DRAG_TYPE);
    if (workspace && output) {
      void addAssets(workspace.resolveDrop(output), at);
      return;
    }
    if (event.dataTransfer.files.length)
      void importImage(event.dataTransfer.files[0], null, at);
    else if (BLOCKS.some((item) => item.type === type))
      addBlock(
        type as ReportBlockType,
        at,
        type === 'plot' && ['power', 'torque', 'temperature'].includes(plot)
          ? { plot: plot as ReportBlock['plot'] }
          : undefined,
      );
  }
  async function importImage(
    file: File,
    target: string | null,
    at?: { x: number; y: number },
  ) {
    const targetPageId = page.id;
    const epoch = reportEpoch.current;
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size > 6 * 1024 * 1024
    ) {
      setNotice('Choose a PNG, JPG or WebP image smaller than 6 MB.');
      return;
    }
    try {
      const src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error('The image could not be read.'));
        reader.onerror = () =>
          reject(new Error('The image could not be read.'));
        reader.readAsDataURL(file);
      });
      const decoded = new Image();
      decoded.src = src;
      await decoded.decode();
      if (decoded.naturalWidth * decoded.naturalHeight > 24000000)
        throw new Error('Choose an image with fewer than 24 million pixels.');
      if (reportEpoch.current !== epoch) return;
      if (gesture.current) {
        setNotice('Finish arranging the block, then upload your image again.');
        return;
      }
      const imageBlock = createBlock('image', { src, name: file.name });
      commit((current) => {
        const targetPage = current.pages.find(
          (item) => item.id === targetPageId,
        );
        if (
          !targetPage ||
          (target && !targetPage.blocks.some((item) => item.id === target))
        )
          return current;
        const size = pageDimensions(current);
        const area = frameInsets(current, current.pages.indexOf(targetPage));
        imageBlock.width = Math.min(imageBlock.width, size.width - 80);
        imageBlock.height = Math.min(imageBlock.height, size.height - 80);
        imageBlock.x = clamp(
          at?.x ?? area.left,
          0,
          size.width - imageBlock.width,
        );
        imageBlock.y = clamp(
          at?.y ?? area.top + 16,
          0,
          size.height - imageBlock.height,
        );
        return {
          ...current,
          pages: current.pages.map((item) =>
            item.id === targetPageId
              ? {
                  ...item,
                  blocks: target
                    ? item.blocks.map((block) =>
                        block.id === target
                          ? { ...block, src, name: file.name }
                          : block,
                      )
                    : [...item.blocks, imageBlock],
                }
              : item,
          ),
        };
      });
      setSelectedId(target ?? imageBlock.id);
      setNotice('Image added. It stays on this device.');
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Could not open this image.',
      );
    }
  }
  async function exportPdf() {
    if (exporting) return;
    setExporting(true);
    try {
      await downloadReportPdf(report);
      setNotice('Your PDF is ready. Check your downloads.');
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'The PDF could not be exported.',
      );
    } finally {
      setExporting(false);
    }
  }
  const SelectionIcon =
    BLOCKS.find((item) => item.type === selected?.type)?.icon ?? Settings2;

  return (
    // Keyboard shortcuts are delegated from the editor's focusable controls.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <main
      ref={editorRef}
      tabIndex={-1}
      className="rb-app"
      role="application"
      aria-label="Report editor"
      onPointerMoveCapture={moveGesture}
      onPointerUpCapture={(event) => finishGesture(event)}
      onPointerCancelCapture={(event) => finishGesture(event, true)}
      data-embedded={workspace ? true : undefined}
      onKeyDown={(event) => {
        if (gesture.current) {
          event.preventDefault();
          if (event.key === 'Escape') {
            const before = gesture.current.before;
            gesture.current = null;
            setHistory((current) => ({ ...current, report: before }));
            setGestureActive(false);
          }
          return;
        }
        const target = event.target as HTMLElement;
        if (target.closest('input, textarea, select, [contenteditable]'))
          return;
        if (event.key === 'Escape') {
          setSelectedId(null);
          setPreview(false);
        }
        if (preview) return;
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 'z'
        ) {
          event.preventDefault();
          if (event.shiftKey) redo();
          else undo();
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 'y'
        ) {
          event.preventDefault();
          redo();
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 'd'
        ) {
          event.preventDefault();
          duplicateSelected();
        }
        if (selected && (event.key === 'Delete' || event.key === 'Backspace')) {
          event.preventDefault();
          deleteSelected();
        }
        if (
          selected &&
          ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
            event.key,
          )
        ) {
          event.preventDefault();
          const step = event.shiftKey ? 10 : 1;
          updateSelected({
            x:
              selected.x +
              (event.key === 'ArrowRight'
                ? step
                : event.key === 'ArrowLeft'
                  ? -step
                  : 0),
            y:
              selected.y +
              (event.key === 'ArrowDown'
                ? step
                : event.key === 'ArrowUp'
                  ? -step
                  : 0),
          });
        }
      }}
    >
      <header className="rb-header">
        {/* In the application, the top bar names Stratum and Reports. */}
        {!workspace && (
          <div className="rb-brand">
            <span className="rb-brand-mark">
              <Layers size={21} />
            </span>
            <strong>Stratum</strong>
            <span className="rb-slash">/</span>
            <span>Reports</span>
            <span className="rb-badge">MOCKUP</span>
          </div>
        )}
        <div className="rb-document-name">
          <input
            aria-label="Report name"
            value={report.title}
            onChange={(event) =>
              commit({ ...report, title: event.target.value })
            }
          />
          <span>
            <span className="rb-dot" /> Local draft · this session
          </span>
        </div>
        <div className="rb-header-actions">
          {!workspace && (
            <Tool
              icon={theme === 'light' ? Moon : Sun}
              label="Toggle color theme"
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            />
          )}
          <button
            className={cn(
              'rb-button rb-preview-button',
              preview && 'is-active',
            )}
            onClick={() => {
              setPreview(!preview);
              setSelectedId(null);
            }}
          >
            <Eye size={15} />
            {preview ? 'Back to editor' : 'Preview'}
          </button>
          <button
            className="rb-button rb-primary"
            disabled={exporting}
            onClick={() => void exportPdf()}
          >
            <Download size={15} />
            {exporting ? 'Preparing PDF…' : 'Export PDF'}
          </button>
        </div>
      </header>
      <div className="rb-toolbar">
        <div className="rb-toolbar-group">
          <Tool
            icon={Undo2}
            label="Undo (Ctrl+Z)"
            disabled={preview || !history.past.length}
            onClick={undo}
          />
          <Tool
            icon={Redo2}
            label="Redo (Ctrl+Shift+Z)"
            disabled={preview || !history.future.length}
            onClick={redo}
          />
          <span className="rb-divider" />
          <span className="rb-editing-label">
            <MousePointer2 size={14} />
            {preview ? 'Preview mode' : 'Design report'}
          </span>
        </div>
        {!preview && (
          <div className="rb-quick-insert">
            {BLOCKS.map(({ type, label, icon: Icon }) => (
              <button key={type} onClick={() => addBlock(type)}>
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="rb-toolbar-group rb-toolbar-end">
          <span className="rb-page-format">
            {report.pageSize.toUpperCase()} · {report.orientation}
          </span>
          <span className="rb-divider" />
          <Tool
            icon={Minus}
            label="Zoom out"
            onClick={() => setZoom(clamp(scale - 0.1, 0.25, 1.5))}
          />
          <button
            className="rb-zoom"
            title="Fit page to width"
            onClick={() => setZoom(null)}
          >
            {Math.round(scale * 100)}%<ChevronDown size={12} />
          </button>
          <Tool
            icon={Plus}
            label="Zoom in"
            onClick={() => setZoom(clamp(scale + 0.1, 0.25, 1.5))}
          />
        </div>
      </div>
      <div className={cn('rb-body', preview && 'rb-preview')}>
        {!preview && (
          <aside className="rb-library">
            <div className="rb-tabs">
              {workspace && (
                <button
                  className={cn(libraryTab === 'data' && 'is-active')}
                  onClick={() => setLibraryTab('data')}
                >
                  Data
                </button>
              )}
              <button
                className={cn(libraryTab === 'insert' && 'is-active')}
                onClick={() => setLibraryTab('insert')}
              >
                Insert
              </button>
              <button
                className={cn(libraryTab === 'templates' && 'is-active')}
                onClick={() => setLibraryTab('templates')}
              >
                Templates
              </button>
              <button
                className={cn(libraryTab === 'pages' && 'is-active')}
                onClick={() => setLibraryTab('pages')}
              >
                Pages <span>{report.pages.length}</span>
              </button>
            </div>
            <div className="rb-library-scroll">
              {libraryTab === 'data' && workspace ? (
                <ReportDataLibrary
                  assets={workspace.assets}
                  selectionIds={workspace.selectionIds}
                  busy={workspace.busy}
                  capturing={capturing}
                  onAdd={(ids) => void addAssets(ids)}
                  onCancel={cancelCapture}
                />
              ) : libraryTab === 'insert' ? (
                <>
                  <div className="rb-section-heading">
                    <h2>Make space for your story</h2>
                    <p>Drag a block onto the page, or click to add.</p>
                  </div>
                  <div className="rb-block-library">
                    {BLOCKS.map(({ type, label, detail, icon: Icon }) => (
                      <button
                        key={type}
                        className={'rb-asset rb-asset-' + type}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData(DRAG_TYPE, type);
                          event.dataTransfer.effectAllowed = 'copy';
                        }}
                        onClick={() => addBlock(type)}
                      >
                        <span className="rb-asset-top">
                          <span className="rb-asset-icon">
                            <Icon size={20} />
                          </span>
                          <GripVertical size={14} />
                        </span>
                        <strong>{label}</strong>
                        <small>{detail}</small>
                      </button>
                    ))}
                  </div>
                  <button
                    className="rb-upload"
                    onClick={() => {
                      imageTarget.current = null;
                      imageInputRef.current?.click();
                    }}
                  >
                    <Upload size={16} />
                    <span>
                      Upload an image
                      <small>PNG, JPG or WebP · up to 6 MB</small>
                    </span>
                  </button>
                  {!workspace && (
                    <>
                      <div className="rb-section-heading rb-library-subheading">
                        <h2>Sample plots</h2>
                        <span className="rb-small-tag">3 AVAILABLE</span>
                      </div>
                      {(['power', 'torque', 'temperature'] as const).map(
                        (plot, index) => (
                          <button
                            className="rb-plot-asset"
                            key={plot}
                            draggable
                            onDragStart={(event) => {
                              event.dataTransfer.setData(DRAG_TYPE, 'plot');
                              event.dataTransfer.setData('text/plain', plot);
                            }}
                            onClick={() =>
                              addBlock('plot', undefined, {
                                plot,
                                name: [
                                  'Power curve',
                                  'Torque response',
                                  'Thermal stability',
                                ][index],
                              })
                            }
                          >
                            <svg viewBox="0 0 72 32" aria-hidden="true">
                              <path
                                d={
                                  [
                                    'M2 28L8 26L14 22L20 19L26 15L32 10L38 9L44 6L50 7L56 11L62 13L70 20',
                                    'M2 25L8 12L14 11L20 10L26 12L32 9L38 11L44 10L50 12L56 14L62 19L70 26',
                                    'M2 28L8 23L14 18L20 14L26 11L32 9L38 7L44 6L50 6L56 5L62 5L70 4',
                                  ][index]
                                }
                                fill="none"
                                stroke={
                                  ['#3778c8', '#299486', '#dc9d45'][index]
                                }
                                strokeWidth="2"
                              />
                            </svg>
                            <span>
                              {
                                [
                                  'Power curve',
                                  'Torque response',
                                  'Thermal stability',
                                ][index]
                              }
                              <small>Motor test · illustrative</small>
                            </span>
                            <Plus size={13} />
                          </button>
                        ),
                      )}
                      <div className="rb-library-tip">
                        <span>
                          <LayoutTemplate size={16} /> A little inspiration
                        </span>
                        <p>Explore a finished layout, then make it yours.</p>
                        <button
                          onClick={() => replaceReport(createExampleReport())}
                        >
                          Load sample report <span>↗</span>
                        </button>
                      </div>
                    </>
                  )}
                </>
              ) : libraryTab === 'templates' ? (
                <>
                  <div className="rb-section-heading">
                    <h2>Start from a template</h2>
                    <p>
                      A designed border, header and title page to build on. Undo
                      restores your current draft.
                    </p>
                  </div>
                  <div className="rb-template-grid">
                    {REPORT_DESIGNS.map((design, index) => (
                      <button
                        key={design.style}
                        className="rb-template"
                        aria-label={`Start from the ${design.name} template`}
                        onClick={() => startFromTemplate(design.style)}
                      >
                        <span className="rb-template-sheet">
                          <ReportPageSvg
                            report={templatePreviews[index]}
                            page={templatePreviews[index].pages[0]}
                          />
                        </span>
                        <strong>{design.name}</strong>
                        <small>{design.detail}</small>
                      </button>
                    ))}
                  </div>
                  <div className="rb-section-heading rb-library-subheading">
                    <h2>Page design</h2>
                  </div>
                  <p className="rb-field-note">
                    Change the border and header on every page. Your content
                    stays where it is.
                  </p>
                  <fieldset
                    className="rb-design-options"
                    aria-label="Page design"
                  >
                    {[
                      { style: 'none' as const, name: 'None' },
                      ...REPORT_DESIGNS,
                    ].map((design) => {
                      const active =
                        (report.frame?.style ?? 'none') === design.style;
                      return (
                        <button
                          key={design.style}
                          aria-pressed={active}
                          className={cn(active && 'is-active')}
                          onClick={() => applyDesign(design.style)}
                        >
                          {design.name}
                        </button>
                      );
                    })}
                  </fieldset>
                  {report.frame && (
                    <>
                      <div className="rb-section-heading rb-library-subheading">
                        <h2>Accent colour</h2>
                      </div>
                      <fieldset
                        className="rb-accent-swatches"
                        aria-label="Accent colour"
                      >
                        {FRAME_ACCENTS.map((accent) => {
                          const active =
                            report.frame?.accent.toLowerCase() === accent.value;
                          return (
                            <button
                              key={accent.value}
                              aria-pressed={active}
                              aria-label={accent.name}
                              title={accent.name}
                              className={cn(active && 'is-active')}
                              style={{ background: accent.value }}
                              onClick={() => setFrameAccent(accent.value)}
                            />
                          );
                        })}
                        <label className="rb-accent-custom" title="Custom">
                          <input
                            type="color"
                            aria-label="Custom accent colour"
                            value={report.frame.accent}
                            onChange={(event) =>
                              setFrameAccent(event.target.value)
                            }
                          />
                          <Plus size={12} />
                        </label>
                      </fieldset>
                    </>
                  )}
                </>
              ) : (
                <>
                  <div className="rb-section-heading">
                    <h2>Your report, page by page</h2>
                    <p>Select a page to arrange its content.</p>
                  </div>
                  <div className="rb-page-list">
                    {report.pages.map((item, index) => (
                      <button
                        className={cn(
                          'rb-page-thumbnail',
                          item.id === page.id && 'is-active',
                        )}
                        key={item.id}
                        onClick={() => {
                          setPageIndex(index);
                          setSelectedId(null);
                        }}
                      >
                        <span>
                          <ReportPageSvg report={report} page={item} />
                        </span>
                        <span className="rb-page-thumbnail-label">
                          <FileText size={14} />
                          Page {index + 1}
                          {item.id === page.id && <Check size={14} />}
                        </span>
                      </button>
                    ))}
                  </div>
                  <button className="rb-button rb-wide" onClick={addPage}>
                    <Plus size={15} />
                    Add blank page
                  </button>
                </>
              )}
            </div>
            <div className="rb-library-bottom">
              <button
                className="rb-button rb-wide"
                onClick={() => replaceReport(createBlankReport())}
              >
                <FilePlus2 size={15} />
                New blank report
              </button>
            </div>
          </aside>
        )}
        <section className="rb-workspace">
          <div className="rb-canvas-heading">
            <span>
              <FileText size={13} />
              Page {Math.min(pageIndex + 1, report.pages.length)}{' '}
              <span className="rb-muted">of {report.pages.length}</span>
            </span>
            <span>
              {preview
                ? 'Your exported layout'
                : 'Click to select · drag to arrange'}
            </span>
          </div>
          <div
            className="rb-viewport"
            ref={viewportRef}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setSelectedId(null);
            }}
          >
            {preview ? (
              <div className="rb-preview-pages">
                {report.pages.map((item, index) => (
                  <div key={item.id}>
                    <div className="rb-preview-page-label">
                      Page {index + 1}
                    </div>
                    <div
                      className="rb-preview-sheet"
                      style={{ width: width * scale, height: height * scale }}
                    >
                      <ReportPageSvg report={report} page={item} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                className="rb-page-wrap"
                style={{ width: width * scale, height: height * scale }}
              >
                <div
                  ref={paperRef}
                  className={cn(
                    'rb-paper',
                    dragOver && 'is-drag-over',
                    gestureActive && 'is-arranging',
                  )}
                  aria-label="Report canvas"
                  style={
                    {
                      width,
                      height,
                      transform: 'scale(' + scale + ')',
                      background: report.background,
                      '--rb-inverse-scale': 1 / scale,
                    } as CSSProperties
                  }
                  onPointerDown={(event) => {
                    if (event.target === event.currentTarget)
                      setSelectedId(null);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                >
                  {report.frame && (
                    <svg
                      className="rb-frame"
                      width={width}
                      height={height}
                      viewBox={`0 0 ${width} ${height}`}
                      aria-hidden="true"
                    >
                      <ReportFrameArt
                        report={report}
                        pageIndex={shownPageIndex}
                      />
                    </svg>
                  )}
                  <div
                    className="rb-page-margin"
                    style={{
                      top: insets.top - 8,
                      right: insets.right - 8,
                      bottom: insets.bottom - 8,
                      left: insets.left - 8,
                    }}
                  />
                  {!page.blocks.length && (
                    <div className="rb-empty">
                      <span>
                        <FilePlus2 size={35} strokeWidth={1.3} />
                      </span>
                      <h2>A blank page. A clear story.</h2>
                      <p>
                        Drag in a plot, add your findings,
                        <br />
                        and bring your analysis together.
                      </p>
                      <div className="rb-empty-actions">
                        <button onClick={() => addBlock('text')}>
                          Add your first block <Plus size={15} />
                        </button>
                        {report.pages.every((item) => !item.blocks.length) && (
                          <button
                            onClick={() => {
                              setLibraryTab('templates');
                              setSelectedId(null);
                            }}
                          >
                            Browse templates <LayoutTemplate size={15} />
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  {page.blocks.map((block) => (
                    <button
                      key={block.id}
                      type="button"
                      aria-label={block.name + ' block'}
                      data-block-type={block.type}
                      className={cn(
                        'rb-block',
                        selectedId === block.id && 'is-selected',
                      )}
                      style={{
                        left: block.x,
                        top: block.y,
                        width: block.width,
                        height: block.height,
                      }}
                      onFocus={() => setSelectedId(block.id)}
                      onPointerDown={(event) =>
                        startGesture(event, block, 'move')
                      }
                      onPointerUp={(event) => finishGesture(event)}
                      onPointerCancel={(event) => finishGesture(event, true)}
                      onLostPointerCapture={(event) =>
                        finishGesture(event, true)
                      }
                      onClick={(event) => event.stopPropagation()}
                    >
                      <ReportBlockContent block={block} />
                      {selectedId === block.id && (
                        <>
                          <span className="rb-selection-label">
                            {block.type}
                            <span>
                              {Math.round(block.width)} ×{' '}
                              {Math.round(block.height)}
                            </span>
                          </span>
                          <span className="rb-corner rb-corner-tl" />
                          <span className="rb-corner rb-corner-tr" />
                          <span className="rb-corner rb-corner-bl" />
                          <span
                            className="rb-resize-handle"
                            aria-hidden="true"
                            title="Drag to resize"
                            onPointerDown={(event) =>
                              startGesture(event, block, 'resize')
                            }
                            onPointerUp={(event) => finishGesture(event)}
                            onPointerCancel={(event) =>
                              finishGesture(event, true)
                            }
                          />
                        </>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!preview && (
              <button className="rb-add-page" onClick={addPage}>
                <Plus size={14} />
                Add page
              </button>
            )}
          </div>
          <div className="rb-canvas-footer">
            <span>
              <span className="rb-dot" />
              {preview
                ? 'Ready for a closer look'
                : selected
                  ? selected.name
                  : 'Everything starts with a blank canvas'}
            </span>
            <span>
              {preview
                ? report.pages.length + ' pages'
                : page.blocks.length + ' blocks'}
              <span className="rb-footer-separator">·</span>
              {preview ? 'PDF export' : 'Arrow keys to nudge'}
            </span>
          </div>
        </section>
        {!preview && (
          <aside className="rb-inspector">
            <div className="rb-inspector-heading">
              <span>
                <SelectionIcon size={16} />
                {selected ? 'Block properties' : 'Page settings'}
              </span>
              {selected && (
                <Tool
                  icon={X}
                  label="Deselect block"
                  onClick={() => setSelectedId(null)}
                />
              )}
            </div>
            <div
              className="rb-inspector-scroll"
              key={selected?.id ?? 'page-settings'}
            >
              {selected ? (
                <>
                  <section className="rb-property-section">
                    <div className="rb-property-title">
                      <h3>
                        {selected.type.charAt(0).toUpperCase() +
                          selected.type.slice(1)}{' '}
                        block
                      </h3>
                      <span className="rb-small-tag">SELECTED</span>
                    </div>
                    <Field label="Block name">
                      <input
                        value={selected.name}
                        onChange={(event) =>
                          updateSelected({ name: event.target.value })
                        }
                      />
                    </Field>
                    <div className="rb-fields-grid">
                      <NumberField
                        label="X position"
                        value={selected.x}
                        onChange={(x) => updateSelected({ x })}
                        max={width - selected.width}
                      />
                      <NumberField
                        label="Y position"
                        value={selected.y}
                        onChange={(y) => updateSelected({ y })}
                        max={height - selected.height}
                      />
                      <NumberField
                        label="Width"
                        value={selected.width}
                        onChange={(value) => updateSelected({ width: value })}
                        min={48}
                        max={width - selected.x}
                      />
                      <NumberField
                        label="Height"
                        value={selected.height}
                        onChange={(value) => updateSelected({ height: value })}
                        min={28}
                        max={height - selected.y}
                      />
                    </div>
                  </section>
                  {selected.source && (
                    <section className="rb-property-section rb-source-info">
                      <h3>Workspace snapshot</h3>
                      <strong>{selected.source.label}</strong>
                      <p>
                        {selected.source.outputIds.length.toLocaleString()}{' '}
                        source outputs ·{' '}
                        {new Date(selected.source.capturedAt).toLocaleString()}
                      </p>
                      <p title={selected.source.sourceNames.join(', ')}>
                        {selected.source.sourceNames.slice(0, 4).join(', ')}
                        {selected.source.sourceNames.length > 4
                          ? ` +${selected.source.sourceNames.length - 4} more`
                          : ''}
                      </p>
                      <p title={selected.source.timeReferences.join(', ')}>
                        {selected.source.timeReferences.slice(0, 3).join(', ')}
                      </p>
                      <p className="rb-field-note">
                        Captured data stays fixed. Add a new snapshot to include
                        changes from Data Inspector.
                      </p>
                    </section>
                  )}
                  {selected.type === 'text' && (
                    <section className="rb-property-section">
                      <h3>Content</h3>
                      <textarea
                        aria-label="Text content"
                        rows={5}
                        value={selected.text}
                        onChange={(event) =>
                          updateSelected({ text: event.target.value })
                        }
                      />
                      <p className="rb-field-note">
                        Text wraps to the block. Resize to reveal more.
                      </p>
                    </section>
                  )}
                  {selected.type === 'plot' && (
                    <section className="rb-property-section">
                      <h3>Plot</h3>
                      {selected.plotSnapshot ? (
                        <p className="rb-field-note">
                          This snapshot preserves the plot&apos;s axes, traces
                          and annotations. Change those in Data Inspector and
                          add a new snapshot. Resize or format its frame here.
                        </p>
                      ) : (
                        <>
                          <Field label="Plot title">
                            <input
                              value={selected.text}
                              onChange={(event) =>
                                updateSelected({ text: event.target.value })
                              }
                            />
                          </Field>
                          {!selected.signalPlot && (
                            <Field label="Sample data">
                              <select
                                value={selected.plot}
                                onChange={(event) =>
                                  updateSelected({
                                    plot: event.target
                                      .value as ReportBlock['plot'],
                                  })
                                }
                              >
                                <option value="power">Power curve</option>
                                <option value="torque">Torque response</option>
                                <option value="temperature">
                                  Thermal stability
                                </option>
                              </select>
                            </Field>
                          )}
                          <div className="rb-fields-grid">
                            <ColorField
                              label="Line color"
                              value={selected.accent}
                              onChange={(accent) => updateSelected({ accent })}
                            />
                            <NumberField
                              label="Line weight"
                              value={selected.lineWidth}
                              min={1}
                              max={8}
                              step={0.5}
                              onChange={(lineWidth) =>
                                updateSelected({ lineWidth })
                              }
                            />
                          </div>
                          <label className="rb-checkbox">
                            <input
                              type="checkbox"
                              checked={selected.showGrid}
                              onChange={(event) =>
                                updateSelected({
                                  showGrid: event.target.checked,
                                })
                              }
                            />
                            Show gridlines
                          </label>
                          <label className="rb-checkbox">
                            <input
                              type="checkbox"
                              checked={selected.showLegend}
                              onChange={(event) =>
                                updateSelected({
                                  showLegend: event.target.checked,
                                })
                              }
                            />
                            Show legend
                          </label>
                        </>
                      )}
                    </section>
                  )}
                  {selected.type === 'image' && (
                    <section className="rb-property-section">
                      <h3>Image</h3>
                      <button
                        className="rb-button rb-wide"
                        onClick={() => {
                          imageTarget.current = selected.id;
                          imageInputRef.current?.click();
                        }}
                      >
                        <Upload size={14} />
                        Replace image
                      </button>
                      <Field label="Image fit">
                        <select
                          value={selected.objectFit}
                          onChange={(event) =>
                            updateSelected({
                              objectFit: event.target
                                .value as ReportBlock['objectFit'],
                            })
                          }
                        >
                          <option value="contain">Fit entire image</option>
                          <option value="cover">Fill frame</option>
                        </select>
                      </Field>
                      <p className="rb-field-note">
                        Drop an image from your computer onto the page to add
                        it.
                      </p>
                    </section>
                  )}
                  {selected.type === 'table' && (
                    <section className="rb-property-section">
                      <h3>Table content</h3>
                      <Field label="Table title">
                        <input
                          value={selected.text}
                          onChange={(event) =>
                            updateSelected({ text: event.target.value })
                          }
                        />
                      </Field>
                      <div className="rb-table-editor">
                        {selected.tableData.map((row, rowIndex) => (
                          <div
                            key={rowIndex}
                            style={{
                              gridTemplateColumns:
                                'repeat(' + row.length + ', minmax(0, 1fr))',
                            }}
                          >
                            {row.map((cell, colIndex) => (
                              <input
                                key={colIndex}
                                aria-label={
                                  'Row ' +
                                  (rowIndex + 1) +
                                  ', column ' +
                                  (colIndex + 1)
                                }
                                value={cell}
                                readOnly={
                                  selected.source?.kind === 'values' ||
                                  selected.source?.kind === 'checks'
                                }
                                onChange={(event) =>
                                  updateSelected({
                                    tableData: selected.tableData.map(
                                      (item, i) =>
                                        i === rowIndex
                                          ? item.map((value, j) =>
                                              j === colIndex
                                                ? event.target.value
                                                : value,
                                            )
                                          : item,
                                    ),
                                  })
                                }
                              />
                            ))}
                          </div>
                        ))}
                      </div>
                      {selected.source?.kind === 'values' ||
                      selected.source?.kind === 'checks' ? (
                        <p className="rb-field-note">
                          {selected.source.kind === 'checks'
                            ? 'Check results are captured from the workflow checks.'
                            : 'Values are captured from the calculation outputs.'}{' '}
                          Their content is read-only; title and table formatting
                          are editable.
                        </p>
                      ) : (
                        <div className="rb-row-actions">
                          <button
                            disabled={selected.tableData.length >= 12}
                            onClick={() =>
                              updateSelected({
                                tableData: [
                                  ...selected.tableData,
                                  Array.from(
                                    {
                                      length:
                                        selected.tableData[0]?.length ?? 3,
                                    },
                                    () => '—',
                                  ),
                                ],
                              })
                            }
                          >
                            <Plus size={12} />
                            Row
                          </button>
                          <button
                            disabled={selected.tableData.length <= 2}
                            onClick={() =>
                              updateSelected({
                                tableData: selected.tableData.slice(0, -1),
                              })
                            }
                          >
                            <Minus size={12} />
                            Row
                          </button>
                          <button
                            disabled={(selected.tableData[0]?.length ?? 0) >= 5}
                            onClick={() =>
                              updateSelected({
                                tableData: selected.tableData.map(
                                  (row, index) => [
                                    ...row,
                                    index === 0 ? 'Column' : '—',
                                  ],
                                ),
                              })
                            }
                          >
                            <Plus size={12} />
                            Column
                          </button>
                        </div>
                      )}
                      <ColorField
                        label="Header color"
                        value={selected.accent}
                        onChange={(accent) => updateSelected({ accent })}
                      />
                      <label className="rb-checkbox">
                        <input
                          type="checkbox"
                          checked={selected.striped}
                          onChange={(event) =>
                            updateSelected({ striped: event.target.checked })
                          }
                        />
                        Alternating row fill
                      </label>
                    </section>
                  )}
                  {selected.type !== 'image' && !selected.plotSnapshot && (
                    <section className="rb-property-section">
                      <h3>Typography</h3>
                      <Field label="Font family">
                        <select
                          value={selected.fontFamily}
                          onChange={(event) =>
                            updateSelected({
                              fontFamily: event.target
                                .value as ReportBlock['fontFamily'],
                            })
                          }
                        >
                          <option value="sans">Sans serif</option>
                          <option value="serif">Serif</option>
                          <option value="mono">Monospace</option>
                        </select>
                      </Field>
                      <div className="rb-fields-grid">
                        <NumberField
                          label="Font size"
                          value={selected.fontSize}
                          min={8}
                          max={96}
                          onChange={(fontSize) => updateSelected({ fontSize })}
                        />
                        <ColorField
                          label="Text color"
                          value={selected.color}
                          onChange={(color) => updateSelected({ color })}
                        />
                      </div>
                      <div className="rb-format-bar">
                        <Tool
                          icon={Bold}
                          label="Bold"
                          active={selected.bold}
                          onClick={() =>
                            updateSelected({ bold: !selected.bold })
                          }
                        />
                        <Tool
                          icon={Italic}
                          label="Italic"
                          active={selected.italic}
                          onClick={() =>
                            updateSelected({ italic: !selected.italic })
                          }
                        />
                        <span className="rb-divider" />
                        {(
                          [
                            { value: 'left', Icon: AlignLeft },
                            { value: 'center', Icon: AlignCenter },
                            { value: 'right', Icon: AlignRight },
                          ] as const
                        ).map(({ value, Icon }) => (
                          <Tool
                            key={value}
                            icon={Icon}
                            label={'Align ' + value}
                            active={selected.align === value}
                            onClick={() => updateSelected({ align: value })}
                          />
                        ))}
                      </div>
                    </section>
                  )}
                  <section className="rb-property-section">
                    <h3>Appearance</h3>
                    <div className="rb-fields-grid">
                      <ColorField
                        label="Background"
                        value={selected.fill}
                        onChange={(fill) => updateSelected({ fill })}
                      />
                      <ColorField
                        label="Border color"
                        value={selected.borderColor}
                        onChange={(borderColor) =>
                          updateSelected({ borderColor })
                        }
                      />
                      <NumberField
                        label="Border width"
                        value={selected.borderWidth}
                        max={12}
                        onChange={(borderWidth) =>
                          updateSelected({ borderWidth })
                        }
                      />
                      <NumberField
                        label="Corner radius"
                        value={selected.radius}
                        max={80}
                        onChange={(radius) => updateSelected({ radius })}
                      />
                      <NumberField
                        label="Padding"
                        value={selected.padding}
                        max={80}
                        onChange={(padding) => updateSelected({ padding })}
                      />
                      <NumberField
                        label="Opacity %"
                        value={selected.opacity * 100}
                        max={100}
                        onChange={(opacity) =>
                          updateSelected({ opacity: opacity / 100 })
                        }
                      />
                    </div>
                    <button
                      className="rb-text-button"
                      onClick={() => updateSelected({ fill: 'transparent' })}
                    >
                      Remove background fill
                    </button>
                  </section>
                  <section className="rb-property-section">
                    <h3>Arrange</h3>
                    <div className="rb-arrange-grid">
                      <button onClick={() => reorder(true)}>
                        <ArrowUpToLine size={15} />
                        Bring to front
                      </button>
                      <button onClick={() => reorder(false)}>
                        <ArrowDownToLine size={15} />
                        Send to back
                      </button>
                      <button onClick={duplicateSelected}>
                        <Copy size={15} />
                        Duplicate
                      </button>
                      <button className="rb-danger" onClick={deleteSelected}>
                        <Trash2 size={15} />
                        Delete
                      </button>
                    </div>
                  </section>
                </>
              ) : (
                <>
                  <section className="rb-property-section">
                    <div className="rb-page-setting-icon">
                      <FileText size={27} strokeWidth={1.3} />
                    </div>
                    <h2>The page is yours.</h2>
                    <p className="rb-inspector-intro">
                      Build a report that brings your analysis into focus.
                    </p>
                    <Field label="Paper size">
                      <select
                        value={report.pageSize}
                        onChange={(event) =>
                          setPageLayout({
                            pageSize: event.target
                              .value as ReportDocument['pageSize'],
                          })
                        }
                      >
                        <option value="a4">A4 · 210 × 297 mm</option>
                        <option value="letter">US Letter · 8.5 × 11 in</option>
                      </select>
                    </Field>
                    <Field label="Orientation">
                      <select
                        value={report.orientation}
                        onChange={(event) =>
                          setPageLayout({
                            orientation: event.target
                              .value as ReportDocument['orientation'],
                          })
                        }
                      >
                        <option value="portrait">Portrait</option>
                        <option value="landscape">Landscape</option>
                      </select>
                    </Field>
                    <ColorField
                      label="Page color"
                      value={report.background}
                      onChange={(background) =>
                        commit({ ...report, background })
                      }
                    />
                    <Field label="Page design">
                      <select
                        value={report.frame?.style ?? 'none'}
                        onChange={(event) =>
                          applyDesign(
                            event.target.value as ReportFrameStyle | 'none',
                          )
                        }
                      >
                        <option value="none">None</option>
                        {REPORT_DESIGNS.map((design) => (
                          <option key={design.style} value={design.style}>
                            {design.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {report.frame && (
                      <ColorField
                        label="Design accent"
                        value={report.frame.accent}
                        onChange={setFrameAccent}
                      />
                    )}
                    <button
                      className="rb-text-button"
                      onClick={() => setLibraryTab('templates')}
                    >
                      Browse templates
                    </button>
                  </section>
                  <section className="rb-property-section">
                    <h3>Canvas helpers</h3>
                    <label className="rb-checkbox">
                      <input
                        type="checkbox"
                        checked={snap}
                        onChange={(event) => setSnap(event.target.checked)}
                      />
                      Snap to 8 px grid
                    </label>
                    <p className="rb-field-note">
                      Hold Alt while dragging for free placement. Guides do not
                      appear in the PDF.
                    </p>
                  </section>
                  <section className="rb-property-section">
                    <h3>
                      On this page <span>{page.blocks.length}</span>
                    </h3>
                    {page.blocks.length ? (
                      <div className="rb-layers">
                        {[...page.blocks].reverse().map((block) => {
                          const Icon = BLOCKS.find(
                            (item) => item.type === block.type,
                          )!.icon;
                          return (
                            <button
                              key={block.id}
                              onClick={() => setSelectedId(block.id)}
                            >
                              <Icon size={14} />
                              <span>{block.name}</span>
                              <GripVertical size={12} />
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="rb-field-note">
                        Your blocks will appear here.
                      </p>
                    )}
                  </section>
                  <section className="rb-property-section">
                    <button className="rb-button rb-wide" onClick={addPage}>
                      <Plus size={14} />
                      Add page
                    </button>
                    <button
                      className="rb-button rb-wide rb-danger"
                      disabled={report.pages.length < 2}
                      onClick={deletePage}
                    >
                      <Trash2 size={14} />
                      Delete this page
                    </button>
                  </section>
                  <div className="rb-inspector-tip">
                    <MousePointer2 size={18} />
                    <p>
                      Select any block to edit its content, style, and position.
                    </p>
                  </div>
                </>
              )}
            </div>
          </aside>
        )}
      </div>
      <footer className="rb-statusbar">
        <span>
          <span className="rb-local-indicator" />
          On your device<span className="rb-footer-separator">·</span>
          {workspace ? 'Workspace snapshots' : 'Illustrative motor-test data'}
        </span>
        <span>
          {workspace ? 'Reports' : 'Report builder concept'}
          <span className="rb-footer-separator">·</span>
          Draft resets when closed
        </span>
      </footer>
      {notice && (
        <output className="rb-toast">
          <Check size={16} />
          <span>{notice}</span>
          <Tool
            icon={X}
            label="Dismiss notification"
            onClick={() => setNotice('')}
          />
        </output>
      )}
      <input
        ref={imageInputRef}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp"
        aria-label="Upload report image"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importImage(file, imageTarget.current);
          event.target.value = '';
        }}
      />
    </main>
  );
}
