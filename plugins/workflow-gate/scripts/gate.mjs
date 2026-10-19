#!/usr/bin/env node
// PreToolUse gate for the Workflow tool.
//
// Why this exists (2026-09-11): a migration-audit workflow fanned out to 92
// Fable agents because its verify stage did `findings.map(f => 3 refuters)`
// with no cap and no per-role model. The "Dynamic workflow size" setting is
// only advisory text in the tool prompt; nothing enforced it.
//
// The gate controls one thing: how many agents of each expensive model a
// script may launch. Caps per model family (env overrides in parentheses):
//   fable  3  (WORKFLOW_MAX_FABLE)
//   opus   8  (WORKFLOW_MAX_OPUS)
//   sonnet 12 (WORKFLOW_MAX_SONNET)
//   haiku  unlimited
// To check that mechanically it needs:
//   1. every agent() call to resolve to a model: a string `model:` or a
//      `roles:*` agentType (whose model is known);
//   2. a budget comment  // MAX_AGENTS: fable=0 opus=2 sonnet=4  with each
//      family within its cap and at least the number of call sites using it;
//   3. no unbounded fan-out over a dynamic list that launches non-Haiku
//      agents (cap it with .slice(0, N)). Haiku-only fan-outs are free.
//
// Every denial lists all problems found, each with its fix.
// Named built-in workflows (no script, no scriptPath, not found locally)
// are allowed: they are Anthropic-authored and not under this discipline.
//
// `gate.mjs agent` is the second check: a burst cap on same-model starts through the Agent tool, per session
// (agent-gate.mjs). It shares CAPS and ROLE_MODELS and adds WORKFLOW_GATE_AGENT_WINDOW_S (default 120).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { decideAgent, DEFAULT_WINDOW_S } from "./agent-gate.mjs";

const capFrom = (name, dflt) => (Number(process.env[name]) >= 0 && process.env[name] !== undefined && process.env[name] !== "" ? Number(process.env[name]) : dflt);
const CAPS = {
  fable: capFrom("WORKFLOW_MAX_FABLE", 3),
  opus: capFrom("WORKFLOW_MAX_OPUS", 8),
  sonnet: capFrom("WORKFLOW_MAX_SONNET", 12),
  haiku: Infinity,
};
const CAPPED = ["fable", "opus", "sonnet"];
// The sliding window of the Agent burst cap, in seconds: a number above 0, else the default.
const windowFrom = (name, dflt) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : dflt);

// Model of each roles:* agent (plugins/roles/agents/*.md frontmatter; a test keeps this in sync).
const ROLE_MODELS = {
  "brief-writer": "haiku",
  "tdd-implementer": "sonnet",
  "complex-implementer": "opus",
  "safety-reviewer": "haiku",
  "spec-reviewer": "opus",
  "review-fixer": "sonnet",
  "final-adversarial-reviewer": "opus",
  "hunter": "haiku",
};

// A decision is data: { decision: 'allow' | 'deny', reason }. main() prints it once the check, and any lock it held,
// are done.
const deny = (reason) => ({ decision: 'deny', reason });
const allow = (reason) => ({ decision: 'allow', reason });

