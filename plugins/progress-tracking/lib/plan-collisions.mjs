// File collisions between the phases of a plan forest (design S7). A phase is a node `<stem>#P<n>` with the union of the
// `Files:` of its tasks; two nodes collide when neither is an ancestor of the other and they name the same path.
// Paths are compared literally: a path holding `*` or `{` is an error, not a pattern.
import { readPhases, readTasks } from './plan.mjs';

const GLOB = /[*{]/;

// The nodes of `plans` ([{ stem, text }]): [{ id: '<stem>#P<n>', branch, parentId|null, parentBranch|null, paths }]. A
// phase on the trunk has no parent; a phase parent is the node of the same plan; a branch parent is the node of any
// plan whose branch is that branch, and no parent node when none has it. `parentBranch` is the raw `**Parent:**` branch
// (null unless the parent is a branch), kept so a parent outside the given plans is still the base of a diff.
export function nodesFromPlans(plans) {
  const nodes = [];
  const parents = [];
  for (const { stem, text } of plans) {
    const tasks = new Map(readTasks(text).map((t) => [t.id, t]));
    for (const phase of readPhases(text, stem).phases) {
      const paths = new Set();
      for (const id of phase.tasks) for (const list of Object.values(tasks.get(id).files)) for (const p of list) paths.add(p);
      nodes.push({ id: `${stem}#P${phase.n}`, branch: phase.branch, parentId: null, parentBranch: null, paths: [...paths] });
      parents.push({ stem, parent: phase.parent });
    }
  }
  nodes.forEach((node, i) => {
    const { stem, parent } = parents[i];
    if (parent.kind === 'phase') node.parentId = `${stem}#${parent.value}`;
    else if (parent.kind === 'branch') {
      node.parentId = nodes.find((n) => n.branch === parent.value)?.id ?? null;
      node.parentBranch = parent.value;
    }
  });
  return nodes;
}

function ancestorsOf(node, byId) {
  const seen = new Set();
  for (let id = node.parentId; id && !seen.has(id) && byId.has(id); id = byId.get(id).parentId) seen.add(id);
  return seen;
}

// { pairs, collisions }: `pairs` counts the incomparable pairs of nodes, `collisions` those that share a path, as
// { a, b, shared } in node order. Throws on a glob in any node's paths.
export function checkCollisions(nodes) {
  for (const node of nodes) {
    const glob = node.paths.find((p) => GLOB.test(p));
    if (glob !== undefined) throw new Error(`globs are not supported in Files: ${glob}`);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const up = new Map(nodes.map((n) => [n.id, ancestorsOf(n, byId)]));
  let pairs = 0;
  const collisions = [];
  for (const [i, a] of nodes.entries()) {
    for (const b of nodes.slice(i + 1)) {
      if (up.get(a.id).has(b.id) || up.get(b.id).has(a.id)) continue;
      pairs += 1;
      const theirs = new Set(b.paths);
      const shared = a.paths.filter((p) => theirs.has(p));
      if (shared.length > 0) collisions.push({ a: a.id, b: b.id, shared });
    }
  }
  return { pairs, collisions };
}

// The paths of `changed` that `node` does not name in its Files.
export function diffOutside(node, changed) {
  const own = new Set(node.paths);
  return changed.filter((p) => !own.has(p));
}
