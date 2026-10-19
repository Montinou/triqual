// `fence apply <draft>` and `fence edit` (spec, "CLI"; both human-only).
//
//   apply({draftPath, policyPath?, home?, confirm, gate?, io?}) -> Promise<result>
//   applyFacts({draftPath, policyPath?}) -> {provenTightening, reasons}
//   edit({policyPath?, home?, env?, spawn, draftDir?, io?}) -> {ok, draftPath, status?, reason?}
//
// apply, in this order:
//   1. Refuse a draft that is the policy file itself (same path, a symlink to it, or a hard link)
//      or is not a regular file. Read the draft's bytes once; everything after works on them.
//   2. Validate them with the policy loader (strict JSON, schema, globs, except kinds), on a
//      private snapshot in a fresh temp directory (removed at the end). Errors block.
//   3. Show the rendered-rule diff (renderRules of the current policy and of the draft) and the
//      JSON diff (both pretty-printed), lines prefixed "- " (current), "+ " (draft), "  " (both).
//   4. Classify the change (classifyChange in weakening.mjs; conservative). The current policy is
//      a baseline only when it loads through loadPolicy (full loader checks); one that is missing,
//      unreadable or does not load makes the change weakening.
//   5. Run the draft's examples (`fence test`, runTest in check.mjs) on the snapshot; a failing
//      example blocks.
//   6. `confirm(summary)` must answer true (summary: {renderedDiff, jsonDiff, weakening, reasons}).
//   7. Only when the change weakens the policy: `gate()` must answer true or {ok: true} (the CLI
//      wiring passes sudoGate with the real runner); a missing gate refuses.
//   8. Write the draft's bytes over the policy by write-temp-then-rename inside the policy's own
//      directory (writeAtomic in install.mjs), keeping an existing file's permission bits. A
//      symlinked policy path is written through its realpath (the link stays a link); a dangling
//      link is refused.
//   9. Record policy_sha: the sha256 of the written bytes, the value the engine logs and doctor
//      reports (both compute it from the policy file's bytes at load; there is no other store),
//      returned as `policySha` and printed as `policy_sha <hex>`.
// After a successful write, a draft made by `edit` (its directory holds edit's marker) is removed
// with its directory; any other draft is left alone.
// Nothing else is written: no host configuration, no state file. The result is
// {ok, reason?, weakening, reasons, renderedDiff, jsonDiff, testOutput, policySha?, policyPath}.
//
// applyFacts gives the human-only table its `provenTightening` fact for `apply`: the
// classification of the draft against the current policy; it never throws (fail closed).
//
// edit copies the policy into a fresh directory under `draftDir` (default os.tmpdir()) and opens
// the copy with $EDITOR (else $VISUAL, else vi; split on whitespace, no shell) through the injected
// `spawn` (spawnSync shape, required). The policy itself is never opened or written.

import { createHash } from 'node:crypto';
import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import { parseStrictJson } from '../policy/parse.mjs';
import { renderRules } from '../policy/render.mjs';
import { validatePolicy } from '../policy/schema.mjs';
import { loadPolicy } from '../policy/load.mjs';
import { DEFAULT_POLICY, runTest } from './check.mjs';
import { writeAtomic } from './install.mjs';
import { classifyChange } from './weakening.mjs';

const MAX_DIFF_CELLS = 4_000_000;
const errText = (err) => (err instanceof Error ? err.message : String(err));

// A line diff (longest common subsequence): "  " both, "- " only in `a`, "+ " only in `b`.
export function lineDiff(a, b) {
  const x = a === '' ? [] : a.split('\n');
  const y = b === '' ? [] : b.split('\n');
  if (x.length * y.length > MAX_DIFF_CELLS) return [...x.map((l) => `- ${l}`), ...y.map((l) => `+ ${l}`)].join('\n');
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push(`  ${x[i++]}`);
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  while (i < n) out.push(`- ${x[i++]}`);
  while (j < m) out.push(`+ ${y[j++]}`);
  return out.join('\n');
}

// The parsed (strict) JSON of `bytes`, or null when it is not a policy-shaped JSON text.
function parseBytes(bytes) {
  try {
    return parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return null;
  }
}

// The current policy, read once: {parsed, text, error?}. `parsed` is its strict parse (for the
// diffs); `error` is set when it can not be read or does not pass the LOADER's full checks
// (loadPolicy on the same bytes: schema, except-kind compatibility, glob compile and never-match
// checks). A current policy with an error denies every call at hook time, so no change from it is
// proven to tighten anything.
function readCurrent(policyPath, home) {
  let bytes;
  try {
    bytes = nodeFs.readFileSync(policyPath);
  } catch (err) {
    return { parsed: null, text: '', error: `the current policy ${policyPath} can not be read (${err?.code ?? errText(err)})` };
  }
  const parsed = parseBytes(bytes);
  const text = parsed === null ? bytes.toString('utf8') : JSON.stringify(parsed, null, 2);
  try {
    loadPolicy(policyPath, { home, fs: { readFileSync: () => bytes, statSync: nodeFs.statSync, realpathSync: nodeFs.realpathSync } });
  } catch (err) {
    const where = err?.pointer ? ` at ${err.pointer}` : '';
    return { parsed, text, error: `the current policy does not load (${err?.code ?? 'error'}${where}: ${errText(err)})` };
  }
  return { parsed, text };
}

