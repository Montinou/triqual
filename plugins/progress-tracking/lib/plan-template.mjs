// The template engine of `triqual plan generate` (design S7). Pure: no I/O, no clock, imports nothing.
//   {{key}}                    the value of `key` (a string, number or boolean)
//   {{#each key}} … {{/each}}  the body once per item of the array `key` (items are objects); one level, no nesting
//   {{field}} inside a block   the item's value, else the plan's; {{@n}} is the 1-based index of the item
// A block tag alone on its line takes the whole line with it, so a block adds no blank lines. A missing (or null) key, a
// value of another type, an #each over a non-array, a nested, unclosed or stray block and any other tag throw a
// TemplateError `<where>:<line>: <reason> "<key>"`: a substitution is never silently empty.
export class TemplateError extends Error {
  constructor(where, line, reason, key) {
    super(`${where}:${line}: ${reason} "${key}"`);
    this.name = 'TemplateError';
  }
}

const TAG = /\{\{([^{}]*)\}\}/g;
const KEY = /^[A-Za-z_][\w-]*$/;
const OPEN = /^#each\s+(.*)$/;
const INDEX = '@n';

// Text and tags in order: { text } | { kind: 'var' | 'open' | 'close', key, line }.
function tokenize(template, where) {
  const tokens = [];
  let from = 0;
  let line = 1;
  let counted = 0; // template[0..counted) is already counted into `line`
  for (const m of template.matchAll(TAG)) {
    line += template.slice(counted, m.index).split('\n').length - 1;
    counted = m.index;
    let start = m.index;
    let end = start + m[0].length;
    const body = m[1].trim();
    const opening = OPEN.exec(body);
    const closing = body === '/each';
    const token = { line };
    if (opening) Object.assign(token, { kind: 'open', key: opening[1].trim() });
    else if (closing) Object.assign(token, { kind: 'close', key: 'each' });
    else if (body.startsWith('#') || body.startsWith('/')) throw new TemplateError(where, line, 'unknown tag', body);
    else Object.assign(token, { kind: 'var', key: body });
    if (token.kind !== 'var') {
      const lineStart = start === 0 ? 0 : template.lastIndexOf('\n', start - 1) + 1;
      const found = template.indexOf('\n', end);
      const lineEnd = found === -1 ? template.length : found;
      if (!template.slice(lineStart, start).trim() && !template.slice(end, lineEnd).trim()) {
        start = lineStart;
        end = found === -1 ? lineEnd : lineEnd + 1;
      }
    }
    if (start > from) tokens.push({ text: template.slice(from, start) });
    tokens.push(token);
    from = end;
  }
  if (from < template.length) tokens.push({ text: template.slice(from) });
  return tokens;
}

// The block structure: [{ text } | { var, line } | { each, line, body: [...] }]. One level only.
function parse(tokens, where) {
  const root = [];
  let block = null;
  for (const token of tokens) {
    if ('text' in token) (block ? block.body : root).push(token);
    else if (token.kind === 'var') (block ? block.body : root).push(token);
    else if (token.kind === 'open') {
      if (block) throw new TemplateError(where, token.line, 'nested #each', token.key);
      if (!KEY.test(token.key)) throw new TemplateError(where, token.line, 'not a plain key', token.key);
      block = { kind: 'each', key: token.key, line: token.line, body: [] };
      root.push(block);
    } else {
      if (!block) throw new TemplateError(where, token.line, '{{/each}} without #each', token.key);
      block = null;
    }
  }
  if (block) throw new TemplateError(where, block.line, 'unclosed #each', block.key);
  return root;
}

const present = (v) => v !== undefined && v !== null;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function render(template, data, where) {
  const nodes = parse(tokenize(template, where), where);
  const lookup = (key, line, item) => {
    if (!KEY.test(key)) throw new TemplateError(where, line, 'not a plain key', key);
    const value = item !== null && Object.hasOwn(item, key) && present(item[key]) ? item[key] : (Object.hasOwn(data, key) ? data[key] : undefined);
    if (!present(value)) throw new TemplateError(where, line, 'missing key', key);
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new TemplateError(where, line, 'not a string, number or boolean', key);
    return String(value);
  };
  const emit = (list, item, n) => list.map((node) => {
    if ('text' in node) return node.text;
    if (node.key === INDEX) {
      if (n === null) throw new TemplateError(where, node.line, '{{@n}} outside #each', INDEX);
      return String(n);
    }
    return lookup(node.key, node.line, item);
  }).join('');
  return nodes.map((node) => {
    if (node.kind !== 'each') return emit([node], null, null);
    const items = Object.hasOwn(data, node.key) ? data[node.key] : undefined;
    if (!present(items)) throw new TemplateError(where, node.line, 'missing key', node.key);
    if (!Array.isArray(items)) throw new TemplateError(where, node.line, 'not an array', node.key);
    return items.map((item, i) => {
      if (!isObject(item)) throw new TemplateError(where, node.line, `item ${i + 1} is not an object`, node.key);
      return emit(node.body, item, i + 1);
    }).join('');
  }).join('');
}
