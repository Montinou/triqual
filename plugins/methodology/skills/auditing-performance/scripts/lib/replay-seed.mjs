// Replay defect seeder. `plantInDiff(diffText, kind, pick = 0)` plants exactly one small defect on one added (`+`)
// line of a unified diff, so the replay judge can be scored against a known defect. It is deterministic: the
// candidates of `kind` are listed in diff order and `pick` chooses one (an out-of-range `pick` wraps around).
//
// Returns { diff, file, line, kind } or `null` when the diff has no candidate of that kind.
//   - file: the new-file path from the `+++ b/<path>` header.
//   - line: the new-file line number of the changed line. It is derived from the hunk header `@@ -a,b +c,d @@`:
//     the first line of the hunk body is line `c`; a context line (` `) and an added line (`+`) each advance the
//     counter by one, a removed line (`-`) and a `\ No newline` marker do not. For `drop-guard` it is the number
//     the removed guard had before it was removed.
//   - Only `+` lines inside a hunk are touched. `+++`/`---` file headers are recognised outside hunks only (the hunk
//     header's counts say where a hunk ends), so an added line whose text starts with `++` stays a body line.
//
// Kinds:
//   - flip-comparison: the first whitespace-delimited `>=` becomes `>`, or `>` becomes `>=`.
//   - off-by-one: in an added `for`/`while` header line, the first whitespace-delimited `<` becomes `<=`.
//   - drop-guard: an added single-line guard (`if (x == null) return;`, `if (!x) return v;`) is removed; the hunk's
//     new-side count, and the new-side start of the later hunks of the same file, are adjusted so the diff stays
//     well formed. A guard that is the only new-side line of its hunk is not a candidate.
// Comment lines (`//`, `/*`, `*`, `#`) are never candidates.

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const COMMENT = /^\s*(?:\/\/|\/\*|\*|#)/;

const FLIP = /(?<=\s)(>=|>)(?=\s)/;
const LOOP = /(\b(?:for|while)\b.*?\s)<(\s)/;
const GUARD = /^\s*if\s*\(\s*(?:!\s*[\w.$]+|[\w.$]+\s*===?\s*(?:null|undefined))\s*\)\s*return\b[^;{}]*;?\s*$/;

const KINDS = {
  'flip-comparison': {
    matches: (text) => FLIP.test(text),
    mutate: (text) => text.replace(FLIP, (op) => (op === '>=' ? '>' : '>=')),
  },
  'off-by-one': {
    matches: (text) => LOOP.test(text),
    mutate: (text) => text.replace(LOOP, '$1<=$2'),
  },
  'drop-guard': {
    matches: (text) => GUARD.test(text),
    mutate: null,
  },
};

// Every added line of the diff, in order, with where it sits ({ idx, file, fileId, line, hunk, text }), and every hunk
// header ({ idx, fileId, newCount }).
function scan(lines) {
  const added = [];
  const hunks = []; // { idx, fileId }
  let file = null;
  let fileId = -1;
  let oldRem = 0;
  let newRem = 0;
  let next = 0; // new-file line number of the next hunk body line
  let hunk = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx];
    if (oldRem > 0 || newRem > 0) {
      const c = l[0];
      if (c === '+') {
        added.push({ idx, file, fileId, line: next, hunk, text: l.slice(1) });
        next++;
        newRem--;
      } else if (c === '-') {
        oldRem--;
      } else if (c === '\\') {
        // "\ No newline at end of file": belongs to the previous line, counts for neither side.
      } else {
        next++;
        oldRem--;
        newRem--;
      }
      continue;
    }
    if (l.startsWith('+++ ')) {
      const path = l.slice(4).split('\t')[0];
      file = path === '/dev/null' ? null : path.replace(/^b\//, '');
      fileId++;
      continue;
    }
    const m = HUNK.exec(l);
    if (m) {
      oldRem = m[2] === undefined ? 1 : Number(m[2]);
      newRem = m[4] === undefined ? 1 : Number(m[4]);
      next = Number(m[3]);
      hunk = { idx, fileId, newCount: newRem };
      hunks.push(hunk);
    }
  }
  return { added, hunks };
}

// Re-writes a hunk header: shifts the new-side start by `startBy` and the new-side count by `countBy`.
function shiftHeader(header, startBy, countBy) {
  return header.replace(HUNK, (whole, a, b, c, d) => {
    const old = `-${a}${b === undefined ? '' : `,${b}`}`;
    const start = Number(c) + startBy;
    const count = d === undefined ? '' : `,${Number(d) + countBy}`;
    return `@@ ${old} +${start}${count} @@`;
  });
}

export function plantInDiff(diffText, kind, pick = 0) {
  const op = KINDS[kind];
  if (!op) throw new Error(`replay-seed: unknown kind "${kind}"`);
  const lines = String(diffText).split('\n');
  const { added, hunks } = scan(lines);
  const candidates = added.filter((a) => a.file !== null
    && !COMMENT.test(a.text)
    && op.matches(a.text)
    && (kind !== 'drop-guard' || a.hunk.newCount >= 2));
  if (candidates.length === 0) return null;

  const n = candidates.length;
  const p = Number.isFinite(pick) ? Math.trunc(pick) : 0;
  const chosen = candidates[((p % n) + n) % n];

  const out = lines.slice();
  if (kind === 'drop-guard') {
    // The hunk's own header loses one new-side line; later hunks of the same file start one line earlier.
    for (const h of hunks) {
      if (h.fileId !== chosen.fileId || h.idx < chosen.hunk.idx) continue;
      out[h.idx] = h.idx === chosen.hunk.idx ? shiftHeader(lines[h.idx], 0, -1) : shiftHeader(lines[h.idx], -1, 0);
    }
    out.splice(chosen.idx, 1);
  } else {
    out[chosen.idx] = `+${op.mutate(chosen.text)}`;
  }
  return { diff: out.join('\n'), file: chosen.file, line: chosen.line, kind };
}
