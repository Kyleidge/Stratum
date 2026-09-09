import type { Operation, Project, SignalNode } from './signal-types';

export const operationLabels: Record<Operation, string> = {
  raw: 'Raw signal',
  crop: 'Segment',
  smooth: 'Moving average',
  median: 'Median filter',
  exponential: 'Exponential smoothing',
  'low-pass': 'Low-pass RC',
  'high-pass': 'High-pass RC',
  scale: 'Scale',
  offset: 'Value offset',
  absolute: 'Absolute value',
  derivative: 'Differentiate',
  integral: 'Integrate',
  'min-max': 'Min / Max',
  'time-shift': 'Shift time',
  'zero-time': 'Align to zero',
  resample: 'Resample',
  power: 'Brake power',
  bsfc: 'Specific fuel consumption',
};
export function operationDetail(node: SignalNode): string {
  const value = node.parameters.value;
  if (['smooth', 'median'].includes(node.operation)) return `${value} samples`;
  if (['low-pass', 'high-pass', 'resample'].includes(node.operation))
    return `${value} Hz`;
  if (node.operation === 'time-shift')
    return `${value >= 0 ? '+' : ''}${value} s`;
  if (node.operation === 'crop')
    return `${Number(node.parameters.start.toFixed(3))}–${Number(node.parameters.end.toFixed(3))} s`;
  if (node.operation === 'min-max') return 'Extrema · original timestamps';
  return Number.isFinite(value) &&
    !['absolute', 'zero-time', 'integral', 'derivative'].includes(
      node.operation,
    )
    ? String(value)
    : node.unit;
}
export type ExplorerEntry = {
  id: string;
  kind:
    | 'signal'
    | 'collection'
    | 'file'
    | 'folder'
    | 'file-operation'
    | 'file-segment';
  label: string;
  detail: string;
  ids: string[];
  node?: SignalNode;
  parent?: string;
  members: string[];
  next: string[];
  sequence: number;
  memberUnit?: 'signals' | 'segments';
  segmentationId?: string;
};
export type ExplorerModel = {
  entries: Map<string, ExplorerEntry>;
  roots: string[];
};
export type ExplorerRow = {
  entry: ExplorerEntry;
  indent: number;
  step: number;
};

