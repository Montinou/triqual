// renderRules(policy, cap = 2000): one line per rule, `id: decision match-summary — why`.
// When the text is longer than `cap` characters, the longest `why` is shortened first (ending
// in "…"), then the next longest, and so on; if the lines are still too long without any
// `why`, the text itself is cut at the cap.

const ELLIPSIS = '…';

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const list = (xs) => xs.join(',');

function summary(rule) {
  const m = rule.match;
  const out = [];
  if (m.class) out.push(`class=${list(m.class)}`);
  if (m.paths) out.push(`paths(${m.access ?? 'any'})=${list(m.paths)}`);
  if (m.argv) out.push(`argv=${m.argv.map((p) => JSON.stringify(p.join(' '))).join('|')}`);
  if (m.mcp) out.push(`mcp=${list(m.mcp)}`);
  if (m.domains) out.push(`domains=${list(m.domains)}`);
  if (rule.except?.paths) out.push(`except paths=${list(rule.except.paths)}`);
  if (rule.except?.domains) out.push(`except domains=${list(rule.except.domains)}`);
  return oneLine(out.join(' '));
}

// Cuts `s` to `n` characters including the ellipsis, never splitting a surrogate pair.
function shorten(s, n) {
  if (n <= 0) return '';
  if (n === 1) return ELLIPSIS;
  let head = s.slice(0, n - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head + ELLIPSIS;
}

export function renderRules(policy, cap = 2000) {
  const heads = policy.rules.map((r) => `${r.id}: ${r.decision} ${summary(r)}`);
  const whys = policy.rules.map((r) => oneLine(r.why));
  const cur = whys.slice();
  const lineOf = (i) => (cur[i] === '' ? heads[i] : `${heads[i]} — ${cur[i]}`);
  const total = () => cur.reduce((sum, _, i) => sum + lineOf(i).length, Math.max(0, cur.length - 1));

  let size = total();
  while (size > cap) {
    let longest = -1;
    let second = 0;
    cur.forEach((w, i) => {
      if (longest === -1 || w.length > cur[longest].length) {
        if (longest !== -1) second = Math.max(second, cur[longest].length);
        longest = i;
      } else {
        second = Math.max(second, w.length);
      }
    });
    if (longest === -1 || cur[longest].length === 0) break;
    const len = cur[longest].length;
    let target = Math.max(len - (size - cap), second);
    if (target >= len) target = len - 1;
    cur[longest] = shorten(whys[longest], target);
    size = total();
  }

  const text = cur.map((_, i) => lineOf(i)).join('\n');
  return text.length > cap ? shorten(text, cap) : text;
}
