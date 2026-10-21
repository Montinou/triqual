// The reviewer footer, v1: the machine-read last lines of a gate's, spec reviewer's and re-reviewer's final message, and
// the candidates files hunters write. Pure functions over text; `task-close` reads the saved outputs through them.
//
//   <!-- triqual-review v1 -->
//   role: <safety-reviewer|spec-reviewer|re-reviewer>
//   findings: critical=<n> important=<n> minor=<n>
//   candidate: <category>-<k> <confirmed critical|confirmed important|confirmed minor|refuted|duplicate-candidate|duplicate-review>
//
// The marker is the last such line of the text, the role and findings lines follow it, then zero or more candidate lines;
// nothing but blank lines may come after. No count is ever guessed: anything else is a FooterError.

export const FOOTER_MARKER = '<!-- triqual-review v1 -->';
export const FOOTER_ROLES = Object.freeze(['safety-reviewer', 'spec-reviewer', 're-reviewer']);

export class FooterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FooterError';
  }
}

const FINDINGS = /^findings: critical=(\d+) important=(\d+) minor=(\d+)$/;
const CANDIDATE = /^candidate: ([a-z][a-z-]*-\d+) (confirmed (critical|important|minor)|refuted|duplicate-candidate|duplicate-review)$/;

// { role, findings: {critical, important, minor}, candidates: [{id, verdict, severity|null}] } of the footer in `text`.
export function parseFooter(text) {
  const lines = String(text).split('\n').map((line) => line.trimEnd());
  const marker = lines.lastIndexOf(FOOTER_MARKER);
  if (marker < 0) throw new FooterError(`no ${FOOTER_MARKER} footer`);
  const rest = lines.slice(marker + 1);
  while (rest.length > 0 && rest.at(-1) === '') rest.pop();

  const roleLine = /^role: (\S+)$/.exec(rest[0] ?? '');
  if (!roleLine) throw new FooterError('the footer has no role: line right after the marker');
  if (!FOOTER_ROLES.includes(roleLine[1])) throw new FooterError(`the footer names an unknown role: ${roleLine[1]}`);
  const counts = FINDINGS.exec(rest[1] ?? '');
  if (!counts) throw new FooterError('the footer has no findings: critical=<n> important=<n> minor=<n> line after the role');

  const seen = new Set();
  const candidates = rest.slice(2).map((line) => {
    const m = CANDIDATE.exec(line);
    if (!m) throw new FooterError(`not a footer line: ${line.slice(0, 80)}`);
    if (seen.has(m[1])) throw new FooterError(`the footer gives candidate ${m[1]} twice`);
    seen.add(m[1]);
    return m[3] ? { id: m[1], verdict: 'confirmed', severity: m[3] } : { id: m[1], verdict: m[2], severity: null };
  });
  return {
    role: roleLine[1],
    findings: { critical: Number(counts[1]), important: Number(counts[2]), minor: Number(counts[3]) },
    candidates,
  };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The distinct `<category>-<k>` ids a hunter's candidates file holds, in first-seen order.
export function candidateIds(fileText, category) {
  const re = new RegExp(`(?<![\\w-])${escapeRegExp(category)}-\\d+(?![\\w-])`, 'g');
  return [...new Set(String(fileText).match(re) ?? [])];
}

// How many distinct `<category>-<k>` ids the file holds.
export const countCandidates = (fileText, category) => candidateIds(fileText, category).length;
