// fence replay through a freshly staged home, for the offline acceptance run (spec, "Acceptance",
// items 3 and 4; test-only).
//
//   node replay-staged.mjs --transcripts <dir> --policy <file> --out <dir> [--labels <file>]
//
// `fence replay` has no --home flag (replay is open to the agent, and such a flag would spawn an
// agent-written fence-hook). This script stages a home from this package's own sources in a new temp
// directory (stage-home.mjs, with the given policy), then calls the replay module with that home as its
// `hookHome` seam, so every call goes through the staged watchdog and engine with HOME=<staged home>.
// The arguments go to replay unchanged (so --home is a usage error here too). The staged directory is
// removed afterwards; the exit code is replay's.

import nodeFs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import { runReplay } from '../../src/cli/replay.mjs';
import { stageHome } from './stage-home.mjs';

function policyArg(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--policy' && i + 1 < args.length) return args[i + 1];
    if (String(args[i]).startsWith('--policy=')) return String(args[i]).slice('--policy='.length);
  }
  return undefined;
}

const io = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

const args = process.argv.slice(2);
const policy = policyArg(args);
if (policy === undefined || policy === '') {
  io.err('usage: node replay-staged.mjs --transcripts <dir> --policy <file> --out <dir> [--labels <file>]');
  process.exit(1);
}
const root = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fence-replay-stage-')));
let code = 1;
try {
  const { home } = stageHome(nodePath.join(root, 'stage'), { policyPath: nodePath.resolve(policy) });
  // live progress on stderr, one line per decided call
  const progress = ({ n, tool, kind, ms, transcript }) => io.err(`[${n}] ${Math.round(ms)}ms ${kind} ${tool} (${transcript})`);
  code = runReplay(args, io, { hookHome: home, progress });
} catch (err) {
  io.err(`replay-staged: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  nodeFs.rmSync(root, { recursive: true, force: true });
}
process.exit(code);
