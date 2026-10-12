#!/usr/bin/env node
// PreToolUse gate for the Workflow tool.
//
// Why this exists (2026-09-11): a migration-audit workflow fanned out to 92
// Fable agents because its verify stage did `findings.map(f => 3 refuters)`
// with no cap and no per-role model. The "Dynamic workflow size: medium"
// setting is only advisory text in the tool prompt; nothing enforced it.
// This hook makes three things mechanical:
//
//   1. The script must declare its total agent budget:  // MAX_AGENTS: N
//      with N <= WORKFLOW_MAX_AGENTS (default 15). The author has to compute
//      the number before launching, and the number is visible in the script.
//   2. Every agent() call must dispatch by role: an `agentType:` (a role
//      agent such as roles:tdd-implementer; see the role table in the global
//      rules) or an explicit `model:`. No call may silently inherit the
//      session model.
//   3. No unbounded fan-out: every `.map(` whose receiver is not a literal
//      array (or a const bound to one in the same script) must be preceded
//      by `.slice(` in the same chain. `findings.map(...)` is rejected;
//      `findings.slice(0, 5).map(...)` and `LENSES.map(...)` (LENSES a
//      literal) pass.
//
// Output is the PreToolUse JSON contract: permissionDecision deny + reason.
// Named built-in workflows (no script, no scriptPath, not found locally)
// are allowed: they are Anthropic-authored and not under this discipline.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CAP = Number(process.env.WORKFLOW_MAX_AGENTS) > 0 ? Number(process.env.WORKFLOW_MAX_AGENTS) : 15;

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[workflow-gate] ${reason}`,
      },
    }),
  );
  process.exit(0);
}
function allow(note) {
  if (note) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: `[workflow-gate] ${note}` },
      }),
    );
  }
  process.exit(0);
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  allow();
}
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
if (script == null) allow();

// Strip comments for structural checks, but keep the original for the MAX_AGENTS declaration.
const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");

// --- 1. declared budget -----------------------------------------------------
const decl = script.match(/\/\/\s*MAX_AGENTS\s*:\s*(\d+)/);
if (!decl) {
  deny(
    `the script must declare its total agent budget as a comment "// MAX_AGENTS: N" (N <= ${CAP}). Count every agent() call including those inside parallel()/pipeline()/loops, write the number, and keep it <= ${CAP}.`,
  );
}
const declared = Number(decl[1]);
if (declared > CAP) {
  deny(`declared MAX_AGENTS ${declared} exceeds the cap of ${CAP}. Reduce the fan-out (slice inputs, fewer lenses, fewer rounds) or split into sequential workflows.`);
}

// --- 2. every agent() call dispatches by role -------------------------------
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

const agentCalls = [];
const re = /(^|[^\w.$])agent\s*\(/g;
let m;
while ((m = re.exec(code))) {
  const open = m.index + m[0].length - 1;
  agentCalls.push(extractCallArgs(code, open));
}
const undispatched = agentCalls.filter((args) => !/\b(agentType|model)\s*:/.test(args));
if (undispatched.length) {
  deny(
    `${undispatched.length} of ${agentCalls.length} agent() call(s) neither set agentType: (a role agent such as roles:tdd-implementer) nor model:. Without one the agent inherits the session model. Use the role table in the global rules (roles:brief-writer, roles:tdd-implementer, roles:complex-implementer, roles:safety-reviewer, roles:spec-reviewer, roles:review-fixer, roles:final-adversarial-reviewer, roles:hunter) or pass model: explicitly.`,
  );
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
  const arg = firstArg(extractCallArgs(code, open));
  if (!arg) continue;
  if (arg.startsWith("[")) continue; // literal
  if (/\.slice\s*\(/.test(arg)) continue; // capped
  if (/\.map\s*\(/.test(arg)) continue; // covered by the .map rule
  if (/^Array\.from\s*\(\s*\{\s*length\s*:\s*\d+/.test(arg)) continue; // literal length
  const ident = arg.match(/^([A-Za-z_$][\w$]*)$/);
  if (ident && literalArrays.has(ident[1])) continue;
  offenders.push(`${m[2]}(${arg.length > 40 ? arg.slice(0, 40) + "…" : arg}`);
}

if (offenders.length) {
  deny(
    `unbounded fan-out: ${offenders.join(", ")} iterates a value that is not a literal array and is not capped with .slice(0, N) in the same chain. A dynamic list (findings, files, items) MUST be capped before it becomes agents: e.g. findings.slice(0, 5). Declare the resulting total in MAX_AGENTS.`,
  );
}

allow(`ok: MAX_AGENTS ${declared} <= ${CAP}, ${agentCalls.length} agent() call(s) all role-dispatched, fan-outs bounded`);
