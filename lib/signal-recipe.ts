import type { SignalGraph } from './signal-graph';

const keys = new WeakMap<SignalGraph, Map<string, string>>();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Two seeded 53-bit string hashes (cyrb53), 106 bits in hexadecimal. */
function digest(text: string): string {
  const part = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed,
      h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0))
      .toString(16)
      .padStart(14, '0');
  };
  return part(0) + part(0x9e3779b9);
}

/**
 * Content key of everything that determines a signal's samples: its
 * operation, settings and time recipe, and its inputs' keys down to the
 * recorded channels. Names, colours, IDs and revisions are excluded, so an
 * Edit that changes settings gets a new key and an identical recipe shares one.
 * Iterative: chains thousands of steps deep never recurse.
 */
export function recipeKey(graph: SignalGraph, id: string): string {
  let memo = keys.get(graph);
  if (!memo) keys.set(graph, (memo = new Map()));
  const stack = [id];
  while (stack.length) {
    const current = stack.at(-1)!;
    if (memo.has(current)) {
      stack.pop();
      continue;
    }
    const node = graph.find(current);
    const missing = node.parents.filter((parent) => !memo.has(parent));
    if (missing.length) {
      stack.push(...missing);
      continue;
    }
    memo.set(
      current,
      digest(
        stableJson({
          operation: node.operation,
          parameters: node.parameters,
          ...(node.expression !== undefined
            ? { expression: node.expression }
            : {}),
          timeRecipe: node.timeRecipe ?? null,
          source:
            node.operation === 'raw' && !node.parents.length
              ? [node.sourceId, node.channel ?? null]
              : null,
          parents: node.parents.map((parent) => memo.get(parent)!),
        }),
      ),
    );
    stack.pop();
  }
  return memo.get(id)!;
}
