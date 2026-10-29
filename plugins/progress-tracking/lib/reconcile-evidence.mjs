// The reconcile evidence classifier (design U1): turns a plan's non-done tasks plus evidence into one proposal each.
// Pure but for the injected `probe`: no I/O, no clock. It shares nothing with `reconcile` in ledger.mjs. It reads only
// the `Create:`, `Modify:` and `Test:` lines and the planned commit line of a task's own block in the plan text.
// Contract with the caller (T2): rule (a) accepts any entry with a non-empty `commit` and does not check that the commit
// resolves in git (the probe has no such method), so the caller must pass only entries whose commit resolves. The caller
// also passes `planStem`, the plan file name without its date prefix and `.md`: entry topics are matched against it.
import { PlanError, readTasks } from './plan.mjs';

// `Plan <topic> · T<N>` in an entry's stage/task text (the same shape the store reads).
const STAGE = /^Plan (.+?) · T(\d+)/;
const FILES_LINE = /^\s*-\s+(Create|Modify|Test):\s*(.*)$/;
const TICKED = /`([^`]+)`/g;
const RANGE_SUFFIX = /:\d+(?:-\d+)?$/;
const COMMIT_M = /git commit(?:\s+-\w+)*\s+-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/;
const COMMIT_STEP = /\*\*Step \d+:\s*Commit\*\*\s*`([^`]+)`/;
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;
const PLAN_SUFFIX = / Implementation Plan$/;
const MIN_CONTAINED = 6;

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const asCommit = (c) => (typeof c === 'string' ? { sha: c } : c);
const proposal = (id, confidence, commit, why) => ({ id, to: confidence === 'high' ? 'done' : 'keep', confidence, commit, why });

// The topic a plan answers to, normalized: its stem without the date prefix when `planStem` is given; only when it is
// absent, the plan title without " Implementation Plan". Empty ones are dropped.
function planTopics(planText, planStem) {
  const source = planStem
    ? planStem.replace(DATE_PREFIX, '')
    : /^# (.+)$/m.exec(planText)?.[1]?.trim().replace(PLAN_SUFFIX, '');
  return [source].map((s) => (s ? norm(s) : '')).filter(Boolean);
}

// Equal, or one contains the other with the contained one at least MIN_CONTAINED characters long.
function topicMatches(topic, topics) {
  const t = norm(topic);
  if (!t) return false;
  return topics.some((p) => t === p
    || (p.includes(t) && t.length >= MIN_CONTAINED) || (t.includes(p) && p.length >= MIN_CONTAINED));
}

// The paths of one `Create:`/`Modify:`/`Test:` value: every backticked token, else the bare text; a trailing line range
// (`file.mjs:10-20`) is dropped.
function pathsOf(value) {
  const ticked = [...value.matchAll(TICKED)].map((m) => m[1]);
  const raw = ticked.length > 0 ? ticked : [value.trim()];
  return raw.map((p) => p.trim().replace(RANGE_SUFFIX, '')).filter(Boolean);
}

// The files and the planned commit subject of one task block (an array of lines).
function readBlock(lines) {
  const files = { create: [], modify: [], test: [] };
  for (const line of lines) {
    const m = FILES_LINE.exec(line);
    if (m) files[m[1].toLowerCase()].push(...pathsOf(m[2]));
  }
  const text = lines.join('\n');
  const c = COMMIT_M.exec(text);
  const subject = (c ? (c[1] ?? c[2]) : COMMIT_STEP.exec(text)?.[1])?.trim() || null;
  return { files, subject };
}

// Blocks by task id; empty when the plan text cannot be read (every task then lands low).
function blocksOf(planText) {
  let tasks;
  try {
    tasks = readTasks(planText);
  } catch (e) {
    if (e instanceof PlanError) return new Map();
    throw e;
  }
  const lines = planText.split(/\r?\n/);
  return new Map(tasks.map((t) => [t.id, readBlock(lines.slice(t.start - 1, t.end))]));
}

// Evidence of one task: { confidence: 'high', commit, why } or { confidence: 'medium'|'low', commit, why }, before the
// dependency check. A probe failure throws; the caller turns it into low.
function evidenceOf({ task, block, planText, planStem, planDate, entries, probe }) {
  if (block) {
    const topics = planTopics(planText, planStem);
    const hit = entries.find((e) => {
      const m = STAGE.exec(e?.stage ?? '');
      return m && `T${Number(m[2])}` === task.id && e.commit && topicMatches(m[1], topics);
    });
    if (hit) return { confidence: 'high', commit: hit.commit, why: `progress entry "${hit.stage}" has commit ${hit.commit}` };
  }
  if (!block) return { confidence: 'low', commit: null, why: 'the task is not in the plan text' };

  const { files, subject } = block;
  if (subject) {
    const hit = (probe.commitsBySubject(subject, planDate) ?? []).map(asCommit)
      .find((c) => c?.sha && (c.subject === undefined || c.subject.trim() === subject));
    if (hit) return { confidence: 'high', commit: hit.sha, why: `planned commit "${subject}" found as ${hit.sha}` };
  }
  if (files.create.length > 0 && files.create.every((p) => probe.fileExists(p))) {
    const newest = (probe.commitsAdding(files.create, planDate) ?? []).map(asCommit).find((c) => c?.sha);
    if (newest) return { confidence: 'high', commit: newest.sha, why: `${files.create.length} created path(s) exist, added by ${newest.sha}` };
  }
  const all = [...new Set([...files.create, ...files.modify, ...files.test])];
  if (all.length === 0) return { confidence: 'low', commit: null, why: 'no evidence: the task lists no Files' };
  // `commitsTouching` is an optional probe method (commits touching those paths, newest first); `commitsAdding` only sees
  // added files, so it cannot show that a Modify-only task was worked on.
  if (typeof probe.commitsTouching !== 'function') {
    return { confidence: 'low', commit: null, why: 'no evidence: the probe has no commitsTouching, so touched files cannot be checked' };
  }
  const touching = (probe.commitsTouching(all, planDate) ?? []).map(asCommit).find((c) => c?.sha);
  if (touching) return { confidence: 'medium', commit: touching.sha, why: `commits touch the task's files (${touching.sha}) but nothing shows it complete` };
  return { confidence: 'low', commit: null, why: 'no evidence: no commit since the plan date touches the task files' };
}

// Proposals for the non-done tasks, in task order: [{ id, to: 'done'|'keep', confidence: 'high'|'medium'|'low',
// commit: sha|null, why }]. `tasks` are ledger tasks ({ id, status, deps }); `planDate` is the plan file name's date;
// `entries` are `{ stage, commit }` (store mode only, empty otherwise; only entries whose commit resolves in git);
// `probe` is { fileExists(path), commitsAdding(paths, sinceDate), commitsBySubject(subject, sinceDate),
// commitsTouching?(paths, sinceDate) }, the commits being `{ sha, subject? }` (or a bare sha) newest first;
// `commitsTouching` is optional, and without it a task with no stronger evidence is low, never medium. `planStem` is the
// plan file name without its date prefix and `.md`, passed by the caller: rule (a) matches entry topics against it, and
// against the plan's H1 title only when `planStem` is absent. Only a `high` proposal is ever meant to be applied.
export function classifyTasks({ tasks, planText, planDate, entries = [], probe, planStem }) {
  const blocks = blocksOf(planText);
  const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const highDone = new Set();
  const out = [];
  for (const task of tasks) {
    if (task.status === 'done') continue;
    if (task.status === 'dropped') {
      out.push(proposal(task.id, 'low', null, 'the task is dropped'));
      continue;
    }
    let found;
    try {
      found = evidenceOf({ task, block: blocks.get(task.id), planText, planStem, planDate, entries, probe });
    } catch (e) {
      out.push(proposal(task.id, 'low', null, `probe failed: ${e?.message ?? e}`));
      continue;
    }
    if (found.confidence === 'high') {
      const unmet = (task.deps ?? []).filter((d) => !done.has(d) && !highDone.has(d));
      if (unmet.length > 0) {
        found = { confidence: 'medium', commit: found.commit, why: `${found.why}; depends on ${unmet.join(', ')}, not done or not proposed done with high confidence` };
      } else {
        highDone.add(task.id);
      }
    }
    out.push(proposal(task.id, found.confidence, found.commit, found.why));
  }
  return out;
}
