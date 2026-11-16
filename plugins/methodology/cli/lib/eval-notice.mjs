// The session-start line about the evals improve loop. node: built-ins only. Reads at most the newest round report in
// <evals>/rounds/ and <evals>/revisions.jsonl; never throws, and returns null when there is nothing to say.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

// The categories of `revise` that no revisions.jsonl line names for this round (the report's file name).
function pendingJudges(evals, round, revise) {
  const attempted = new Set();
  try {
    for (const line of readFileSync(join(evals, 'revisions.jsonl'), 'utf8').split('\n')) {
      try {
        const row = JSON.parse(line);
        if (row?.round === round && typeof row.category === 'string') attempted.add(row.category);
      } catch { /* a line that is not JSON names nothing */ }
    }
  } catch { /* no revisions file: nothing has been attempted */ }
  return revise.filter((id) => !attempted.has(id));
}

// `evals: ...` lines (failed steps first, then judges below the bar) for the newest round report, or null.
export function evalsNotice({ evals } = {}) {
  try {
    const name = readdirSync(join(evals, 'rounds')).filter((file) => file.endsWith('.json')).sort().pop();
    if (name === undefined) return null;
    const path = join(evals, 'rounds', name);
    const report = JSON.parse(readFileSync(path, 'utf8'));
    if (report === null || typeof report !== 'object') return null;
    const lines = [];
    if (isStrings(report.failed) && report.failed.length > 0) {
      lines.push(`evals: the last round had failed steps (${report.failed.join(', ')}): see ${path}`);
    }
    if (isStrings(report.revise)) {
      const pending = pendingJudges(evals, name, report.revise);
      if (pending.length > 0) lines.push(`evals: ${pending.length} judge(s) below the bar (${pending.join(', ')}): run methodology:improving-evals`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
  } catch {
    return null;
  }
}
