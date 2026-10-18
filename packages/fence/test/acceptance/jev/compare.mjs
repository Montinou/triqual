// Decision equivalence between the two adapters over the jev corpus (spec, "Acceptance", item 2).
//
//   diffDecisions(claudeRows, codexRows) -> {differing: string[]}
//     rows are [{id, decision, ...}] as run-codex.mjs writes them; an id is differing when its
//     decision differs (after `comparable`: a Claude allow equals a silent Codex exit 0) or it is on
//     one side only. Sorted, each id once.
//   checkLogCwd(stateDir, project) -> {ok, lines} | {ok: false, reason}
//   node compare.mjs --check-cwd <state-dir> <project>   exit 1 unless every hook ran inside the project
//   node compare.mjs <claude-decisions.json> <codex-decisions.json>   prints the count and each
//     differing id with both decisions; exit 1 when any differs
//   node compare.mjs --metrics <jev-report.json>                      prints the metrics of a jev
//     JSON report (run-claude.sh uses it)

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

const byId = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(r.id, r.decision);
  return m;
};

// The decision as both hosts can show it. render.mjs renders an engine allow on Codex as no output
// and exit 0, the same as undecided, so a Claude `allow` (its JSON allow line) compares equal to a
// silent Codex exit 0 (`none`). deny and failed compare as they are.
export const comparable = (decision) => (decision === 'allow' ? 'none' : decision);

export function diffDecisions(claudeRows, codexRows) {
  const a = byId(claudeRows);
  const b = byId(codexRows);
  const differing = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(id) || !b.has(id) || comparable(a.get(id)) !== comparable(b.get(id))) differing.push(id);
  }
  return { differing: differing.sort() };
}

// run-claude.sh's check that jev really ran the hooks inside the project: every engine log line
// under <stateDir>/log must carry a cwd inside `project` and the repo root `project`.
// -> {ok: true, lines} | {ok: false, reason}
export function checkLogCwd(stateDir, project) {
  const logDir = nodePath.join(stateDir, 'log');
  let files = [];
  try {
    files = nodeFs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    // reported below
  }
  const inside = (p) => typeof p === 'string' && (p === project || p.startsWith(`${project}/`));
  let n = 0;
  for (const f of files) {
    for (const text of nodeFs.readFileSync(nodePath.join(logDir, f), 'utf8').split('\n')) {
      if (text.trim() === '') continue;
      n++;
      let entry = null;
      try {
        entry = JSON.parse(text);
      } catch {
        return { ok: false, reason: `${f}: a log line does not parse` };
      }
      if (!inside(entry.cwd)) return { ok: false, reason: `a hook ran with cwd ${JSON.stringify(entry.cwd)}, outside the project ${project}` };
      if (entry.repo?.root !== project) return { ok: false, reason: `a hook at ${JSON.stringify(entry.cwd)} resolved the repo ${JSON.stringify(entry.repo?.root ?? null)}, not the project ${project}` };
    }
  }
  if (n === 0) return { ok: false, reason: `no engine log lines under ${logDir}: the guard did not run` };
  return { ok: true, lines: n };
}

function main(args) {
  const read = (f) => JSON.parse(nodeFs.readFileSync(nodePath.resolve(f), 'utf8'));
  if (args[0] === '--metrics' && args.length === 2) {
    const report = read(args[1]);
    for (const [k, v] of Object.entries(report.metrics ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
      process.stdout.write(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
    }
    return 0;
  }
  if (args[0] === '--check-cwd' && args.length === 3) {
    const r = checkLogCwd(nodePath.resolve(args[1]), nodePath.resolve(args[2]));
    if (!r.ok) {
      process.stderr.write(`run-claude: ${r.reason}\n`);
      return 1;
    }
    process.stdout.write(`every hook (${r.lines} log lines) ran inside the project with ${'${repo}'} = the project\n`);
    return 0;
  }
  if (args.length !== 2) {
    process.stderr.write('usage: node compare.mjs <claude-decisions.json> <codex-decisions.json> | --metrics <jev-report.json> | --check-cwd <state-dir> <project>\n');
    return 2;
  }
  const claude = read(args[0]);
  const codex = read(args[1]);
  const { differing } = diffDecisions(claude, codex);
  const a = byId(claude);
  const b = byId(codex);
  process.stdout.write(`differing decisions: ${differing.length} of ${new Set([...a.keys(), ...b.keys()]).size}\n`);
  for (const id of differing) process.stdout.write(`  ${id}: claude ${a.get(id) ?? '(missing)'}, codex ${b.get(id) ?? '(missing)'}\n`);
  return differing.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(nodePath.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
