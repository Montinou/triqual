// Where the evals data lives. node: built-ins only; every function takes env and home so a test never reads the real ones.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { brandDir } from './brand.mjs';

// TRIQUAL_EVALS_DIR, else brandDir($XDG_DATA_HOME or home/.local/share)/evals.
export function evalsDir(env, home) {
  if (env.TRIQUAL_EVALS_DIR) return env.TRIQUAL_EVALS_DIR;
  return join(brandDir(env.XDG_DATA_HOME || join(home, '.local', 'share')), 'evals');
}

// TRIQUAL_EXPERIMENTS_FILE, else brandDir($XDG_CONFIG_HOME or home/.config)/experiments.json.
export function experimentsPath(env, home) {
  if (env.TRIQUAL_EXPERIMENTS_FILE) return env.TRIQUAL_EXPERIMENTS_FILE;
  return join(brandDir(env.XDG_CONFIG_HOME || join(home, '.config')), 'experiments.json');
}

// The Claude Code transcripts root: TRIQUAL_TRANSCRIPTS_DIR (as `triqual cost`), else home/.claude/projects.
export function transcriptsRoot(env, home) {
  return env.TRIQUAL_TRANSCRIPTS_DIR || join(home, '.claude', 'projects');
}

// Creates `dir` (and parents) with mode 0700; the data holds transcript-derived text.
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
