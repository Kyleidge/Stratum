/**
 * Formula expressions for derived signals: arithmetic over signals (single
 * capital letters, A being each input) and values (lowercase names). Parsed
 * to a tree and compiled to closures; never evaluated as JavaScript.
 */

export const MAX_FORMULA_LENGTH = 500;
const MAX_DEPTH = 40;

type Node =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; operator: '-' | '+'; operand: Node }
  | { kind: 'binary'; operator: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

type Fn = { arity: [number, number]; apply: (args: number[]) => number };
const FUNCTIONS: Record<string, Fn> = {
  abs: { arity: [1, 1], apply: ([x]) => Math.abs(x) },
  sqrt: { arity: [1, 1], apply: ([x]) => Math.sqrt(x) },
  exp: { arity: [1, 1], apply: ([x]) => Math.exp(x) },
  ln: { arity: [1, 1], apply: ([x]) => Math.log(x) },
  log10: { arity: [1, 1], apply: ([x]) => Math.log10(x) },
  sin: { arity: [1, 1], apply: ([x]) => Math.sin(x) },
  cos: { arity: [1, 1], apply: ([x]) => Math.cos(x) },
  tan: { arity: [1, 1], apply: ([x]) => Math.tan(x) },
  asin: { arity: [1, 1], apply: ([x]) => Math.asin(x) },
  acos: { arity: [1, 1], apply: ([x]) => Math.acos(x) },
  atan: { arity: [1, 1], apply: ([x]) => Math.atan(x) },
  atan2: { arity: [2, 2], apply: ([y, x]) => Math.atan2(y, x) },
  pow: { arity: [2, 2], apply: ([x, y]) => x ** y },
  floor: { arity: [1, 1], apply: ([x]) => Math.floor(x) },
  ceil: { arity: [1, 1], apply: ([x]) => Math.ceil(x) },
  round: { arity: [1, 1], apply: ([x]) => Math.round(x) },
  sign: { arity: [1, 1], apply: ([x]) => Math.sign(x) },
  min: { arity: [2, 16], apply: (args) => Math.min(...args) },
  max: { arity: [2, 16], apply: (args) => Math.max(...args) },
  hypot: { arity: [2, 16], apply: (args) => Math.hypot(...args) },
  clamp: {
    arity: [3, 3],
    apply: ([x, low, high]) => Math.min(high, Math.max(low, x)),
  },
  if: { arity: [3, 3], apply: ([test, a, b]) => (test !== 0 ? a : b) },
  and: { arity: [2, 2], apply: ([a, b]) => (a !== 0 && b !== 0 ? 1 : 0) },
  or: { arity: [2, 2], apply: ([a, b]) => (a !== 0 || b !== 0 ? 1 : 0) },
  not: { arity: [1, 1], apply: ([a]) => (a === 0 ? 1 : 0) },
};
const CONSTANTS: Record<string, number> = { pi: Math.PI };
export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS);

/** A signal variable: a single capital letter. */
export const isSignalVariable = (name: string) => /^[A-Z]$/.test(name);
/** A value variable: a lowercase name that is not a function or constant. */
export const isValueVariable = (name: string) =>
  /^[a-z][a-z0-9_]{0,31}$/.test(name) &&
  !Object.hasOwn(FUNCTIONS, name) &&
  !Object.hasOwn(CONSTANTS, name);

export class FormulaError extends Error {
  constructor(
    message: string,
    /** Character position of the problem, when known. */
    readonly position?: number,
  ) {
    super(position === undefined ? message : `${message} (at ${position + 1})`);
  }
}

type Token =
  | { kind: 'number'; value: number; at: number }
  | { kind: 'name'; value: string; at: number }
  | { kind: 'symbol'; value: string; at: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const symbols = [
    '<=',
    '>=',
    '==',
    '!=',
    '+',
    '-',
    '*',
    '/',
    '^',
    '%',
    '(',
    ')',
    ',',
    '<',
    '>',
  ];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]), at: i });
      i += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (name) {
      tokens.push({ kind: 'name', value: name[0], at: i });
      i += name[0].length;
      continue;
    }
    const symbol = symbols.find((item) => text.startsWith(item, i));
    if (!symbol) throw new FormulaError(`Unexpected "${char}"`, i);
    tokens.push({ kind: 'symbol', value: symbol, at: i });
    i += symbol.length;
  }
  return tokens;
}

