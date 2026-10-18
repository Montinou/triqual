// The plan reader (design U1): one pure reader of the plan format for every consumer. No I/O, no clock and, on purpose,
// no `import`: methodology's scripts carry a byte-identical copy of this file (a parity test pins it), so it can load
// from a plugin that has no progress-tracking next to it. `ledger.mjs` wraps it as `parsePlan`; `stack.mjs` reads phases
// with it; `git check-ref-format` stays in stack.mjs because it needs a process.

export const TIERS = Object.freeze(['heavy', 'standard', 'light']);

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
    this.code = 2;
  }
}

// The roles registration checks (the full list lives in roles.mjs, which this file cannot import).
const COORDINATOR = 'coordinator';
const COMPLEX_IMPLEMENTER = 'roles:complex-implementer';

// Headings and task fields are read at column 0 only.
const H1 = /^# (.+)$/;
const HEADING_1_TO_3 = /^#{1,3} /;
const TASK_HEADING = /^### Task (\d+): (.+)$/;
const PHASE_HEADING = /^## Phase (\d+): (.+)$/;
const DEPENDS = /^\*\*Depends on:\*\*(.*)$/;
const SKILLS = /^\*\*Skills:\*\*(.*)$/;
const ROLE = /^\*\*Role:\*\*(.*)$/;
const TIER = /^\*\*Tier:\*\*(.*)$/;
const PREFIX = /^\*\*Branch prefix:\*\*\s*(.+)$/;
const SENSITIVE = /^\*\*Sensitive paths:\*\*\s*(.*)$/;
const PHASE_FIELD = /^\*\*(Slice|Branch|PR title|Stands alone because|Phase check):\*\*\s*(.*)$/;
const FIELD_KEYS = {
  Slice: 'slice',
  Branch: 'branch',
  'PR title': 'prTitle',
  'Stands alone because': 'standsAlone',
  'Phase check': 'phaseCheck',
};
const BRANCH_NUMBER = /^(\d{2})-\S/;
const PLAN_SUFFIX = / Implementation Plan$/;
const UNPHASED_CHECK = "the repository's full test command";

// CommonMark fence: a run of 3+ backticks or tildes, then an optional info string; after backticks the info string may
// not hold a backtick (such a line is inline code). Groups: 1 the run, 2 the info string.
const FENCE = /^(`{3,}(?=[^`]*$)|~{3,})(.*)$/;
// The leading spaces and tabs of a line. Indented four or more columns (a tab counts as four) a line never opens or
// closes a fence, as in CommonMark; executing-plans' task-brief applies the same rule.
const INDENT = /^[ \t]*/;
const FENCE_INDENT_LIMIT = 4;
const TAB_COLUMNS = 4;

const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const unquote = (s) => s.trim().replace(/^`([^`]*)`$/, '$1');

// The fence match of `line` ([, run, info]), or null when it is no fence line.
function fenceOf(line) {
  const [indent] = INDENT.exec(line);
  const columns = [...indent].reduce((n, c) => n + (c === '\t' ? TAB_COLUMNS : 1), 0);
  return columns < FENCE_INDENT_LIMIT ? FENCE.exec(line.slice(indent.length)) : null;
}

// The lines of `text` outside fenced code blocks, as { line, no } (no is 1-based), plus the total line count (a final
// newline does not add a line). Throws when the text ends inside a fence.
function scan(text) {
  const all = text.split(/\r?\n/);
  if (all.length > 1 && all.at(-1) === '') all.pop();
  const lines = [];
  let fence = null; // { run, line } of the opening fence while inside a fenced code block
  for (const [i, line] of all.entries()) {
    const f = fenceOf(line);
    if (fence) {
      // Closes only on a run of the same character, at least as long as the opener, with no info string.
      if (f && f[1][0] === fence.run[0] && f[1].length >= fence.run.length && !f[2].trim()) fence = null;
      continue;
    }
    if (f) { fence = { run: f[1], line: i + 1 }; continue; }
    lines.push({ line, no: i + 1 });
  }
  if (fence) throw new PlanError(`unclosed code fence opened at line ${fence.line}`);
  return { lines, total: all.length };
}

// Tasks of a plan: [{ id, title, deps, skills, role, tier, start, end }]. `start` is the 1-based line of the
// `### Task N:` heading and `end` the last line of the task: the line before the next heading of level 1 to 3 outside
// a fence (a `### ` heading that is no task, or a `## After Merge`), else the last line of the plan. `tier` is null when
// the task declares none; a value outside TIERS throws.
export function readTasks(text) {
  const { lines, total } = scan(text);
  const tasks = [];
  const seen = new Set();
  let current = null;
  for (const { line, no } of lines) {
    const h = TASK_HEADING.exec(line);
    if (h || HEADING_1_TO_3.test(line)) {
      if (current) current.end = no - 1;
      current = null;
    }
    if (h) {
      const id = `T${Number(h[1])}`;
      if (seen.has(id)) throw new PlanError(`duplicate task ${id} in plan`);
      seen.add(id);
      current = { id, title: h[2].trim(), deps: [], skills: [], role: null, tier: null, start: no, end: total };
      tasks.push(current);
      continue;
    }
    if (!current) continue;
    const d = DEPENDS.exec(line);
    if (d) { current.deps = list(d[1]); continue; }
    const s = SKILLS.exec(line);
    if (s) { current.skills = list(s[1]); continue; }
    const r = ROLE.exec(line);
    if (r) { current.role = r[1].trim(); continue; }
    const t = TIER.exec(line);
    if (t) {
      const tier = t[1].trim();
      if (!TIERS.includes(tier)) {
        throw new PlanError(`${current.id}: unknown tier "${tier}" (expected ${TIERS.join(', ')})`);
      }
      current.tier = tier;
    }
  }
  return tasks;
}

