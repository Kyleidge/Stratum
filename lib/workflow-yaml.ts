/**
 * A strict YAML 1.2 subset for workflow files. It supports block and flow
 * collections, plain and quoted scalars, block literals and comments. Anchors,
 * aliases, tags, directives and multiple documents are rejected outright, so a
 * file can never expand beyond its own size or construct custom objects.
 */
export type YamlValue =
  | null
  | boolean
  | number
  | string
  | YamlValue[]
  | { [key: string]: YamlValue };
export type YamlMap = { [key: string]: YamlValue };

export class YamlError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(line > 0 ? `Line ${line}: ${message}` : message);
  }
}

export type YamlDocument = {
  value: YamlValue;
  /** First line of every mapping and sequence, for later validation errors. */
  lines: WeakMap<object, number>;
};

export const YAML_LIMITS = {
  bytes: 8 * 1024 * 1024,
  depth: 64,
  entries: 250_000,
  keyLength: 1024,
};
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type Line = { number: number; indent: number; text: string; raw: string };

/** Remove a trailing comment outside quotes; `#` must follow whitespace. */
function stripComment(text: string): string {
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (quote === '"' && char === '\\') i++;
      else if (char === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = '';
      }
    } else if (char === "'" || char === '"') {
      // Quotes only open a scalar at a token start.
      const before = text[i - 1];
      if (i === 0 || /[\s[{,:]/.test(before ?? '')) quote = char;
    } else if (char === '#' && (i === 0 || /\s/.test(text[i - 1])))
      return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function resolvePlain(text: string): YamlValue {
  if (/^(~|null|Null|NULL)?$/.test(text)) return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?[0-9]+$/.test(text)) return Number(text);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(text))
    return Number(text);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(text))
    return text.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(text)) return NaN;
  return text;
}

