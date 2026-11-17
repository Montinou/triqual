// The experiments file (`experimentsPath`) and the stable arm split. node: built-ins only.
// Shape: { "experiments": [{ id, kind, status, start, control, arms: { <arm>: payload }, margin, objective, evaluators }] }.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ARM_PART, EFFORTS, MODEL, ROLE_NAME } from './role-eval.mjs';

export const KINDS = ['session', 'role', 'skill'];
export const STATUSES = ['active', 'paused', 'done'];
export const OBJECTIVES = ['cost', 'parallelism'];
export const DEFAULT_MARGIN = 0.10;
// The role-eval record rules for an experiment id, an arm name, a role and a model and effort: one definition, so an
// experiment `start` accepts is one its `eval plan-review --arm` and task-review records accept.
export { ARM_PART, EFFORTS, MODEL, ROLE_NAME };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The experiments of `file`; a missing file is []. `objective` defaults to "cost" and `margin` to 0.10.
export function loadExperiments(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const list = JSON.parse(text)?.experiments;
  if (!Array.isArray(list)) return [];
  return list.map((e) => (isObject(e)
    ? { ...e, objective: e.objective ?? 'cost', margin: e.margin ?? DEFAULT_MARGIN }
    : e));
}

// What an active experiment competes for: the session, the skill, or (role) the one role of its arms.
function targetOf(e) {
  if (e.kind === 'role') return Object.values(e.arms)[0]?.role;
  return e.kind;
}

// { ok: true } or { ok: false, field } naming the first offending field as `experiments.<index>.<name>`.
export function validateExperiments(list) {
  const bad = (i, name) => ({ ok: false, field: `experiments.${i}.${name}` });
  const taken = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i];
    if (!isObject(e)) return { ok: false, field: `experiments.${i}` };
    if (typeof e.id !== 'string' || !ARM_PART.test(e.id)) return bad(i, 'id');
    if (!KINDS.includes(e.kind)) return bad(i, 'kind');
    if (!STATUSES.includes(e.status)) return bad(i, 'status');
    if (!OBJECTIVES.includes(e.objective ?? 'cost')) return bad(i, 'objective');
    if (!isObject(e.arms) || Object.keys(e.arms).length !== 2) return bad(i, 'arms');
    if (typeof e.control !== 'string' || !Object.hasOwn(e.arms, e.control)) return bad(i, 'control');
    if (!Object.keys(e.arms).every((name) => ARM_PART.test(name))) return bad(i, 'arms');
    const m = e.margin ?? DEFAULT_MARGIN;
    if (typeof m !== 'number' || !(m > 0 && m < 1)) return bad(i, 'margin');
    if (e.kind === 'role') {
      const payloads = Object.values(e.arms);
      if (!payloads.every((p) => isObject(p) && typeof p.role === 'string' && ROLE_NAME.test(p.role)
        && typeof p.model === 'string' && MODEL.test(p.model) && EFFORTS.includes(p.effort))) return bad(i, 'arms');
      if (payloads[0].role !== payloads[1].role) return bad(i, 'arms');
    }
    if (e.status === 'active') {
      if (typeof e.evaluators !== 'string' || e.evaluators === '') return bad(i, 'evaluators');
      const key = `${e.kind}:${targetOf(e)}`;
      if (taken.has(key)) return bad(i, 'status');
      taken.add(key);
    }
  }
  return { ok: true };
}

// The arm of `key` in experiment `experimentId`: sorted arm names indexed by the first 8 bytes of
// SHA-256(`${experimentId}\0${key}`) as a big-endian BigInt mod the count.
export function pickArm(experimentId, armNames, key) {
  const names = [...armNames].sort();
  const digest = createHash('sha256').update(`${experimentId}\0${key}`).digest();
  return names[Number(digest.readBigUInt64BE(0) % BigInt(names.length))];
}

// The arm of `key` in the active experiment of `kind` and `target` (default: the kind, which is the target of
// session and skill experiments; a role experiment's target is its role), or null when none is active.
export function armFor(kind, key, { experiments, target = kind } = {}) {
  const experiment = (experiments ?? []).find(
    (e) => e.status === 'active' && e.kind === kind && targetOf(e) === target,
  );
  if (!experiment) return null;
  const arm = pickArm(experiment.id, Object.keys(experiment.arms), key);
  return { experiment, arm, payload: experiment.arms[arm] };
}
