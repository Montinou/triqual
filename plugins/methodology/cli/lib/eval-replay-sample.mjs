// Loads replay cases, draws a stratified sample, and estimates a dry-run cost. node: built-ins only.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRICES } from './eval-plans.mjs';
import { mulberry32 } from './eval-stats.mjs';

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Every <id>/case.json under casesDir with v 1, validated, and the given role version. Unreadable or other files skipped.
export function loadCases(casesDir, { role, roleVersion }) {
  let entries = [];
  try { entries = readdirSync(casesDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(casesDir, e.name);
    let doc;
    try { doc = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')); } catch { continue; }
    if (doc?.v !== 1 || doc.validated !== true || doc.role !== role || doc.roleVersion !== roleVersion) continue;
    out.push({ ...doc, dir });
  }
  return out.sort(byId);
}

function shuffled(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Hamilton (largest remainder) quotas: floor share, leftover seats by remainder, ties by repoName.
function quotas(names, counts, n) {
  const total = names.reduce((s, name) => s + counts.get(name), 0);
  const rows = names.map((name) => {
    const exact = (n * counts.get(name)) / total;
    const floor = Math.floor(exact);
    return { name, floor, rem: exact - floor };
  });
  let left = n - rows.reduce((s, r) => s + r.floor, 0);
  const ranked = [...rows].sort((a, b) => b.rem - a.rem || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out = Object.fromEntries(rows.map((r) => [r.name, r.floor]));
  for (const r of ranked) {
    if (left <= 0) break;
    out[r.name] += 1;
    left -= 1;
  }
  return out;
}

// All cases when n is at least the pool; else a seeded stratified sample by repoName, sorted by id.
export function sampleCases(cases, { n, seed }) {
  if (n >= cases.length) return [...cases].sort(byId);
  const byRepo = new Map();
  for (const c of cases) {
    const list = byRepo.get(c.repoName);
    if (list) list.push(c);
    else byRepo.set(c.repoName, [c]);
  }
  const names = [...byRepo.keys()].sort();
  const counts = new Map(names.map((name) => [name, byRepo.get(name).length]));
  const quota = quotas(names, counts, n);
  const rand = mulberry32(seed);
  const out = [];
  for (const name of names) {
    out.push(...shuffled(byRepo.get(name), rand).slice(0, quota[name]));
  }
  return out.sort(byId);
}

// Input USD per million tokens: first prices key that starts claude-<model>- (an alias) or equals model.
export function familyPrice(model, prices = PRICES) {
  const prefix = `claude-${model}-`;
  for (const [key, val] of Object.entries(prices)) {
    if (key.startsWith(prefix) || key === model) {
      return typeof val?.input === 'number' ? val.input : null;
    }
  }
  return null;
}

// sum(originalUsd) * runs * arm/control input prices; null when either price is unknown.
export function estimateUsd(cases, { armModel, controlModel, runs, prices = PRICES }) {
  const arm = familyPrice(armModel, prices);
  const control = familyPrice(controlModel, prices);
  if (arm == null || control == null) return null;
  const sum = cases.reduce((s, c) => s + (c.originalUsd ?? 0), 0);
  return (sum * runs * arm) / control;
}