class Parser {
  private entries = 0;
  readonly lines = new WeakMap<object, number>();
  private position = 0;
  private rows: Line[];
  constructor(text: string) {
    if (text.length > YAML_LIMITS.bytes)
      throw new YamlError('Workflow files are limited to 8 MiB.', 0);
    this.rows = text
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .map((raw, index) => {
        const indent = raw.length - raw.replace(/^ +/, '').length;
        if (/^ *\t/.test(raw))
          throw new YamlError('Indent with spaces, not tabs.', index + 1);
        return { number: index + 1, indent, text: raw.slice(indent), raw };
      });
  }
  private fail(message: string, line?: Line): never {
    throw new YamlError(message, line?.number ?? this.rows.at(-1)?.number ?? 0);
  }
  private count(line: Line) {
    if (++this.entries > YAML_LIMITS.entries)
      this.fail('The workflow file has too many entries.', line);
  }
  /** The next line with content, skipping blanks and comment-only lines. */
  private peek(): Line | undefined {
    while (this.position < this.rows.length) {
      const line = this.rows[this.position];
      const content = stripComment(line.text);
      if (content) return line;
      this.position++;
    }
    return undefined;
  }
  parseDocument(): YamlValue {
    const first = this.peek();
    if (first && first.indent === 0 && /^---\s*$/.test(first.text)) {
      this.position++;
    }
    const start = this.peek();
    if (!start) return null;
    for (const line of this.rows) {
      if (
        line.indent === 0 &&
        /^(---|\.\.\.)(\s|$)/.test(line.text) &&
        line !== first
      )
        this.fail('Only one YAML document is supported per file.', line);
      if (line.indent === 0 && line.text.startsWith('%'))
        this.fail('YAML directives are not supported.', line);
    }
    const value = this.parseBlock(start.indent, 0);
    const extra = this.peek();
    if (extra) this.fail('Unexpected content. Check the indentation.', extra);
    return value;
  }
  private isSequenceItem(text: string) {
    return text === '-' || text.startsWith('- ');
  }
  private parseBlock(indent: number, depth: number): YamlValue {
    if (depth > YAML_LIMITS.depth)
      this.fail('The workflow file is nested too deeply.', this.peek());
    const line = this.peek();
    if (!line) return null;
    if (this.isSequenceItem(line.text))
      return this.parseSequence(indent, depth);
    if (this.keyEnd(stripComment(line.text)) >= 0)
      return this.parseMapping(indent, depth);
    // A lone scalar or flow collection as a nested block value.
    this.position++;
    return this.inline(stripComment(line.text), line, depth, indent);
  }
  private parseSequence(indent: number, depth: number): YamlValue[] {
    const items: YamlValue[] = [];
    const first = this.peek()!;
    this.lines.set(items, first.number);
    for (let line = this.peek(); line; line = this.peek()) {
      if (line.indent < indent) break;
      if (line.indent > indent)
        this.fail('Unexpected indentation inside a list.', line);
      if (!this.isSequenceItem(line.text)) break;
      this.count(line);
      const rest = line.text.slice(1);
      const offset = rest.length - rest.trimStart().length + 1;
      const content = stripComment(rest.trimStart());
      if (!content) {
        this.position++;
        const next = this.peek();
        items.push(
          next && next.indent > indent
            ? this.parseBlock(next.indent, depth + 1)
            : null,
        );
        continue;
      }
      // Re-read the item's content as a line of its own, aligned after "- ".
      this.rows[this.position] = {
        ...line,
        indent: indent + offset,
        text: rest.trimStart(),
      };
      if (
        this.isSequenceItem(content) ||
        (this.keyEnd(content) >= 0 && !/^[[{]/.test(content))
      )
        items.push(this.parseBlock(indent + offset, depth + 1));
      else {
        this.position++;
        items.push(this.inline(content, line, depth + 1, indent));
      }
    }
    return items;
  }
  /** Index of a mapping colon in block context, or -1. */
  private keyEnd(text: string): number {
    if (!text || /^[[{]/.test(text)) return -1;
    if (text[0] === '"' || text[0] === "'") {
      const close = this.quoteEnd(text, 0);
      if (close < 0) return -1;
      return text[close + 1] === ':' &&
        (close + 2 === text.length || text[close + 2] === ' ')
        ? close + 1
        : -1;
    }
    for (let i = 0; i < text.length; i++)
      if (text[i] === ':' && (i + 1 === text.length || text[i + 1] === ' '))
        return i;
    return -1;
  }
  private quoteEnd(text: string, start: number): number {
    const quote = text[start];
    for (let i = start + 1; i < text.length; i++) {
      if (quote === '"' && text[i] === '\\') i++;
      else if (text[i] === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else return i;
      }
    }
    return -1;
  }
  private key(text: string, line: Line): string {
    let key: string;
    if (text[0] === '"' || text[0] === "'") {
      const value = this.quoted(text, line);
      key = value;
    } else {
      key = text.trim();
      if (/^[&*!?|>%@`]/.test(key))
        this.fail(`Unsupported key "${key}". Quote it or rename it.`, line);
    }
    if (!key) this.fail('A key cannot be empty.', line);
    if (key.length > YAML_LIMITS.keyLength)
      this.fail('A key is too long.', line);
    if (FORBIDDEN_KEYS.has(key))
      this.fail(`The key "${key}" is not allowed.`, line);
    return key;
  }
  private parseMapping(indent: number, depth: number): YamlMap {
    const map: YamlMap = {};
    const first = this.peek()!;
    this.lines.set(map, first.number);
    for (let line = this.peek(); line; line = this.peek()) {
      if (line.indent < indent) break;
      if (line.indent > indent)
        this.fail('Unexpected indentation. Align keys in this block.', line);
      if (this.isSequenceItem(line.text)) break;
      const text = stripComment(line.text);
      const colon = this.keyEnd(text);
      if (colon < 0)
        this.fail('Expected "key: value". Check for a missing colon.', line);
      const key = this.key(text.slice(0, colon), line);
      if (Object.hasOwn(map, key))
        this.fail(`The key "${key}" appears twice.`, line);
      this.count(line);
      const rest = text.slice(colon + 1).trim();
      this.position++;
      if (!rest) {
        const next = this.peek();
        if (next && next.indent > indent)
          map[key] = this.parseBlock(next.indent, depth + 1);
        else if (
          next &&
          next.indent === indent &&
          this.isSequenceItem(next.text)
        )
          map[key] = this.parseSequence(indent, depth + 1);
        else map[key] = null;
      } else if (/^[|>][-+]?$/.test(rest)) {
        map[key] = this.blockScalar(rest, indent);
      } else {
        map[key] = this.inline(rest, line, depth + 1, indent);
      }
    }
    return map;
  }
  private blockScalar(header: string, indent: number): string {
    const parts: string[] = [];
    let contentIndent = -1;
    while (this.position < this.rows.length) {
      const line = this.rows[this.position];
      const blank = !line.raw.trim();
      if (!blank && line.indent <= indent) break;
      if (!blank && contentIndent < 0) contentIndent = line.indent;
      if (!blank && line.indent < contentIndent)
        this.fail('Block text lines must share one indentation.', line);
      parts.push(blank ? '' : line.raw.slice(contentIndent));
      this.position++;
    }
    if (contentIndent < 0) return '';
    let trailing = 0;
    while (parts.length && parts.at(-1) === '') {
      parts.pop();
      trailing++;
    }
    let text =
      header[0] === '|'
        ? parts.join('\n')
        : parts.reduce(
            (joined, part, i) =>
              i === 0
                ? part
                : part === '' || parts[i - 1] === ''
                  ? `${joined}\n${part}`
                  : `${joined} ${part}`,
            '',
          );
    const chomp = header[1];
    if (chomp === '+') text += '\n'.repeat(trailing + 1);
    else if (chomp !== '-') text += '\n';
    return text;
  }
  /** A scalar or flow collection that starts on the current line. */
  private inline(
    text: string,
    line: Line,
    depth: number,
    indent: number,
  ): YamlValue {
    if (/^[&*!]/.test(text))
      this.fail('Anchors, aliases and tags are not supported.', line);
    if (/^[%@`]/.test(text))
      this.fail(`Quote values that start with "${text[0]}".`, line);
    if (text[0] === '[' || text[0] === '{') {
      let source = text;
      while (!this.balanced(source)) {
        const next = this.rows[this.position];
        if (!next)
          this.fail('A bracketed list or mapping is not closed.', line);
        this.position++;
        const content = stripComment(next.text);
        if (content) source += ` ${content}`;
      }
      const flow = new FlowParser(source, line.number, depth, this);
      return flow.parse();
    }
    if (text[0] === '"' || text[0] === "'") {
      const end = this.quoteEnd(text, 0);
      if (end < 0)
        this.fail(
          'Close the quote on the same line, or use a "|" block for long text.',
          line,
        );
      if (text.slice(end + 1).trim())
        this.fail('Unexpected text after a quoted value.', line);
      return this.quoted(text, line);
    }
    // Plain scalars may continue on more indented lines; they fold with spaces.
    let value = text;
    for (
      let next = this.peek();
      next && next.indent > indent;
      next = this.peek()
    ) {
      if (
        this.isSequenceItem(next.text) ||
        this.keyEnd(stripComment(next.text)) >= 0
      )
        this.fail('Unexpected indentation. Check the line above.', next);
      value += ` ${stripComment(next.text)}`;
      this.position++;
    }
    return resolvePlain(value);
  }
  private balanced(text: string): boolean {
    let depth = 0,
      quote = '';
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quote) {
        if (quote === '"' && char === '\\') i++;
        else if (char === quote) {
          if (quote === "'" && text[i + 1] === "'") i++;
          else quote = '';
        }
      } else if (
        (char === '"' || char === "'") &&
        (i === 0 || /[\s[{,:]/.test(text[i - 1]))
      )
        quote = char;
      else if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') depth--;
    }
    return depth <= 0 && !quote;
  }
  quoted(text: string, line: Line | number): string {
    const lineRef =
      typeof line === 'number'
        ? { number: line, indent: 0, text: '', raw: '' }
        : line;
    const end = this.quoteEnd(text, 0);
    if (end < 0) this.fail('A quoted value is not closed.', lineRef);
    const body = text.slice(1, end);
    if (text[0] === "'") return body.replaceAll("''", "'");
    return body.replace(
      /\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g,
      (match, code: string) => {
        if (code[0] === 'u' || code[0] === 'x')
          return String.fromCharCode(parseInt(code.slice(1), 16));
        const escapes: Record<string, string> = {
          n: '\n',
          t: '\t',
          r: '\r',
          '0': '\0',
          '"': '"',
          '\\': '\\',
          '/': '/',
          ' ': ' ',
        };
        if (!(code in escapes))
          this.fail(`Unsupported escape "${match}".`, lineRef);
        return escapes[code];
      },
    );
  }
  register(value: object, line: number) {
    this.lines.set(value, line);
    if (++this.entries > YAML_LIMITS.entries)
      throw new YamlError('The workflow file has too many entries.', line);
  }
}

class FlowParser {
  private index = 0;
  constructor(
    private text: string,
    private line: number,
    private depth: number,
    private owner: Parser,
  ) {}
  private fail(message: string): never {
    throw new YamlError(message, this.line);
  }
  parse(): YamlValue {
    const value = this.value(this.depth);
    this.space();
    if (this.index < this.text.length)
      this.fail('Unexpected text after a bracketed value.');
    return value;
  }
  private space() {
    while (this.index < this.text.length && /\s/.test(this.text[this.index]))
      this.index++;
  }
  private value(depth: number): YamlValue {
    if (depth > YAML_LIMITS.depth) this.fail('Values are nested too deeply.');
    this.space();
    const char = this.text[this.index];
    if (char === '[') return this.sequence(depth);
    if (char === '{') return this.mapping(depth);
    if (char === '"' || char === "'") return this.quoted();
    return this.plain(false);
  }
  private quoted(): string {
    const rest = this.text.slice(this.index);
    const quote = rest[0];
    let end = -1;
    for (let i = 1; i < rest.length; i++) {
      if (quote === '"' && rest[i] === '\\') i++;
      else if (rest[i] === quote) {
        if (quote === "'" && rest[i + 1] === "'") i++;
        else {
          end = i;
          break;
        }
      }
    }
    if (end < 0) this.fail('A quoted value is not closed.');
    this.index += end + 1;
    return this.owner.quoted(rest.slice(0, end + 1), this.line);
  }
  private plain(key: boolean): YamlValue {
    const start = this.index;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === ',' || char === ']' || char === '}') break;
      if (
        char === ':' &&
        (key ||
          this.index + 1 === this.text.length ||
          /[\s,\]}]/.test(this.text[this.index + 1]))
      )
        break;
      if (char === '[' || char === '{') {
        const word = this.text.slice(start, this.index).trim();
        this.fail(
          word
            ? `Inside { } or [ ], quote values with brackets, for example '${word}[2]'.`
            : 'Quote values that contain brackets.',
        );
      }
      this.index++;
    }
    const text = this.text.slice(start, this.index).trim();
    if (/^[&*!]/.test(text))
      this.fail('Anchors, aliases and tags are not supported.');
    if (/^[%@`|>?]/.test(text))
      this.fail(`Quote values that start with "${text[0]}".`);
    return key ? text : resolvePlain(text);
  }
  private sequence(depth: number): YamlValue[] {
    const items: YamlValue[] = [];
    this.owner.register(items, this.line);
    this.index++;
    this.space();
    if (this.text[this.index] === ']') {
      this.index++;
      return items;
    }
    for (;;) {
      items.push(this.value(depth + 1));
      this.space();
      const char = this.text[this.index++];
      if (char === ']') return items;
      if (char !== ',') this.fail('Separate list items with commas.');
      this.space();
      if (this.text[this.index] === ']') {
        this.index++;
        return items;
      }
    }
  }
  private mapping(depth: number): YamlMap {
    const map: YamlMap = {};
    this.owner.register(map, this.line);
    this.index++;
    this.space();
    if (this.text[this.index] === '}') {
      this.index++;
      return map;
    }
    for (;;) {
      this.space();
      const char = this.text[this.index];
      const key =
        char === '"' || char === "'"
          ? this.quoted()
          : (this.plain(true) as string);
      if (!key) this.fail('A key cannot be empty.');
      if (FORBIDDEN_KEYS.has(key))
        this.fail(`The key "${key}" is not allowed.`);
      if (Object.hasOwn(map, key)) this.fail(`The key "${key}" appears twice.`);
      this.space();
      if (this.text[this.index] !== ':')
        this.fail(`Expected ":" after "${key}".`);
      this.index++;
      this.space();
      const next = this.text[this.index];
      map[key] = next === ',' || next === '}' ? null : this.value(depth + 1);
      this.space();
      const end = this.text[this.index++];
      if (end === '}') return map;
      if (end !== ',') this.fail('Separate mapping entries with commas.');
      this.space();
      if (this.text[this.index] === '}') {
        this.index++;
        return map;
      }
    }
  }
}

export function parseYaml(text: string): YamlDocument {
  const parser = new Parser(text);
  return { value: parser.parseDocument(), lines: parser.lines };
}

// ---------------------------------------------------------------------------
// Serialisation

const INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;

/** Control characters other than the line feed, which block text allows. */
function control(text: string, allowLineFeed = false): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 || code === 0x7f) && !(allowLineFeed && code === 0x0a))
      return true;
  }
  return false;
}

function plainSafe(text: string, flow: boolean): boolean {
  if (!text || text !== text.trim()) return false;
  if (resolvePlain(text) !== text) return false;
  if (INDICATOR.test(text) && !/^-[^\s-]/.test(text)) return false;
  if (control(text)) return false;
  if (text.includes(': ') || text.includes(' #') || text.endsWith(':'))
    return false;
  if (flow && /[,[\]{}]/.test(text)) return false;
  return true;
}

function quote(text: string): string {
  if (!control(text)) return `'${text.replaceAll("'", "''")}'`;
  const escapes: Record<string, string> = {
    '\\': '\\\\',
    '"': '\\"',
    '\n': '\\n',
    '\t': '\\t',
    '\r': '\\r',
  };
  let quoted = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    quoted +=
      escapes[char] ??
      (code < 0x20 || code === 0x7f
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : char);
  }
  return `"${quoted}"`;
}

function scalar(value: YamlValue, flow = false): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '.nan';
    if (!Number.isFinite(value)) return value > 0 ? '.inf' : '-.inf';
    return String(value);
  }
  if (typeof value === 'string')
    return plainSafe(value, flow) ? value : quote(value);
  throw new Error('Not a scalar.');
}

const isScalar = (value: YamlValue) =>
  value === null || typeof value !== 'object';

/** Single-line flow form when short and free of multi-line text. */
function flow(value: YamlValue): string | undefined {
  if (isScalar(value)) {
    if (typeof value === 'string' && value.includes('\n')) return undefined;
    return scalar(value, true);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const text = flow(item);
      if (text === undefined) return undefined;
      parts.push(text);
    }
    return `[${parts.join(', ')}]`;
  }
  const parts: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    const text = flow(item);
    if (text === undefined) return undefined;
    parts.push(`${scalar(key, true)}: ${text}`);
  }
  return parts.length ? `{ ${parts.join(', ')} }` : '{}';
}

