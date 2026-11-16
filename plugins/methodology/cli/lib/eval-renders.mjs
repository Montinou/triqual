// The kept renders of the evals: the redacted text a judge reads for each review-sample session, saved under
// <evals>/review/renders/<sessionId>.txt (mode 0600, the directory 0700) so a labeled session can still be judged after the
// host deletes its transcript. keepRenders is the only writer (and remover); every reader goes through sessionRender, which never writes.
// A kept render is private session text: it is never printed or logged here. node: built-ins only.
import { chmodSync, closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderForJudge } from './eval-judge.mjs';
import { ensureDir } from './eval-paths.mjs';

// The session id rule of the evals commands (a file name, never a path); `..` is refused as well.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// <evals>/review/renders/<sessionId>.txt. Throws for an id that is not a plain file name.
export function renderPath(evals, sessionId) {
  if (typeof sessionId !== 'string' || !ID.test(sessionId) || sessionId.includes('..')) throw new Error('renders: the session id is not a plain file name');
  return join(evals, 'review', 'renders', `${sessionId}.txt`);
}

// Whether the transcript `file` can be read as a file (an absent or unreadable one cannot): the tell between "nothing to
// judge" (readable, renders empty) and "a transcript that is gone" (a real problem).
export function transcriptReadable(file) {
  if (typeof file !== 'string') return false;
  try {
    if (!statSync(file).isFile()) return false;
    closeSync(openSync(file, 'r'));
    return true;
  } catch { return false; }
}

// A transcript untouched for this long is taken as no longer running: a session whose file changed within it may still be
// open, so its render (and a label proposed from it) would freeze a partial text.
export const QUIET_MS = 60 * 60 * 1000;

// Whether the transcript `file` is readable and its last modification is at least QUIET_MS before `now` (ms since the
// epoch, a Date, or a function returning either).
export function transcriptQuiet(file, now = Date.now) {
  if (!transcriptReadable(file)) return false;
  const at = Number(typeof now === 'function' ? now() : now);
  try { return statSync(file).mtimeMs <= at - QUIET_MS; } catch { return false; }
}

// The kept text of `path`, or null when there is none, it cannot be read, or it is blank (a torn write counts as absent).
function readKept(path) {
  try {
    const text = readFileSync(path, 'utf8');
    return text.trim() === '' ? null : text;
  } catch { return null; }
}

// The text to judge for `session` ({ sessionId, file }): its kept render when there is one, else the render of its
// transcript (empty for an unreadable or absent file). Never writes; an id that is not a plain file name has no kept render.
export function sessionRender(evals, session) {
  let kept = null;
  try { kept = readKept(renderPath(evals, session.sessionId)); } catch { /* no kept render for an id that is not a file name */ }
  if (kept !== null) return kept;
  return session.file === null || session.file === undefined ? '' : renderForJudge(session.file);
}

// Keeps the render of each of `sessions` ({ sessionId, file, excluded }) that is not excluded and has none yet.
// { kept, empty, unreadable, failed }: renders written; sessions whose transcript reads but renders no text (nothing is
// written); sessions whose transcript is unreadable or absent; sessions whose render could not be written or removed (one
// session's failure never stops the others; an id that is not a plain file name counts here). A session that already has a
// kept render counts in none, and neither does one whose transcript is not quiet (see QUIET_MS; `now` is ms, a Date or a
// function): it is kept by a later round. The kept render of an excluded session is removed (an excluded session with an
// invalid id is skipped). The write goes through a temp file and a rename (file 0600, directory 0700).
export function keepRenders({ evals, sessions, now = Date.now }) {
  const at = Number(typeof now === 'function' ? now() : now);
  let kept = 0;
  let empty = 0;
  let unreadable = 0;
  let failed = 0;
  for (const s of sessions) {
    if (s.excluded === true) {
      let path;
      try { path = renderPath(evals, s.sessionId); } catch { continue; }
      try { rmSync(path, { force: true }); } catch { failed += 1; }
      continue;
    }
    let path;
    try { path = renderPath(evals, s.sessionId); } catch { failed += 1; continue; }
    if (readKept(path) !== null) continue;
    if (!transcriptReadable(s.file)) { unreadable += 1; continue; }
    if (!transcriptQuiet(s.file, at)) continue;
    const text = renderForJudge(s.file);
    if (text.trim() === '') { empty += 1; continue; }
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      ensureDir(dirname(path));
      chmodSync(dirname(path), 0o700);
      writeFileSync(tmp, text, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
      kept += 1;
    } catch {
      rmSync(tmp, { force: true });
      failed += 1;
    }
  }
  return { kept, empty, unreadable, failed };
}
