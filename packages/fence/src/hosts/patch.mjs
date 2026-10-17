// The Codex `apply_patch` envelope -> the files it touches. Strict: any line the grammar does not
// allow makes the whole envelope unparseable (null), and the adapter turns that into an opaque call.
//
//   *** Begin Patch
//   *** Add File: <path>        then only `+` lines
//   *** Delete File: <path>     then nothing
//   *** Update File: <path>     then an optional `*** Move to: <path>` as its first line, then hunk
//                               lines (`@@…`, ` …`, `-…`, `+…`, empty, `*** End of File`)
//   *** End Patch
//
// Returns [{path, op, from?}] in envelope order: op is "add" | "update" | "delete" | "move"
// (an Update with a Move: `path` is the destination, `from` the source). Paths are the raw
// envelope strings; the adapter resolves them.

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const HEADER = /^\*\*\* (Add|Update|Delete) File: (.*)$/;
const MOVE = /^\*\*\* Move to: (.*)$/;
const HUNK_LINE = /^(@@.*|[ +-].*|)$/;

export function parseApplyPatch(text) {
  if (typeof text !== 'string' || text.includes('\u0000')) return null;
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  let s = 0;
  let e = lines.length;
  while (s < e && lines[s].trim() === '') s++;
  while (e > s && lines[e - 1].trim() === '') e--;
  if (e - s < 2 || lines[s].trim() !== BEGIN || lines[e - 1].trim() !== END) return null;

  const out = [];
  let cur = null; // {op, path, from?, body: number, moveSlot: boolean}
  const close = () => {
    if (cur === null) return true;
    if (cur.op === 'update' && cur.body === 0) return false; // an Update with no hunk and no Move
    out.push(cur.op === 'move' ? { path: cur.path, op: 'move', from: cur.from } : { path: cur.path, op: cur.op });
    return true;
  };
  for (let i = s + 1; i < e - 1; i++) {
    const line = lines[i];
    const header = HEADER.exec(line);
    if (header) {
      if (!close()) return null;
      const path = header[2].trim();
      if (path === '') return null;
      cur = { op: header[1].toLowerCase(), path, body: 0, moveSlot: header[1] === 'Update' };
      continue;
    }
    if (cur === null) return null;
    const move = MOVE.exec(line);
    if (move) {
      const dest = move[1].trim();
      if (!cur.moveSlot || dest === '') return null;
      cur = { op: 'move', path: dest, from: cur.path, body: 1, moveSlot: false };
      continue;
    }
    cur.moveSlot = false;
    if (cur.op === 'add') {
      if (!line.startsWith('+')) return null;
    } else if (cur.op === 'delete') {
      return null;
    } else if (line === '*** End of File') {
      if (cur.body === 0) return null;
    } else if (line.startsWith('***') || !HUNK_LINE.test(line)) {
      return null;
    }
    cur.body++;
  }
  if (!close() || out.length === 0) return null;
  return out;
}
