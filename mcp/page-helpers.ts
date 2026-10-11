/**
 * In-page helpers for UI sessions, installed as `globalThis.__stratumMcp`.
 * `installPageHelpers` runs inside the page (its source is sent over CDP),
 * so it must stay self-contained: no imports or outer variables.
 *
 * Selectors, as in Playwright: `e12` or `ref=e12` (from ui_snapshot),
 * `role=button[name="Derive"]` (name: exact, else substring; case-insensitive),
 * `text=Torque` (substring) or `text="Torque"` (exact), `label=Name` (a
 * control by accessible name), or any CSS selector. Chain with `>>`, and pick
 * a match with `>> nth=1` (0-based; -1 is the last).
 */
export function installPageHelpers() {
  type Helpers = Record<string, unknown> & { refs: number };
  const scope = globalThis as unknown as { __stratumMcp?: Helpers };
  if (scope.__stratumMcp) return;

  const normal = (text: string | null | undefined) =>
    (text ?? '').replace(/\s+/g, ' ').trim();

  const implicitRole = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    switch (tag) {
      case 'a':
        return element.hasAttribute('href') ? 'link' : '';
      case 'button':
        return 'button';
      case 'summary':
        return 'button';
      case 'select':
        return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
      case 'option':
        return 'option';
      case 'textarea':
        return 'textbox';
      case 'input':
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (['button', 'submit', 'reset', 'image'].includes(type))
          return 'button';
        if (type === 'hidden' || type === 'file') return '';
        return element.hasAttribute('list') ? 'combobox' : 'textbox';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'dialog':
        return 'dialog';
      case 'img':
        return element.getAttribute('alt') === '' ? '' : 'img';
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'aside':
        return 'complementary';
      case 'table':
        return 'table';
      case 'tr':
        return 'row';
      case 'th':
        return 'columnheader';
      case 'td':
        return 'cell';
      case 'ul':
      case 'ol':
        return 'list';
      case 'li':
        return 'listitem';
      case 'form':
        return 'form';
      case 'progress':
        return 'progressbar';
      case 'section':
        return element.hasAttribute('aria-label') ||
          element.hasAttribute('aria-labelledby')
          ? 'region'
          : '';
      default:
        return '';
    }
  };
  const role = (element: Element) =>
    (element.getAttribute('role') ?? '').split(/\s+/)[0] ||
    implicitRole(element);

  const text = (element: Element) =>
    normal(
      element instanceof HTMLElement ? element.innerText : element.textContent,
    );
  const name = (element: Element): string => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const label = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((item): item is HTMLElement => !!item)
        .map(text)
        .join(' ');
      if (label) return label;
    }
    const aria = normal(element.getAttribute('aria-label'));
    if (aria) return aria;
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      const labels = element.labels ? [...element.labels].map(text) : [];
      if (labels.join('')) return normal(labels.join(' '));
      if ('placeholder' in element && element.placeholder)
        return normal(element.placeholder);
      if (element instanceof HTMLInputElement && element.type === 'submit')
        return element.value;
    }
    if (element instanceof HTMLImageElement) return normal(element.alt);
    const own = role(element);
    if (
      [
        'button',
        'link',
        'heading',
        'option',
        'menuitem',
        'menuitemcheckbox',
        'menuitemradio',
        'tab',
        'cell',
        'columnheader',
        'checkbox',
        'radio',
        'switch',
        'treeitem',
        'listitem',
        'row',
      ].includes(own) ||
      element.tagName === 'LABEL'
    ) {
      const content = text(element);
      if (content) return content.slice(0, 200);
    }
    return normal(element.getAttribute('title'));
  };

  const visible = (element: Element) => {
    if (!element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return (
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) > 0
    );
  };

  const all = (root: ParentNode) =>
    [...root.querySelectorAll('*')] as Element[];

  /** One selector part within `roots`. */
  const part = (roots: ParentNode[], selector: string): Element[] => {
    const trimmed = selector.trim();
    const results: Element[] = [];
    const ref = /^(?:ref=)?(e\d+)$/.exec(trimmed);
    if (ref) {
      for (const root of roots)
        results.push(...root.querySelectorAll(`[data-mcp-ref="${ref[1]}"]`));
      return results;
    }
    const quoted = (value: string) => {
      const match = /^"(.*)"$|^'(.*)'$/.exec(value.trim());
      return match ? { value: match[1] ?? match[2], exact: true } : null;
    };
    const matches = (actual: string, wanted: string, exact: boolean) => {
      const a = normal(actual).toLowerCase(),
        b = normal(wanted).toLowerCase();
      return exact ? a === b : a.includes(b);
    };
    const byName = (elements: Element[], wanted: string | undefined) => {
      if (wanted === undefined) return elements;
      const q = quoted(wanted);
      const value = q ? q.value : wanted;
      const exact = elements.filter((element) =>
        matches(name(element), value, true),
      );
      return exact.length || q
        ? exact
        : elements.filter((element) => matches(name(element), value, false));
    };
    const roleMatch = /^role=([a-z]+)(?:\[name=(.*)\])?$/i.exec(trimmed);
    if (roleMatch) {
      const wanted = roleMatch[1].toLowerCase();
      for (const root of roots)
        results.push(
          ...byName(
            all(root).filter((element) => role(element) === wanted),
            roleMatch[2],
          ),
        );
      return results;
    }
    const labelMatch = /^label=(.*)$/i.exec(trimmed);
    if (labelMatch) {
      for (const root of roots)
        results.push(
          ...byName(
            all(root).filter((element) =>
              [
                'textbox',
                'combobox',
                'spinbutton',
                'checkbox',
                'radio',
                'slider',
                'switch',
                'listbox',
              ].includes(role(element)),
            ),
            labelMatch[1],
          ),
        );
      return results;
    }
    const textMatch = /^text=(.*)$/i.exec(trimmed);
    if (textMatch) {
      const q = quoted(textMatch[1]);
      const wanted = q ? q.value : textMatch[1];
      for (const root of roots) {
        const candidates = all(root).filter(
          (element) =>
            !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(element.tagName) &&
            matches(text(element), wanted, !!q),
        );
        // The innermost elements holding the text, not their ancestors.
        results.push(
          ...candidates.filter(
            (element) =>
              !candidates.some(
                (other) => other !== element && element.contains(other),
              ),
          ),
        );
      }
      return results;
    }
    for (const root of roots) results.push(...root.querySelectorAll(trimmed));
    return results;
  };

  const find = (selector: string): Element[] => {
    let roots: ParentNode[] = [document];
    let found: Element[] = [];
    for (const piece of selector.split(/\s*>>\s*/)) {
      const nth = /^nth=(-?\d+)$/.exec(piece.trim());
      if (nth) {
        const index = Number(nth[1]);
        const pick = found.at(index);
        found = pick ? [pick] : [];
      } else {
        found = [...new Set(part(roots, piece))];
        // Prefer what the user can see, as Playwright's actions do.
        const shown = found.filter(visible);
        if (shown.length) found = shown;
      }
      roots = found as unknown as ParentNode[];
    }
    return found;
  };

  const describe = (element: Element) => {
    const own = role(element) || element.tagName.toLowerCase();
    const label = name(element);
    return label ? `${own} "${label.slice(0, 80)}"` : own;
  };

  /** Scrolls the first match into view and returns its centre. */
  const locate = (selector: string) => {
    const found = find(selector);
    const element = found[0];
    if (!element) return { found: 0 };
    if (!visible(element))
      return {
        found: found.length,
        visible: false,
        description: describe(element),
      };
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2,
      y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const covered =
      hit && hit !== element && !element.contains(hit) && !hit.contains(element)
        ? describe(hit)
        : undefined;
    return {
      found: found.length,
      visible: true,
      x,
      y,
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      },
      description: describe(element),
      ...(covered ? { covered } : {}),
    };
  };

  const helpers: Helpers = { refs: 0 };
  const ref = (element: Element) => {
    let id = element.getAttribute('data-mcp-ref');
    if (!id) {
      id = `e${++helpers.refs}`;
      element.setAttribute('data-mcp-ref', id);
    }
    return id;
  };

  const INTERACTIVE = new Set([
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'combobox',
    'listbox',
    'option',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'slider',
    'spinbutton',
    'switch',
    'treeitem',
    'searchbox',
  ]);
  const CONTAINERS = new Set([
    'dialog',
    'alertdialog',
    'menu',
    'menubar',
    'tablist',
    'tabpanel',
    'navigation',
    'main',
    'complementary',
    'region',
    'toolbar',
    'tree',
    'grid',
    'table',
    'row',
    'alert',
    'status',
    'tooltip',
    'group',
    'radiogroup',
    'form',
    'heading',
    'columnheader',
    'cell',
    'progressbar',
    'img',
  ]);

  const states = (element: Element) => {
    const out: string[] = [];
    const attr = (name: string) => element.getAttribute(name);
    if (
      attr('aria-disabled') === 'true' ||
      (element as HTMLButtonElement).disabled
    )
      out.push('disabled');
    const checked =
      attr('aria-checked') ??
      (element instanceof HTMLInputElement &&
      ['checkbox', 'radio'].includes(element.type)
        ? String(element.checked)
        : null);
    if (checked === 'true') out.push('checked');
    if (checked === 'mixed') out.push('mixed');
    if (attr('aria-selected') === 'true') out.push('selected');
    if (attr('aria-pressed') === 'true') out.push('pressed');
    if (attr('aria-expanded') === 'true') out.push('expanded');
    if (attr('aria-expanded') === 'false') out.push('collapsed');
    if (attr('aria-current') && attr('aria-current') !== 'false')
      out.push('current');
    if (document.activeElement === element) out.push('focused');
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      const value =
        element instanceof HTMLSelectElement
          ? normal(element.selectedOptions[0]?.textContent)
          : element.value;
      if (value && !['checkbox', 'radio'].includes(element.type))
        out.push(`value=${JSON.stringify(value.slice(0, 80))}`);
    } else if (attr('aria-valuenow'))
      out.push(`value=${attr('aria-valuenow')}`);
    return out.length ? ` [${out.join(', ')}]` : '';
  };

  /**
   * An indented outline of what is visible: containers, controls (with refs
   * for clicking) and, with `withText`, text blocks.
   */
  const snapshot = (
    selector: string | undefined,
    withText: boolean,
    limit: number,
  ) => {
    const root = selector ? find(selector)[0] : document.body;
    if (!root) return `No element matches ${selector}.`;
    const lines: string[] = [];
    let truncated = false;
    const walk = (element: Element, depth: number) => {
      if (lines.length >= limit) {
        truncated = true;
        return;
      }
      // A zero-size box (such as a scroll-locked body) can still hold
      // visible content; only hidden subtrees are skipped.
      const style = getComputedStyle(element);
      if (style.display === 'none' || Number(style.opacity) === 0) return;
      if (element.getAttribute('aria-hidden') === 'true') return;
      if (!visible(element)) {
        for (const child of element.children) walk(child, depth);
        return;
      }
      const own = role(element);
      const label = name(element);
      let next = depth;
      if (INTERACTIVE.has(own)) {
        lines.push(
          `${'  '.repeat(depth)}- ${own}${label ? ` "${label.slice(0, 100)}"` : ''} [${ref(element)}]${states(element)}`,
        );
        // Controls' own text is their name; list only nested controls.
        next = depth + 1;
      } else if (
        CONTAINERS.has(own) &&
        (label || !['row', 'cell', 'group', 'img'].includes(own))
      ) {
        lines.push(
          `${'  '.repeat(depth)}- ${own}${label ? ` "${label.slice(0, 100)}"` : ''}${own === 'dialog' || own === 'alertdialog' ? ` [${ref(element)}]` : ''}${states(element)}`,
        );
        next = depth + 1;
        if (own === 'heading' || own === 'cell' || own === 'columnheader')
          return;
      } else if (withText && element.tagName !== 'svg') {
        const own = [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => normal(node.textContent))
          .join(' ')
          .trim();
        if (own && !INTERACTIVE.has(role(element.parentElement ?? element)))
          lines.push(`${'  '.repeat(depth)}- text: ${own.slice(0, 160)}`);
      }
      if (element.tagName === 'svg' || element.tagName === 'SVG') return;
      for (const child of element.children) walk(child, next);
    };
    walk(root, 0);
    if (truncated)
      lines.push(
        `… truncated at ${limit} lines; snapshot a narrower target or raise limit.`,
      );
    return lines.join('\n');
  };

  const setSelect = (selector: string, option: string) => {
    const element = find(selector)[0];
    if (!(element instanceof HTMLSelectElement))
      throw new Error(`${selector} is not a native <select>.`);
    const choice = [...element.options].find(
      (item) =>
        normal(item.textContent) === normal(option) || item.value === option,
    );
    if (!choice)
      throw new Error(
        `No option "${option}". Options: ${[...element.options].map((item) => normal(item.textContent)).join(' | ')}`,
      );
    // The native setter, so React's change tracking sees the new value.
    // oxlint-disable-next-line typescript/unbound-method -- called on element below
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )?.set;
    setter?.call(element, choice.value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return normal(choice.textContent);
  };

  const focus = (selector: string) => {
    const element = find(selector)[0];
    if (!(element instanceof HTMLElement))
      throw new Error(`No element matches ${selector}.`);
    element.focus();
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    )
      element.select();
    return describe(element);
  };

  const info = (selector: string) => {
    const found = find(selector);
    return {
      count: found.length,
      visible: found.filter(visible).length,
      first: found[0] ? `${describe(found[0])}${states(found[0])}` : undefined,
    };
  };

  const readText = (selector: string | undefined, limit: number) => {
    const element = selector ? find(selector)[0] : document.body;
    if (!element) throw new Error(`No element matches ${selector}.`);
    const content =
      element instanceof HTMLElement
        ? element.innerText
        : (element.textContent ?? '');
    return content.length > limit
      ? `${content.slice(0, limit)}\n… ${content.length - limit} more characters`
      : content;
  };

  Object.assign(helpers, {
    find,
    locate,
    snapshot,
    setSelect,
    focus,
    info,
    readText,
    describe,
  });
  scope.__stratumMcp = helpers;
}
