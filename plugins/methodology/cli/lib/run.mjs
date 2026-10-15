// The run that doctor and triqual sync hand to their checks and steps: one command, no shell, a timeout. node: built-ins
// only.
import { spawn } from 'node:child_process';

// The CLI's run: spawns without a shell (in `cwd` when given) and resolves { code, stdout, stderr }. A spawn error
// (ENOENT) is code 127; a run past timeoutMs is killed and resolves code 124 at once, even while a grandchild still
// holds the pipes.
export function realRun(cmd, args, { timeoutMs, cwd }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      // 'close' waits for every holder of the pipes, so a grandchild would outlive the timeout: stop reading now.
      child.stdout.destroy();
      child.stderr.destroy();
      done({ code: 124, stdout, stderr });
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (err) => done({ code: 127, stdout, stderr: stderr || err.message }));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}