function decideWorkflow(input) {
  const ti = input.tool_input ?? {};

  function resolveScript() {
    if (typeof ti.script === "string" && ti.script.trim()) return ti.script;
    if (typeof ti.scriptPath === "string" && existsSync(ti.scriptPath)) return readFileSync(ti.scriptPath, "utf8");
    if (typeof ti.name === "string") {
      const candidates = [
        join(process.cwd(), ".claude", "workflows", `${ti.name}.js`),
        join(process.cwd(), ".claude", "workflows", `${ti.name}.mjs`),
        join(homedir(), ".claude", "workflows", `${ti.name}.js`),
        join(homedir(), ".claude", "workflows", `${ti.name}.mjs`),
      ];
      for (const c of candidates) if (existsSync(c)) return readFileSync(c, "utf8");
      return null; // built-in named workflow
    }
    return null;
  }

  const script = resolveScript();
  if (script == null) return allow();

  // Strip comments for structural checks, but keep the original for the MAX_AGENTS declaration.
  const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");

  // --- 1. every agent() call resolves to a model --------------------------------
  function extractCallArgs(src, idx) {
    // idx points at the "(" that opens the call. Return the text inside the
    // balanced parens, honouring strings and template literals crudely.
    let depth = 0;
    let i = idx;
    let quote = null;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) return src.slice(idx + 1, i); }
    }
    return src.slice(idx + 1);
  }

  function familyOf(model) {
    const m = model.toLowerCase();
    for (const f of ["fable", "opus", "sonnet", "haiku"]) if (m.includes(f)) return f;
    return null;
  }

  // Classify one agent() call's argument text: { family } or { problem }.
  function classify(args) {
    const model = args.match(/\bmodel\s*:\s*(["'`])([^"'`]*)\1/);
    if (model) {
      const f = familyOf(model[2]);
      return f ? { family: f } : { problem: `model: "${model[2]}" is not a fable/opus/sonnet/haiku model` };
    }
    if (/\bmodel\s*:/.test(args)) return { problem: "model: is not a string literal, so its model cannot be checked; write it as a literal, e.g. model: \"sonnet\"" };
    const type = args.match(/\bagentType\s*:\s*(["'`])([^"'`]*)\1/);
    if (type) {
      const role = type[2].match(/^roles:([\w-]+)$/);
      if (role && ROLE_MODELS[role[1]]) return { family: ROLE_MODELS[role[1]] };
      return { problem: `agentType: "${type[2]}" has no known model; add an explicit model: (e.g. model: "haiku") or use a roles:* agent` };
    }
    if (/\bagentType\s*:/.test(args)) return { problem: "agentType: is not a string literal; write it as a literal roles:* name or add model:" };
    return { problem: "sets neither model: nor agentType:, so it would inherit the session model; add a roles:* agentType or model: (fable/opus/sonnet/haiku)" };
  }

  const agentCalls = []; // { args, at, family?, problem? }
  const re = /(^|[^\w.$])agent\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    const args = extractCallArgs(code, open);
    const line = code.slice(0, open).split("\n").length;
    agentCalls.push({ args, line, ...classify(args) });
  }

  const problems = [];
  for (const c of agentCalls) if (c.problem) problems.push(`agent() call on line ${c.line} ${c.problem}.`);

  const sites = { fable: 0, opus: 0, sonnet: 0, haiku: 0 };
  for (const c of agentCalls) if (c.family) sites[c.family]++;
  const used = CAPPED.filter((f) => sites[f] > 0);

  // --- 2. declared per-model budget ----------------------------------------------
  const declLine = script.match(/\/\/\s*MAX_AGENTS\s*:([^\n]*)/);
  const declared = {};
  if (used.length) {
    if (!declLine) {
      problems.push(`no budget comment. Add one line, counting every agent each model launches (including inside parallel()/pipeline()/loops): // MAX_AGENTS: ${CAPPED.map((f) => `${f}=${sites[f]}`).join(" ")}`);
    } else {
      const body = declLine[1];
      for (const [, k, v] of body.matchAll(/\b(fable|opus|sonnet|haiku)\s*=\s*(\d+)/gi)) declared[k.toLowerCase()] = Number(v);
      if (!Object.keys(declared).length) {
        problems.push(`"// MAX_AGENTS:${body}" is the old single-number form. Declare per model instead, e.g. // MAX_AGENTS: ${CAPPED.map((f) => `${f}=${sites[f]}`).join(" ")}`);
      } else {
        for (const f of used) {
          if (declared[f] === undefined) problems.push(`the script launches ${f} agents (${sites[f]} call site(s)) but MAX_AGENTS does not declare ${f}=N; add it.`);
          else if (declared[f] < sites[f]) problems.push(`MAX_AGENTS declares ${f}=${declared[f]} but the script has ${sites[f]} ${f} agent() call site(s); declare at least ${sites[f]}.`);
        }
        for (const f of CAPPED) {
          if (declared[f] !== undefined && declared[f] > CAPS[f]) problems.push(`MAX_AGENTS declares ${f}=${declared[f]}, over the ${f} cap of ${CAPS[f]}. Move work to a cheaper model (haiku is unlimited), slice the fan-out, or split into sequential workflows.`);
        }
      }
    }
  }

  // --- 3. no unbounded fan-out -------------------------------------------------
  const literalArrays = new Set();
  const constRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g;
  while ((m = constRe.exec(code))) literalArrays.add(m[1]);

  // `code` with the contents of string and template literals blanked (same length), so text inside them
  // is never read as brackets or as a .slice( link.
  function maskStrings(src) {
    let out = "", quote = null;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\") { out += " "; if (i + 1 < src.length) { out += " "; i++; } continue; }
        if (ch === quote) { quote = null; out += ch; } else out += ch === "\n" ? "\n" : " ";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      out += ch;
    }
    return out;
  }
  const masked = maskStrings(code);

  // True when the member chain that ends `src` (masked text right before a .map) is capped: reading its
  // links backwards from the .map, only `.filter(...)` links may come before a `.slice(...)` link. Anything
  // else (a property, an index, another method, an operator, a statement boundary, a line break) ends the
  // search uncapped, so a .slice elsewhere in the text never counts.
  function cappedBySlice(src) {
    let i = src.length;
    const skipBlanks = () => { while (i > 0 && (src[i - 1] === " " || src[i - 1] === "\t")) i--; };
    for (;;) {
      skipBlanks();
      if (src[i - 1] !== ")") return false;
      let depth = 0, j = i - 1;
      for (; j >= 0; j--) {
        if (")]}".includes(src[j])) depth++;
        else if ("([{".includes(src[j]) && --depth === 0) break;
      }
      if (j < 0 || src[j] !== "(") return false;
      i = j;
      skipBlanks();
      const name = src.slice(0, i).match(/([A-Za-z_$][\w$]*)$/);
      if (!name) return false;
      i -= name[1].length;
      skipBlanks();
      if (src[i - 1] !== ".") return false;
      i--;
      if (name[1] === "slice") return true;
      if (name[1] !== "filter") return false;
    }
  }

  // A fan-out is exempt when the agents it launches are all Haiku: the agent() calls inside the
  // call's own arguments when there are any, otherwise the whole script's.
  const allHaiku = (calls) => calls.length > 0 && calls.every((c) => c.family === "haiku");
  function haikuOnly(argsText) {
    const inner = [];
    const r = /(^|[^\w.$])agent\s*\(/g;
    let x;
    while ((x = r.exec(argsText))) inner.push(classify(extractCallArgs(argsText, x.index + x[0].length - 1)));
    return inner.length ? allHaiku(inner) : allHaiku(agentCalls);
  }

  const offenders = [];
  const mapRe = /\.map\s*\(/g;
  while ((m = mapRe.exec(code))) {
    // Walk backwards to find the chain this .map belongs to (identifier or bracket/paren group).
    const before = code.slice(Math.max(0, m.index - 400), m.index);
    // Direct literal:  [ ... ].map
    if (/\]\s*$/.test(before)) continue;
    // Something.slice(...).map, optionally with .filter(...) links before or after the .slice
    if (cappedBySlice(masked.slice(Math.max(0, m.index - 400), m.index))) continue;
    const ident = before.match(/([A-Za-z_$][\w$]*)\s*$/);
    if (ident && literalArrays.has(ident[1])) continue;
    if (ident && /^(Array)$/.test(ident[1])) continue;
    if (haikuOnly(extractCallArgs(code, m.index + m[0].length - 1))) continue;
    offenders.push((ident ? ident[1] : "<expr>") + ".map(");
  }
  // pipeline(items, ...) / parallel(thunks) take the list directly — check their
  // first argument with the same rule (.map chains are already covered above).
  function firstArg(args) {
    let depth = 0, quote = null;
    for (let i = 0; i < args.length; i++) {
      const ch = args[i];
      if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
      else if (ch === "," && depth === 0) return args.slice(0, i).trim();
    }
    return args.trim();
  }
  const fanRe = /(^|[^\w.$])(pipeline|parallel)\s*\(/g;
  while ((m = fanRe.exec(code))) {
    const open = m.index + m[0].length - 1;
    const callArgs = extractCallArgs(code, open);
    const arg = firstArg(callArgs);
    if (!arg) continue;
    if (arg.startsWith("[")) continue; // literal
    if (/\.slice\s*\(/.test(arg)) continue; // capped
    if (/\.map\s*\(/.test(arg)) continue; // covered by the .map rule
    if (/^Array\.from\s*\(\s*\{\s*length\s*:\s*\d+/.test(arg)) continue; // literal length
    const ident = arg.match(/^([A-Za-z_$][\w$]*)$/);
    if (ident && literalArrays.has(ident[1])) continue;
    if (haikuOnly(callArgs.slice(arg.length))) continue;
    offenders.push(`${m[2]}(${arg.length > 40 ? arg.slice(0, 40) + "…" : arg}`);
  }

  if (offenders.length) {
    problems.push(
      `unbounded fan-out: ${offenders.join(", ")} iterates a dynamic list (not a literal array) that launches non-Haiku agents, so the per-model count cannot be bounded. Cap it in the same chain, e.g. findings.slice(0, 5).map(...), and count the result in MAX_AGENTS; or make those agents Haiku (unlimited).`,
    );
  }

  if (problems.length) {
    return deny(
      `Workflow denied: ${problems.length} problem(s). Caps per workflow: fable ${CAPS.fable}, opus ${CAPS.opus}, sonnet ${CAPS.sonnet}, haiku unlimited.\n` +
        problems.map((p, i) => `${i + 1}. ${p}`).join("\n") +
        `\nFix them and call Workflow again. Role models: ${Object.entries(ROLE_MODELS).map(([r, f]) => `roles:${r}=${f}`).join(", ")}.`,
    );
  }

  const summary = CAPPED.filter((f) => declared[f] !== undefined || sites[f]).map((f) => `${f} ${declared[f] ?? sites[f]}/${CAPS[f]}`).join(", ");
  return allow(`ok: ${agentCalls.length} agent() call(s), ${summary || "haiku only"}, haiku unlimited, fan-outs bounded`);
}

function emit({ decision, reason }) {
  if (decision === "deny") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `[workflow-gate] ${reason}` },
      }),
    );
  } else if (reason) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: `[workflow-gate] ${reason}` },
      }),
    );
  }
}

// `gate.mjs` checks a Workflow call; `gate.mjs agent` checks an Agent or Task start. Either way the hook exits 0 after
// the decision is printed, and for Agent only once the state lock is released. A bad stdin allows.
async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}") ?? {};
  } catch {
    return;
  }
  if (process.argv[2] === "agent") {
    const d = await decideAgent(input, {
      stateDir: join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "triqual", "workflow-gate"),
      caps: CAPS,
      windowS: windowFrom("WORKFLOW_GATE_AGENT_WINDOW_S", DEFAULT_WINDOW_S),
      roleModels: ROLE_MODELS,
    });
    // An allow is silent: printing "allow" would also skip the user's permission prompt for the Agent tool.
    if (d.decision === "deny") emit(d);
    else if (d.reason) process.stderr.write(`[workflow-gate] ${d.reason}\n`);
  } else {
    emit(decideWorkflow(input));
  }
}

await main();
process.exitCode = 0;
