// What a plan cost to write, from the subagent transcripts. Read-only; node: built-ins only; never returns transcript text.
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionSignals } from './eval-sessions.mjs';

const PRICES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'prices.json'), 'utf8')).models;

// Every *.jsonl below `dir` that lies under a `subagents` directory.
function subagentTranscripts(dir, inside, out) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) subagentTranscripts(join(dir, e.name), inside || e.name === 'subagents', out);
    else if (inside && e.isFile() && e.name.endsWith('.jsonl')) out.push(join(dir, e.name));
  }
  return out;
}

const descriptionOf = (transcript) => {
  try {
    const description = JSON.parse(readFileSync(transcript.replace(/\.jsonl$/, '.meta.json'), 'utf8'))?.description;
    return typeof description === 'string' ? description : null;
  } catch {
    return null;
  }
};

// The USD (an estimate at the list prices of prices.json) of the subagent transcripts under `root` whose sibling
// agent-<id>.meta.json has the description `planner <plan file name>`; null when none matches. `planName` is the plan
// file's name, with or without `.md` and with or without a directory.
export function plannerUsd(root, planName, prices = PRICES) {
  const base = basename(planName);
  const wanted = `planner ${base.endsWith('.md') ? base : `${base}.md`}`;
  const matches = subagentTranscripts(root, false, []).filter((t) => descriptionOf(t) === wanted);
  if (matches.length === 0) return null;
  return matches.reduce((sum, t) => sum + sessionSignals(t, { prices }).usd, 0);
}