function parse(text: string): Node {
  if (!text.trim()) throw new FormulaError('Enter a formula.');
  if (text.length > MAX_FORMULA_LENGTH)
    throw new FormulaError(
      `Formulas are limited to ${MAX_FORMULA_LENGTH} characters.`,
    );
  const tokens = tokenize(text);
  let position = 0;
  const peek = () => tokens[position];
  const at = () => peek()?.at ?? text.length;
  const take = (symbol: string) => {
    const token = peek();
    if (token?.kind === 'symbol' && token.value === symbol) {
      position++;
      return true;
    }
    return false;
  };
  const expect = (symbol: string) => {
    if (!take(symbol)) throw new FormulaError(`Expected "${symbol}"`, at());
  };
  const binary = (
    next: (depth: number) => Node,
    operators: string[],
  ): ((depth: number) => Node) =>
    function level(depth) {
      let left = next(depth);
      for (;;) {
        const token = peek();
        if (token?.kind !== 'symbol' || !operators.includes(token.value))
          return left;
        position++;
        left = {
          kind: 'binary',
          operator: token.value,
          left,
          right: next(depth),
        };
      }
    };
  function primary(depth: number): Node {
    if (depth > MAX_DEPTH)
      throw new FormulaError('This formula is nested too deeply.', at());
    const token = peek();
    if (!token) throw new FormulaError('The formula ends unexpectedly.');
    if (token.kind === 'number') {
      position++;
      return { kind: 'number', value: token.value };
    }
    if (token.kind === 'symbol' && token.value === '(') {
      position++;
      const inner = comparison(depth + 1);
      expect(')');
      return inner;
    }
    if (token.kind === 'name') {
      position++;
      if (take('(')) {
        const fn = FUNCTIONS[token.value];
        if (!fn)
          throw new FormulaError(`Unknown function "${token.value}"`, token.at);
        const args: Node[] = [];
        if (!take(')')) {
          do args.push(comparison(depth + 1));
          while (take(','));
          expect(')');
        }
        if (args.length < fn.arity[0] || args.length > fn.arity[1])
          throw new FormulaError(
            `${token.value} takes ${fn.arity[0] === fn.arity[1] ? fn.arity[0] : `${fn.arity[0]}–${fn.arity[1]}`} argument${fn.arity[1] === 1 ? '' : 's'}`,
            token.at,
          );
        return { kind: 'call', name: token.value, args };
      }
      if (Object.hasOwn(CONSTANTS, token.value))
        return { kind: 'number', value: CONSTANTS[token.value] };
      if (Object.hasOwn(FUNCTIONS, token.value))
        throw new FormulaError(`${token.value} needs ( )`, token.at);
      if (!isSignalVariable(token.value) && !isValueVariable(token.value))
        throw new FormulaError(
          `"${token.value}" is not a variable: use A–Z for signals and lowercase names for values`,
          token.at,
        );
      return { kind: 'variable', name: token.value };
    }
    throw new FormulaError(`Unexpected "${token.value}"`, token.at);
  }
  // Power binds tighter than unary minus and is right-associative: -2^2 = -4.
  function power(depth: number): Node {
    const base = primary(depth);
    if (!take('^')) return base;
    return {
      kind: 'binary',
      operator: '^',
      left: base,
      right: unary(depth + 1),
    };
  }
  function unary(depth: number): Node {
    if (depth > MAX_DEPTH)
      throw new FormulaError('This formula is nested too deeply.', at());
    const token = peek();
    if (
      token?.kind === 'symbol' &&
      (token.value === '-' || token.value === '+')
    ) {
      position++;
      return {
        kind: 'unary',
        operator: token.value,
        operand: unary(depth + 1),
      };
    }
    return power(depth);
  }
  const multiplicative = binary(unary, ['*', '/', '%']);
  const additive = binary(multiplicative, ['+', '-']);
  const comparison = binary(additive, ['<', '<=', '>', '>=', '==', '!=']);
  const tree = comparison(0);
  if (position < tokens.length)
    throw new FormulaError(`Unexpected "${peek()!.value}"`, at());
  return tree;
}