export function buildExplorer(
  project: Project,
  sourceId: string,
): ExplorerModel {
  const entries = new Map<string, ExplorerEntry>();
  const source = project.sources.find((item) => item.id === sourceId);
  if (!source) return { entries, roots: [] };
  const fileId = `file:${sourceId}`;
  const originalsId = `originals:${sourceId}`;
  const nodes = project.nodes.filter((node) => node.sourceId === sourceId);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const fileSegments = new Set(
    project.segments
      .filter((segment) => {
        if (segment.sourceId !== sourceId || segment.scope === 'signals')
          return false;
        // Older recordings have no scope marker. Complete raw-channel coverage is
        // sufficient to display them as file segments without rewriting history.
        const parents = new Set(
          segment.nodes.flatMap((id) => {
            const node = byId.get(id);
            return node?.operation === 'crop' ? [node.parents[0]] : [];
          }),
        );
        return (
          parents.size === source.channels.length &&
          source.channels.every((id) => parents.has(id))
        );
      })
      .map((segment) => segment.id),
  );
  entries.set(fileId, {
    id: fileId,
    kind: 'file',
    label: source.name,
    detail: `${source.channels.length} original signals · ${source.rows.toLocaleString()} samples`,
    ids: source.channels,
    members: [],
    next: [],
    sequence: -2,
    memberUnit: 'signals',
  });
  entries.set(originalsId, {
    id: originalsId,
    kind: 'folder',
    label: 'Original signals',
    detail: `${source.channels.length} immutable signals`,
    ids: source.channels,
    parent: fileId,
    members: source.channels,
    next: [],
    sequence: Number.MAX_SAFE_INTEGER,
    memberUnit: 'signals',
  });
  const segmentByNode = new Map(
    project.segments.flatMap((segment) =>
      segment.nodes.map((id) => [id, segment] as const),
    ),
  );
  const legacyDefinitions = new Map<object, string>();
  const cropGroups = new Map<string, SignalNode[]>();
  const operationGroups = new Map<string, SignalNode[]>();
  const memberNames = new Map<string, string>();
  for (const [sequence, node] of nodes.entries()) {
    const segment = segmentByNode.get(node.id);
    const memberName = segment?.name ?? memberNames.get(node.parents[0]);
    if (memberName) memberNames.set(node.id, memberName);
    entries.set(node.id, {
      id: node.id,
      kind: 'signal',
      label:
        node.operation === 'raw'
          ? node.name
          : node.operation === 'crop'
            ? (segment?.name ?? 'Segment')
            : operationLabels[node.operation],
      detail: operationDetail(node),
      ids: [node.id],
      node,
      parent: node.operation === 'raw' ? originalsId : node.parents[0],
      members: [],
      next: [],
      sequence,
    });
    if (node.operation === 'crop' && segment) {
      let batchId = segment.batchId;
      if (!batchId && segment.definition) {
        batchId = legacyDefinitions.get(segment.definition) ?? segment.id;
        legacyDefinitions.set(segment.definition, batchId);
      }
      // Legacy segments without batch provenance remain distinct; never merge
      // separate revisions by name, thresholds, or matching input channels.
      const key = batchId ?? segment.id;
      const list = cropGroups.get(key) ?? [];
      list.push(node);
      cropGroups.set(key, list);
    } else if (node.batchId) {
      const list = operationGroups.get(node.batchId) ?? [];
      list.push(node);
      operationGroups.set(node.batchId, list);
    }
  }
  const owner = new Map<string, string>();
  for (const id of source.channels) owner.set(id, originalsId);
  function group(
    id: string,
    members: SignalNode[],
    parent: string,
    label: string,
    detail: string,
    segmentationId?: string,
  ) {
    const memberUnit = entries.get(parent)?.memberUnit ?? 'segments';
    entries.set(id, {
      id,
      kind: 'collection',
      label,
      detail,
      ids: members.map((node) => node.id),
      parent,
      members: members.map((node) => node.id),
      next: [],
      sequence: entries.get(members[0].id)!.sequence,
      memberUnit,
      segmentationId,
    });
    for (const node of members) {
      const entry = entries.get(node.id)!;
      entry.parent = id;
      entry.label =
        memberUnit === 'signals'
          ? node.name
          : (memberNames.get(node.id) ?? node.name);
      entry.detail = `${operationLabels[node.operation]} · ${operationDetail(node)}`;
      owner.set(node.id, id);
    }
  }
  const actions = [
    ...[...cropGroups].map(([batchId, members]) => ({
      batchId,
      members,
      segment: true,
    })),
    ...[...operationGroups].map(([batchId, members]) => ({
      batchId,
      members,
      segment: false,
    })),
  ].sort(
    (a, b) =>
      entries.get(a.members[0].id)!.sequence -
      entries.get(b.members[0].id)!.sequence,
  );
  // Build shared stages in append order, using exact collection membership.
  // Re-segmenting a collection remains one shared stage, with all new intervals
  // expandable beneath it; per-member deviations retain their own branches.
  for (const { batchId, members, segment } of actions) {
    if (
      segment &&
      members.every((node) => fileSegments.has(segmentByNode.get(node.id)!.id))
    ) {
      const actionId = `file-operation:${batchId}`;
      const grouped = new Map<string, SignalNode[]>();
      for (const node of members) {
        const id = segmentByNode.get(node.id)!.id;
        const channels = grouped.get(id) ?? [];
        channels.push(node);
        grouped.set(id, channels);
      }
      entries.set(actionId, {
        id: actionId,
        kind: 'file-operation',
        label: 'Segment',
        detail: `${grouped.size} file segments · all ${source.channels.length} signals`,
        ids: [],
        parent: fileId,
        members: [...grouped.keys()].map((id) => `file-segment:${id}`),
        next: [],
        sequence: entries.get(members[0].id)!.sequence,
        segmentationId: batchId,
      });
      for (const [id, channels] of grouped) {
        const saved = segmentByNode.get(channels[0].id)!;
        const segmentId = `file-segment:${id}`;
        entries.set(segmentId, {
          id: segmentId,
          kind: 'file-segment',
          label: `File ${saved.name.toLowerCase()}`,
          detail: `${Number(saved.start.toFixed(3))}–${Number(saved.end.toFixed(3))} s · ${channels.length} signals`,
          ids: channels.map((node) => node.id),
          parent: actionId,
          members: channels.map((node) => node.id),
          next: [],
          sequence: entries.get(channels[0].id)!.sequence,
          memberUnit: 'signals',
        });
        for (const node of channels) {
          const entry = entries.get(node.id)!;
          entry.parent = segmentId;
          entry.label = byId.get(node.parents[0])!.name;
          entry.detail = `Segmented signal · ${node.unit}`;
          owner.set(node.id, segmentId);
        }
      }
      continue;
    }
    const parent = owner.get(members[0].parents[0]);
    const collection = parent && entries.get(parent);
    if (
      collection &&
      (segment
        ? collection.kind === 'collection'
        : collection.kind === 'collection' || members.length > 1) &&
      members.every((node) => owner.get(node.parents[0]) === parent) &&
      new Set(members.map((node) => node.parents[0])).size ===
        collection.ids.length &&
      (segment || members.length === collection.ids.length)
    ) {
      group(
        segment ? `segments:${parent}:${batchId}` : `operation:${batchId}`,
        members,
        parent,
        segment ? 'Segment' : operationLabels[members[0].operation],
        segment
          ? `${members.length} intervals from ${collection.ids.length} members`
          : `${operationDetail(members[0])} · ${members.length} results`,
        segment ? batchId : undefined,
      );
    } else if (segment) {
      const inputs = new Map<string, SignalNode[]>();
      for (const node of members) {
        const list = inputs.get(node.parents[0]) ?? [];
        list.push(node);
        inputs.set(node.parents[0], list);
      }
      for (const [input, outputs] of inputs)
        group(
          `segments:${input}:${batchId}`,
          outputs,
          input,
          'Segment',
          `${outputs.length} interval${outputs.length === 1 ? '' : 's'}`,
          batchId,
        );
    }
  }
  const roots: string[] = [];
  for (const entry of entries.values()) {
    const parent = entry.parent && entries.get(entry.parent);
    if (!parent) roots.push(entry.id);
    else if (!parent.members.includes(entry.id)) parent.next.push(entry.id);
  }
  for (const entry of entries.values())
    entry.next.sort(
      (a, b) => entries.get(a)!.sequence - entries.get(b)!.sequence,
    );
  return { entries, roots };
}
export function explorerRows(
  model: ExplorerModel,
  expanded: Set<string>,
  query = '',
): ExplorerRow[] {
  const matching = new Set<string>();
  const search = query.trim().toLowerCase();
  if (search)
    for (const entry of model.entries.values()) {
      if (
        !`${entry.label} ${entry.detail} ${entry.node?.name ?? ''}`
          .toLowerCase()
          .includes(search)
      )
        continue;
      let cursor: ExplorerEntry | undefined = entry;
      while (cursor && !matching.has(cursor.id)) {
        matching.add(cursor.id);
        cursor = cursor.parent ? model.entries.get(cursor.parent) : undefined;
      }
    }
  const rows: ExplorerRow[] = [];
  const stack = model.roots
    .toReversed()
    .map((id) => ({ id, indent: 0, step: 0 }));
  while (stack.length) {
    const row = stack.pop()!;
    const entry = model.entries.get(row.id)!;
    if (search && !matching.has(entry.id)) continue;
    rows.push({ entry, indent: row.indent, step: row.step });
    const open = expanded.has(entry.id) || !!search;
    if (entry.kind === 'collection' || open) {
      for (const id of entry.next.toReversed()) {
        const next = model.entries.get(id)!;
        const operation =
          next.kind === 'collection' ||
          next.kind === 'file-operation' ||
          (next.node && next.node.operation !== 'raw');
        stack.push({
          id,
          indent:
            row.indent +
            (entry.kind === 'file' ||
            entry.kind === 'folder' ||
            entry.next.length > 1
              ? 1
              : 0),
          step: row.step + (operation ? 1 : 0),
        });
      }
    }
    if (open)
      for (const id of entry.members.toReversed())
        stack.push({ id, indent: row.indent + 1, step: row.step });
  }
  return rows;
}
export function revealEntry(model: ExplorerModel, id: string): Set<string> {
  const open = new Set<string>();
  let entry = model.entries.get(id);
  let child: string | undefined;
  while (entry) {
    // Shared successors are visible without opening the members of a collection.
    // Only expand a collection when the selected path enters one of its members.
    if (
      (entry.kind !== 'collection' && entry.kind !== 'file-operation') ||
      (child && entry.members.includes(child))
    )
      open.add(entry.id);
    child = entry.id;
    entry = entry.parent ? model.entries.get(entry.parent) : undefined;
  }
  return open;
}
