import type { Project, SignalNode } from './signal-types';
import type { TimeReference } from './time-types';
import { referenceClock } from './time-types';

export class SignalGraph {
  readonly nodes: Map<string, SignalNode>;
  readonly ranges = new Map<string, [number, number]>();
  readonly offsets = new Map<string, number>();
  readonly timeReferences = new Map<string, TimeReference>();
  constructor(project: Project) {
    this.nodes = new Map(project.nodes.map((node) => [node.id, node]));
    if (this.nodes.size !== project.nodes.length)
      throw new Error('The signal graph contains duplicate IDs.');
    const sources = new Map(
      project.sources.map((source) => [source.id, source]),
    );
    const degrees = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const node of project.nodes) {
      degrees.set(node.id, node.parents.length);
      for (const parent of node.parents) {
        if (!this.nodes.has(parent))
          throw new Error('A signal dependency is missing.');
        const list = children.get(parent) ?? [];
        list.push(node.id);
        children.set(parent, list);
      }
    }
    const ready = project.nodes
      .filter((node) => !node.parents.length)
      .map((node) => node.id);
    for (let cursor = 0; cursor < ready.length; cursor++) {
      const id = ready[cursor];
      const node = this.nodes.get(id)!;
      const source = sources.get(node.sourceId);
      if (!source && !node.parents.length)
        throw new Error('A signal recording is missing.');
      let [start, end] = node.parents.length
        ? this.ranges.get(node.parents[0])!
        : [source!.start, source!.end];
      let reference =
        node.timeReference ??
        (node.parents.length
          ? this.timeReferences.get(node.parents[0])!
          : source!.clock
            ? {
                id: node.sourceId,
                name: source!.name,
                kind: 'absolute' as const,
                clock: source!.clock,
              }
            : {
                id: node.sourceId,
                name: source!.name,
                kind: 'relative' as const,
              });
      const recipe = node.timeRecipe;
      if (recipe?.kind === 'align') {
        start = (start - recipe.anchor) * recipe.scale + recipe.target;
        end = (end - recipe.anchor) * recipe.scale + recipe.target;
      } else if (recipe?.kind === 'resample') {
        if (recipe.grid.kind === 'uniform') {
          start = recipe.grid.start;
          end =
            start +
            Math.floor((recipe.grid.end - start) * recipe.grid.rate) /
              recipe.grid.rate;
        } else {
          const range = this.ranges.get(recipe.grid.signalId)!;
          start = Math.max(range[0], recipe.grid.start);
          end = Math.min(range[1], recipe.grid.end);
        }
      } else if (recipe?.kind === 'crop') {
        start = Math.max(start, recipe.start);
        end = Math.min(end, recipe.end);
      }
      let offset = node.parents.length ? this.offsets.get(node.parents[0])! : 0;
      if (node.operation === 'crop') {
        start = Math.max(start, node.parameters.start);
        end = Math.min(end, node.parameters.end);
      }
      if (node.operation === 'time-shift') {
        start += node.parameters.value;
        end += node.parameters.value;
        offset += node.parameters.value;
        reference = {
          ...reference,
          id: node.id,
          name: `${reference.name} · shifted`,
        };
      }
      if (node.operation === 'zero-time') {
        const clock = referenceClock(reference);
        // The clock moves with the axis: time 0 is now the signal's start.
        reference = {
          ...reference,
          id: node.id,
          name: 'Signal start',
          ...(clock ? { clock: { ...clock, start: clock.start + start } } : {}),
        };
        offset -= start;
        end -= start;
        start = 0;
      }
      this.ranges.set(id, [start, end]);
      this.offsets.set(id, offset);
      this.timeReferences.set(id, reference);
      for (const child of children.get(id) ?? []) {
        const degree = degrees.get(child)! - 1;
        degrees.set(child, degree);
        if (!degree) ready.push(child);
      }
    }
    if (ready.length !== project.nodes.length)
      throw new Error(
        'The signal dependency graph contains a cycle or duplicate IDs.',
      );
  }
  find(id: string): SignalNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error('Signal no longer exists.');
    return node;
  }
  chain(id: string): SignalNode[] {
    const chain: SignalNode[] = [];
    let node: SignalNode | undefined = this.find(id);
    while (node) {
      chain.push(node);
      node = this.nodes.get(node.parents[0]);
    }
    return chain.reverse();
  }
}