// The branch of a `**Branch:**` value: its first backticked token, else its first whitespace-free token.
function branchOf(value) {
  const ticked = /`([^`]+)`/.exec(value);
  return ticked ? ticked[1].trim() : (value.trim().split(/\s+/)[0] ?? '');
}

// Phases of a plan: { branchPrefix, sensitivePaths, phases: [{ n, title, slice, branch, prTitle, standsAlone,
// phaseCheck, tasks }] }, `tasks` being task ids. Heading and field lines inside fenced code blocks are not read. A
// plan with no `**Branch prefix:**` line was written before phases existed (or has no `## Phase` heading): it is one
// implicit phase `<planStem>/01-plan` holding every task, and any `## Phase` heading in it is ignored.
export function readPhases(text, planStem) {
  const { lines } = scan(text);
  let h1 = null;
  let prefix = null;
  let sensitive = null;
  let current = null;
  const phases = [];
  const early = []; // tasks met before any phase
  const all = []; // every task, in plan order
  let stray = null; // the first task under a non-phase heading after a phase began
  for (const { line, no } of lines) {
    let m;
    if ((m = H1.exec(line))) {
      h1 ??= m[1].trim();
    } else if ((m = PREFIX.exec(line))) {
      prefix ??= unquote(m[1]);
    } else if ((m = SENSITIVE.exec(line))) {
      sensitive ??= list(m[1]).map(unquote).filter(Boolean);
    } else if ((m = PHASE_HEADING.exec(line))) {
      current = {
        n: Number(m[1]), title: m[2].trim(), slice: null, branch: null, prTitle: null, standsAlone: null,
        phaseCheck: null, tasks: [], sawTask: false,
      };
      phases.push(current);
    } else if (line.startsWith('## ')) {
      current = null;
    } else if ((m = TASK_HEADING.exec(line))) {
      const id = `T${Number(m[1])}`;
      all.push(id);
      if (phases.length === 0) early.push(id);
      else if (!current) stray ??= `task ${id} is outside any phase (line ${no})`;
      else {
        current.tasks.push(id);
        current.sawTask = true;
      }
    } else if (current && !current.sawTask && (m = PHASE_FIELD.exec(line))) {
      current[FIELD_KEYS[m[1]]] = m[1] === 'Branch' ? branchOf(m[2]) : m[2].trim();
    }
  }
  const sensitivePaths = sensitive ?? [];

  if (phases.length === 0 || !prefix) {
    const title = (h1 ?? planStem).replace(PLAN_SUFFIX, '');
    return {
      branchPrefix: planStem,
      sensitivePaths,
      phases: [{
        n: 1, title, slice: null, branch: `${planStem}/01-plan`, prTitle: title, standsAlone: null,
        phaseCheck: UNPHASED_CHECK, tasks: all,
      }],
    };
  }

  if (stray) throw new PlanError(stray);
  if (early.length > 0) throw new PlanError(`task ${early[0]} comes before the first phase`);
  for (const [i, phase] of phases.entries()) {
    const where = `phase ${phase.n}`;
    if (phase.n !== i + 1) throw new PlanError(`${where} is out of order: phases are numbered 1, 2, 3 ... in plan order`);
    if (!phase.branch) throw new PlanError(`${where} lacks **Branch:**`);
    if (!phase.prTitle) throw new PlanError(`${where} lacks **PR title:**`);
    if (!phase.branch.startsWith(`${prefix}/`)) {
      throw new PlanError(`${where} branch "${phase.branch}" does not start with the branch prefix "${prefix}/"`);
    }
    const nn = BRANCH_NUMBER.exec(phase.branch.slice(prefix.length + 1));
    if (!nn || Number(nn[1]) !== phase.n) {
      throw new PlanError(`${where} branch "${phase.branch}" must be ${prefix}/${String(phase.n).padStart(2, '0')}-<slug>`);
    }
    delete phase.sawTask;
  }
  return { branchPrefix: prefix, sensitivePaths, phases };
}

// The registration rules of a new ledger (design U1): a plan that declares a tier on any task declares it on every
// task, every tier is known, and in such a tiered plan `coordinator` requires light and `roles:complex-implementer`
// requires heavy. A plan with no tier at all passes: it is tiered at setup. Reading never applies these rules.
export function validatePlanForRegistration(tasks) {
  const tiered = tasks.filter((t) => t.tier != null);
  if (tiered.length === 0) return;
  const bad = tiered.find((t) => !TIERS.includes(t.tier));
  if (bad) throw new PlanError(`${bad.id}: unknown tier "${bad.tier}" (expected ${TIERS.join(', ')})`);
  const missing = tasks.filter((t) => t.tier == null).map((t) => t.id);
  if (missing.length) {
    throw new PlanError(`the plan declares tiers but ${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} none`);
  }
  for (const t of tasks) {
    if (t.role === COORDINATOR && t.tier !== 'light') {
      throw new PlanError(`${t.id}: role ${COORDINATOR} requires tier light, not ${t.tier}`);
    }
    if (t.role === COMPLEX_IMPLEMENTER && t.tier !== 'heavy') {
      throw new PlanError(`${t.id}: role ${COMPLEX_IMPLEMENTER} requires tier heavy, not ${t.tier}`);
    }
  }
}
