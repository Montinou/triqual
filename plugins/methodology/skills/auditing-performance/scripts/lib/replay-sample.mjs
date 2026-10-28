// Replay sampler: picks finished plan tasks for a replay. `normalizeExport` reads one `triqual tasks export --json --all`
// output (an array of `tracking-snapshot@1` objects, one per repo: { repo: { name, root }, plans: [{ name, tasks: [{ id,
// status, tier, effectiveTier, commits: [sha] }] }] }) into rows `{ repo, root, plan, task, tier, sha }`, one per done task
// that has a commit (sha = its first commit). `sampleTasks` draws rows round-robin across tiers, then across repos inside
// a tier, with a seeded PRNG, so the same input and seed give the same sample.

import { basename } from 'node:path';

// Client repositories are never sampled. A caller's `exclude` only adds to this; it never replaces it.
const CLIENT_EXCLUDE = /^attorney/i;

// Fresh case-insensitive, non-global copy: a g/y flag makes `.test` stateful, and a case-sensitive pattern would miss "Attorney-X".
const asFilter = (re) => new RegExp(re instanceof RegExp ? re.source : String(re), 'i');

// mulberry32: a small seeded PRNG returning floats in [0, 1).
function prng(seed) {
  let a = Number(seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const isObject = (v) => v !== null && typeof v === 'object';

export function normalizeExport(json) {
  const snapshots = Array.isArray(json) ? json : isObject(json) ? [json] : [];
  const rows = [];
  for (const snap of snapshots) {
    if (!isObject(snap) || !isObject(snap.repo) || !Array.isArray(snap.plans)) continue;
    const { name: repo, root } = snap.repo;
    if (typeof repo !== 'string' || typeof root !== 'string') continue;
    for (const plan of snap.plans) {
      if (!isObject(plan) || !Array.isArray(plan.tasks)) continue;
      for (const t of plan.tasks) {
        if (!isObject(t) || t.status !== 'done' || !Array.isArray(t.commits)) continue;
        const sha = t.commits.find((c) => typeof c === 'string' && c !== '');
        if (!sha) continue;
        rows.push({ repo, root, plan: plan.name, task: t.id, tier: t.tier ?? t.effectiveTier ?? 'unknown', sha });
      }
    }
  }
  return rows;
}

export function sampleTasks(rows, { n, exclude, seed = 1, resolves = () => true } = {}) {
  const rand = prng(seed);
  const client = asFilter(CLIENT_EXCLUDE);
  const extra = exclude === undefined || exclude === null ? null : asFilter(exclude);
  const kept = rows.filter((r) => !client.test(r.repo) && !client.test(basename(r.root)) && !(extra && extra.test(r.repo)));
  // tier -> repo -> shuffled queue; tiers and repos are sorted before shuffling so the input order never matters.
  const tiers = new Map();
  for (const r of kept) {
    if (!tiers.has(r.tier)) tiers.set(r.tier, new Map());
    const repos = tiers.get(r.tier);
    if (!repos.has(r.repo)) repos.set(r.repo, []);
    repos.get(r.repo).push(r);
  }
  const lanes = [...tiers.keys()].sort().map((tier) => {
    const repos = tiers.get(tier);
    const queues = shuffle([...repos.keys()].sort(), rand).map((repo) => shuffle(repos.get(repo), rand));
    return { queues, next: 0 };
  });

  const out = [];
  let active = lanes.filter((l) => l.queues.length > 0);
  while (out.length < n && active.length > 0) {
    for (const lane of active) {
      if (out.length >= n) break;
      let picked = null;
      // Walk the repos from the lane's pointer until one yields a resolving commit; drop exhausted queues.
      while (picked === null && lane.queues.length > 0) {
        lane.next %= lane.queues.length;
        const queue = lane.queues[lane.next];
        const cand = queue.shift();
        if (queue.length === 0) lane.queues.splice(lane.next, 1);
        else lane.next += 1;
        if (cand && resolves(cand.root, cand.sha)) picked = cand;
      }
      if (picked) out.push(picked);
    }
    active = active.filter((l) => l.queues.length > 0);
  }
  return out;
}