function multiline(text: string): boolean {
  return (
    text.includes('\n') &&
    !text.endsWith('\n') &&
    !/^[ \n]/.test(text) &&
    !control(text, true) &&
    !/ \n| $/.test(text)
  );
}

function emit(
  value: YamlValue,
  indent: number,
  width: number,
  lines: string[],
  depth: number,
  flowAfter: number,
) {
  const pad = ' '.repeat(indent);
  const inline = (item: YamlValue, used: number, nested: number) => {
    if (isScalar(item)) return undefined;
    const scalars = Array.isArray(item) && item.every(isScalar);
    if (!scalars && nested < flowAfter) return undefined;
    const text = flow(item);
    return text !== undefined && used + text.length <= width ? text : undefined;
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isScalar(item) && !(typeof item === 'string' && multiline(item))) {
        lines.push(`${pad}- ${scalar(item)}`);
        continue;
      }
      // Mappings in a list (such as steps) always use block form.
      const short = Array.isArray(item)
        ? inline(item, pad.length + 2, depth + 1)
        : undefined;
      if (short !== undefined) {
        lines.push(`${pad}- ${short}`);
        continue;
      }
      const nested: string[] = [];
      if (typeof item === 'string')
        nested.push(
          '|-',
          ...item.split('\n').map((part) => (part ? `  ${part}` : '')),
        );
      else emit(item, 0, width - indent - 2, nested, depth + 1, flowAfter);
      if (!nested.length) {
        lines.push(`${pad}- ${Array.isArray(item) ? '[]' : '{}'}`);
        continue;
      }
      lines.push(`${pad}- ${nested[0]}`);
      for (const line of nested.slice(1))
        lines.push(line ? `${pad}  ${line}` : line);
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
    lines.push(`${pad}${scalar(value)}`);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const name = scalar(key);
    if (typeof item === 'string' && multiline(item)) {
      lines.push(`${pad}${name}: |-`);
      for (const part of item.split('\n'))
        lines.push(part ? `${pad}  ${part}` : '');
      continue;
    }
    if (isScalar(item)) {
      lines.push(`${pad}${name}: ${scalar(item)}`);
      continue;
    }
    if (Array.isArray(item) ? !item.length : !Object.keys(item).length) {
      lines.push(`${pad}${name}: ${Array.isArray(item) ? '[]' : '{}'}`);
      continue;
    }
    const short = inline(item, pad.length + name.length + 2, depth + 1);
    if (short !== undefined) {
      lines.push(`${pad}${name}: ${short}`);
      continue;
    }
    lines.push(`${pad}${name}:`);
    emit(item, indent + 2, width, lines, depth + 1, flowAfter);
  }
}

/**
 * Readable block YAML. Collections at least `flowAfter` levels deep, and lists
 * of scalars, are written on one line when they fit within the print width.
 */
export function stringifyYaml(
  value: YamlValue,
  options: { comments?: string[]; width?: number; flowAfter?: number } = {},
): string {
  const lines = (options.comments ?? []).map((line) =>
    line ? `# ${line}` : '#',
  );
  emit(value, 0, options.width ?? 80, lines, 0, options.flowAfter ?? 2);
  return `${lines.join('\n')}\n`;
}