export type Formula = {
  expression: string;
  /** Signal variables used, in alphabetical order (A first when used). */
  signals: string[];
  /** Value variables used, in alphabetical order. */
  values: string[];
  /**
   * Evaluates one sample. `signals` and `values` follow the orders above.
   * Any missing input, or a non-finite result, gives NaN.
   */
  evaluate: (signals: ArrayLike<number>, values: ArrayLike<number>) => number;
};

const cache = new Map<string, Formula>();

/** Parse, check and compile a formula. Throws FormulaError when invalid. */
export function compileFormula(expression: string): Formula {
  const cached = cache.get(expression);
  if (cached) return cached;
  const tree = parse(expression);
  const signals = new Set<string>(),
    values = new Set<string>();
  const stack: Node[] = [tree];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.kind === 'variable')
      (isSignalVariable(node.name) ? signals : values).add(node.name);
    else if (node.kind === 'unary') stack.push(node.operand);
    else if (node.kind === 'binary') stack.push(node.left, node.right);
    else if (node.kind === 'call') stack.push(...node.args);
  }
  if (!signals.has('A'))
    throw new FormulaError('Use A, the input signal, in the formula.');
  const signalOrder = [...signals].sort();
  const valueOrder = [...values].sort();
  type Compiled = (s: ArrayLike<number>, v: ArrayLike<number>) => number;
  const compile = (node: Node): Compiled => {
    switch (node.kind) {
      case 'number': {
        const value = node.value;
        return () => value;
      }
      case 'variable': {
        if (isSignalVariable(node.name)) {
          const index = signalOrder.indexOf(node.name);
          return (s) => s[index];
        }
        const index = valueOrder.indexOf(node.name);
        return (_s, v) => v[index];
      }
      case 'unary': {
        const operand = compile(node.operand);
        return node.operator === '-' ? (s, v) => -operand(s, v) : operand;
      }
      case 'binary': {
        const a = compile(node.left),
          b = compile(node.right);
        switch (node.operator) {
          case '+':
            return (s, v) => a(s, v) + b(s, v);
          case '-':
            return (s, v) => a(s, v) - b(s, v);
          case '*':
            return (s, v) => a(s, v) * b(s, v);
          case '/':
            return (s, v) => a(s, v) / b(s, v);
          case '%':
            return (s, v) => a(s, v) % b(s, v);
          case '^':
            return (s, v) => a(s, v) ** b(s, v);
          case '<':
            return (s, v) => (a(s, v) < b(s, v) ? 1 : 0);
          case '<=':
            return (s, v) => (a(s, v) <= b(s, v) ? 1 : 0);
          case '>':
            return (s, v) => (a(s, v) > b(s, v) ? 1 : 0);
          case '>=':
            return (s, v) => (a(s, v) >= b(s, v) ? 1 : 0);
          case '==':
            return (s, v) => (a(s, v) === b(s, v) ? 1 : 0);
          default:
            return (s, v) => (a(s, v) !== b(s, v) ? 1 : 0);
        }
      }
      case 'call': {
        const args = node.args.map(compile);
        const fn = FUNCTIONS[node.name].apply;
        const buffer: number[] = Array.from({ length: args.length }, () => 0);
        return (s, v) => {
          for (let i = 0; i < args.length; i++) buffer[i] = args[i](s, v);
          return fn(buffer);
        };
      }
    }
  };
  const run = compile(tree);
  const formula: Formula = {
    expression,
    signals: signalOrder,
    values: valueOrder,
    evaluate: (s, v) => {
      for (let i = 0; i < s.length; i++) if (!Number.isFinite(s[i])) return NaN;
      const result = run(s, v);
      return Number.isFinite(result) ? result : NaN;
    },
  };
  if (cache.size > 200) cache.clear();
  cache.set(expression, formula);
  return formula;
}

/** The problem with a formula, or '' when it is valid. */
export function formulaProblem(expression: string): string {
  try {
    compileFormula(expression);
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid formula.';
  }
}