// classifyChange against the current policy; one that does not load is never a baseline.
function classifyAgainst(current, next) {
  if (current.error) return { weakening: true, reasons: [`${current.error}, so the change can not be proven to tighten it`] };
  return classifyChange(current.parsed, next);
}

// The file a write to `policyPath` must replace: its realpath when it is a symlink (the link stays a
// link). -> {target} | {error}
function writeTarget(policyPath) {
  try {
    return { target: nodeFs.realpathSync(policyPath) };
  } catch {
    let link = false;
    try {
      link = nodeFs.lstatSync(policyPath).isSymbolicLink();
    } catch {
      // no file at all: written in place
    }
    if (link) return { error: `the policy path ${policyPath} is a dangling symlink; nothing was written` };
    return { target: policyPath };
  }
}

// edit marks the directory of the copy it makes; apply removes that copy after a successful write.
const EDIT_MARKER = '.fence-edit';

function removeEditDraft(draftPath) {
  const dir = nodePath.dirname(draftPath);
  const marker = nodePath.join(dir, EDIT_MARKER);
  try {
    if (!nodeFs.lstatSync(marker).isFile()) return;
  } catch {
    return; // not a copy edit made
  }
  for (const f of [draftPath, marker]) nodeFs.rmSync(f, { force: true });
  try {
    nodeFs.rmdirSync(dir); // only when nothing else is in it
  } catch {
    // something else lives there: left alone
  }
}

function rendered(parsed) {
  if (parsed === null) return '';
  try {
    return renderRules(validatePolicy(parsed), Infinity);
  } catch {
    return '';
  }
}

// Why `draftPath` can not be a draft for `policyPath`, or null.
function draftProblem(draftPath, policyPath) {
  if (nodePath.resolve(draftPath) === nodePath.resolve(policyPath)) return 'the draft is the policy file itself';
  let st;
  try {
    st = nodeFs.statSync(draftPath);
  } catch (err) {
    return `the draft ${draftPath} can not be read: ${err?.code ?? errText(err)}`;
  }
  if (!st.isFile()) return `the draft ${draftPath} is not a regular file`;
  try {
    const pst = nodeFs.statSync(policyPath);
    if (pst.dev === st.dev && pst.ino === st.ino) return 'the draft is the policy file itself (a link to it)';
  } catch {
    // no current policy: nothing to be the same file as
  }
  return null;
}

function resolvePaths({ draftPath, policyPath, home }) {
  if (typeof draftPath !== 'string' || draftPath === '') throw new Error('apply needs a draft file');
  const h = home ?? os.homedir();
  return { draft: nodePath.resolve(draftPath), policy: nodePath.resolve(policyPath ?? DEFAULT_POLICY(h)), home: h };
}

// Never throws: any problem (a draft that can not be read included) is {weakening: true, error}, so
// the caller gates (fail closed).
export function applyFacts({ draftPath, policyPath, home } = {}) {
  const weak = (error) => ({ provenTightening: false, weakening: true, reasons: [error], error });
  try {
    const p = resolvePaths({ draftPath, policyPath, home });
    const problem = draftProblem(p.draft, p.policy);
    if (problem) return weak(problem);
    let bytes;
    try {
      bytes = nodeFs.readFileSync(p.draft);
    } catch (err) {
      return weak(`the draft ${p.draft} can not be read (${err?.code ?? errText(err)})`);
    }
    const c = classifyAgainst(readCurrent(p.policy, p.home), parseBytes(bytes));
    return { provenTightening: !c.weakening, weakening: c.weakening, reasons: c.reasons };
  } catch (err) {
    return weak(`the change could not be classified: ${errText(err)}`);
  }
}

