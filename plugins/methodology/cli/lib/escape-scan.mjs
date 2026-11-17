// scanEscapes: the post-merge escapes of closed plan tasks, found in git and CI (`triqual role-eval escapes scan`).
// Pure over its inputs: `git(args, { cwd })` and `gh(args, { cwd })` return a command's stdout (`cwd` is `repo`; the
// caller binds the environment), so a test feeds canned output. It returns the `escape` records of role-eval (spec 5), one per
// (plan, ref), and never reads or returns message text: only shas, dates, plan and task names.
//
// Per done task (a plan snapshot of `triqual tasks export --json`: tasks with `status`, `since` as epoch ms and
// `commits`), its files are the union of `git show --name-only` over its commits. On the default branch:
//   - a commit within `days` after the task's `since` whose subject starts `fix(` or `fix:` and touches one of those
//     files is a `post-merge-fix`;
//   - a commit whose message holds `This reverts commit <sha>` for one of the task's commits is a `revert`.
// A plan whose tasks are all done or dropped also gets a `red-ci` record per failing default-branch run (`gh run list`)
// created within `days` after the plan's last task `since`. A `gh` that throws leaves red CI out.
// node: built-ins only.

import { TIERS } from './role-eval.mjs';

const DAY_MS = 86400000;
const FIX_SUBJECT = /^fix[(:]/;
const REVERTS = /This reverts commit ([0-9a-f]{7,40})/g;
const FIELD = '\x1f';
const RECORD = '\x1e';

// The default branch: origin's HEAD when set, else main or master when one exists, else the current branch.
export function defaultBranch(git, repo) {
  const tryGit = (args) => {
    try {
      return git(args, { cwd: repo }).trim();
    } catch {
      return '';
    }
  };
  const origin = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  if (origin !== '') return origin;
  for (const name of ['main', 'master']) {
    if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) !== '') return name;
  }
  return tryGit(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
}

// The default branch's commits, newest first: { sha, at (ms), subject, reverts: [sha prefixes] }.
function branchCommits(git, repo, branch) {
  const out = git(['log', branch, `--format=%H${FIELD}%cI${FIELD}%s${FIELD}%b${RECORD}`], { cwd: repo });
  const commits = [];
  for (const chunk of out.split(RECORD)) {
    const [sha, date, subject = '', body = ''] = chunk.trim().split(FIELD);
    const at = Date.parse(date);
    if (!/^[0-9a-f]{40}$/.test(sha ?? '') || Number.isNaN(at)) continue;
    commits.push({ sha, at, subject, reverts: [...body.matchAll(REVERTS)].map((m) => m[1]) });
  }
  return commits;
}

const isoOf = (ms) => new Date(ms).toISOString();
const planFile = (name) => `${name}.md`;

// The files one commit touches; a commit git cannot show (unknown sha) touches none.
function filesOf(git, repo, sha) {
  try {
    return git(['show', '--name-only', '--format=', sha], { cwd: repo }).split('\n').filter((f) => f !== '');
  } catch {
    return [];
  }
}

export function scanEscapes({ repo, plans, git, gh, since, days = 14 }) {
  const window = days * DAY_MS;
  const sinceMs = since === undefined ? -Infinity : Date.parse(`${since}T00:00:00Z`);
  const branch = defaultBranch(git, repo);
  const commits = branchCommits(git, repo, branch);
  const records = [];
  const seen = new Set(); // plan + ref: each escape once
  const add = (plan, ref, at, fields) => {
    const key = `${plan.name}\0${ref}`;
    if (seen.has(key) || at < sinceMs) return;
    seen.add(key);
    records.push({ v: 2, at: isoOf(at), kind: 'escape', ...fields, ref, plan: planFile(plan.name) });
  };

  const fileCache = new Map(); // sha -> files, shared by the plans
  const files = (sha) => {
    if (!fileCache.has(sha)) fileCache.set(sha, filesOf(git, repo, sha));
    return fileCache.get(sha);
  };

  for (const plan of plans) {
    // Every commit of every task of the plan: a fix that is another task's work is planned, not an escape.
    const planCommits = new Set((plan.tasks ?? []).flatMap((t) => (Array.isArray(t.commits) ? t.commits : [])).filter((c) => typeof c === 'string' && /^[0-9a-f]{7,40}$/.test(c)));
    for (const task of plan.tasks ?? []) {
      if (task.status !== 'done' || !Number.isFinite(task.since) || !Array.isArray(task.commits)) continue;
      const taskCommits = task.commits.filter((c) => typeof c === 'string' && /^[0-9a-f]{7,40}$/.test(c));
      if (taskCommits.length === 0) continue;
      const own = new Set(taskCommits);
      const taskFiles = new Set(taskCommits.flatMap(files));
      const stamp = { task: task.id, ...(TIERS.includes(task.effectiveTier) ? { tier: task.effectiveTier } : {}) };
      for (const c of commits) {
        if (own.has(c.sha) || taskCommits.some((t) => c.sha.startsWith(t))) continue;
        if ([...planCommits].some((p) => c.sha.startsWith(p))) continue;
        if (c.reverts.some((r) => taskCommits.some((t) => t.startsWith(r) || r.startsWith(t)))) {
          add(plan, c.sha, c.at, { source: 'revert', ...stamp });
        } else if (
          FIX_SUBJECT.test(c.subject) && c.at > task.since && c.at <= task.since + window
          && files(c.sha).some((f) => taskFiles.has(f))
        ) {
          add(plan, c.sha, c.at, { source: 'post-merge-fix', ...stamp });
        }
      }
    }
  }

  // Red CI: one `gh` call; a plan counts once all its tasks are closed (done or dropped), from its last task's `since`.
  const closed = plans.map((plan) => {
    const tasks = plan.tasks ?? [];
    const sinces = tasks.filter((t) => t.status === 'done' && Number.isFinite(t.since)).map((t) => t.since);
    const finished = sinces.length > 0 && tasks.every((t) => t.status === 'done' || t.status === 'dropped');
    return finished ? { plan, last: Math.max(...sinces) } : null;
  }).filter(Boolean);
  if (closed.length > 0 && gh) {
    let runs = null;
    try {
      runs = JSON.parse(gh(['run', 'list', '--branch', branch, '--status', 'failure', '--json', 'headSha,createdAt', '--limit', '200'], { cwd: repo }));
    } catch {
      runs = null; // gh missing or failing: red CI is skipped (the caller says so)
    }
    for (const { plan, last } of closed) {
      for (const run of Array.isArray(runs) ? runs : []) {
        const at = Date.parse(run?.createdAt);
        if (typeof run?.headSha === 'string' && at > last && at <= last + window) add(plan, run.headSha, at, { source: 'red-ci' });
      }
    }
  }
  return records;
}
