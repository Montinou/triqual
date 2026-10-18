// fence detection (spec U9). Fence is a policy harness; when it is installed, methodology cooperates with it (doctor
// reports it, the Grok session context says a denied call is a stop-and-ask). When it is not, nothing changes.
// node: built-ins only.
import { spawnSync } from 'node:child_process';

const FENCE_TIMEOUT_MS = 2000;
const MAX_FIELD = 64;

// Text that reaches a terminal or a session context: control characters removed, at most MAX_FIELD characters.
const clean = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, MAX_FIELD);

// The fence on `env`'s PATH: { version, profile } when `fence version` exits 0, else null. `version` is the first line
// of what it prints without a leading `fence ` ('unknown' when it prints nothing); `profile` is env.FENCE_PROFILE or
// null. Both are stripped of control characters and cut to 64 characters, since they reach a terminal and an agent's
// context. The run takes an argument array (no shell) and is killed after `timeoutMs` (default and ceiling 2 s). Any
// failure, a missing fence, a non-zero exit, a timeout or a bad `env` included, gives null: this never throws.
export function detectFence(env = process.env, timeoutMs = FENCE_TIMEOUT_MS) {
  try {
    const r = spawnSync('fence', ['version'], {
      env, encoding: 'utf8', timeout: Math.min(FENCE_TIMEOUT_MS, timeoutMs), killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.error || r.status !== 0) return null;
    const first = String(r.stdout ?? '').split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
    const version = clean(first.replace(/^fence\s+/i, ''));
    const profile = typeof env?.FENCE_PROFILE === 'string' ? clean(env.FENCE_PROFILE) : '';
    return { version: version === '' ? 'unknown' : version, profile: profile === '' ? null : profile };
  } catch {
    return null;
  }
}