export async function apply({ draftPath, policyPath, home, confirm, gate, io } = {}) {
  const say = (s) => {
    if (typeof io?.out === 'function') io.out(s);
  };
  const result = { ok: false, weakening: true, reasons: [], renderedDiff: '', jsonDiff: '', testOutput: '', policyPath: null };
  const fail = (reason) => ({ ...result, ok: false, reason });
  let p;
  try {
    p = resolvePaths({ draftPath, policyPath, home });
  } catch (err) {
    return fail(errText(err));
  }
  result.policyPath = p.policy;
  const problem = draftProblem(p.draft, p.policy);
  if (problem) return fail(problem);
  const where = writeTarget(p.policy);
  if (where.error) return fail(where.error);

  let snapDir = null;
  try {
    // 1-2: the draft's bytes, read once, validated on a private snapshot
    const bytes = nodeFs.readFileSync(p.draft);
    snapDir = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fence-apply-')));
    const snapshot = nodePath.join(snapDir, 'draft.json');
    nodeFs.writeFileSync(snapshot, bytes, { mode: 0o600 });
    try {
      loadPolicy(snapshot, { home: p.home });
    } catch (err) {
      const where = err?.pointer ? ` at ${err.pointer}` : '';
      return fail(`the draft is not a valid policy: ${err?.code ?? 'error'}${where}: ${errText(err)}`);
    }
    const next = parseBytes(bytes);

    // 3: the diffs
    const current = readCurrent(p.policy, p.home);
    result.renderedDiff = lineDiff(rendered(current.parsed), rendered(next));
    result.jsonDiff = lineDiff(current.text, JSON.stringify(next, null, 2));
    say(`Rendered rules (- current, + draft):\n${result.renderedDiff}`);
    say(`Policy JSON (- current, + draft):\n${result.jsonDiff}`);

    // 4: the classification
    const c = classifyAgainst(current, next);
    result.weakening = c.weakening;
    result.reasons = c.reasons;
    if (c.weakening) say(`This change weakens the policy (it needs sudo authentication):\n${c.reasons.map((r) => `  - ${r}`).join('\n')}`);
    else say('This change only tightens the policy.');

    // 5: the draft's examples
    const lines = [];
    const code = runTest(['--policy', snapshot], { out: (s) => (lines.push(s), say(s)), err: (s) => (lines.push(s), say(s)) }, { home: p.home, builtin: false });
    result.testOutput = lines.join('\n');
    if (code !== 0) return fail(`the draft's examples failed (fence test exit ${code}); nothing was written`);

    // 6: confirmation
    if (typeof confirm !== 'function') return fail('apply needs a confirmation step; nothing was written');
    const yes = await confirm({ renderedDiff: result.renderedDiff, jsonDiff: result.jsonDiff, weakening: result.weakening, reasons: [...result.reasons] });
    if (yes !== true) return fail('the change was not confirmed; nothing was written');

    // 7: the sudo gate, only when the change weakens the policy
    if (result.weakening) {
      if (typeof gate !== 'function') return fail('this change weakens the policy and needs fresh sudo authentication, but no gate was given; nothing was written');
      const g = await gate();
      if (!(g === true || g?.ok === true)) {
        return fail(`this change weakens the policy and needs fresh sudo authentication: ${g?.reason ?? 'the gate refused'}; nothing was written`);
      }
    }

    // 8-9: write by temp-and-rename inside the policy's directory, record policy_sha
    let mode = 0o644;
    try {
      mode = nodeFs.statSync(where.target).mode & 0o777;
    } catch {
      // no current policy: the default mode
    }
    writeAtomic(where.target, bytes, mode);
    result.policySha = createHash('sha256').update(bytes).digest('hex');
    say(`Applied ${p.draft} to ${p.policy}; policy_sha ${result.policySha}`);
    try {
      removeEditDraft(p.draft);
    } catch {
      // best effort: the policy is written; a leftover copy is harmless
    }
    return { ...result, ok: true };
  } catch (err) {
    return fail(`apply failed: ${errText(err)}`);
  } finally {
    if (snapDir !== null) nodeFs.rmSync(snapDir, { recursive: true, force: true });
  }
}

export function edit({ policyPath, home, env = process.env, spawn, draftDir, io } = {}) {
  if (typeof spawn !== 'function') throw new Error('edit: no spawn function was given');
  const h = home ?? os.homedir();
  const policy = nodePath.resolve(policyPath ?? DEFAULT_POLICY(h));
  const editorLine = [env?.EDITOR, env?.VISUAL].find((v) => typeof v === 'string' && v.trim() !== '') ?? 'vi';
  const [cmd, ...args] = editorLine.trim().split(/\s+/);
  let bytes;
  try {
    bytes = nodeFs.readFileSync(policy);
  } catch (err) {
    return { ok: false, reason: `the policy ${policy} can not be read: ${err?.code ?? errText(err)}` };
  }
  const dir = nodeFs.mkdtempSync(nodePath.join(draftDir ?? os.tmpdir(), 'fence-edit-'));
  const draftPath = nodePath.join(dir, 'policy.json');
  nodeFs.writeFileSync(draftPath, bytes, { mode: 0o600, flag: 'wx' });
  nodeFs.writeFileSync(nodePath.join(dir, EDIT_MARKER), '', { mode: 0o600, flag: 'wx' });
  const r = spawn(cmd, [...args, draftPath], { stdio: 'inherit' });
  const status = r?.status ?? null;
  if (r?.error || status !== 0) {
    return { ok: false, draftPath, status, reason: `the editor ${cmd} ${r?.error ? `could not run (${errText(r.error)})` : `exited with ${status}`}; the draft is kept at ${draftPath}` };
  }
  if (typeof io?.out === 'function') io.out(`Edited a copy at ${draftPath}; run fence apply ${draftPath} to apply it.`);
  return { ok: true, draftPath, status };
}
