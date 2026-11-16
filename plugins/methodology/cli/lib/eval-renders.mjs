// The kept renders of the evals: the redacted text a judge reads for each review-sample session, saved under
// <evals>/review/renders/<sessionId>.txt (mode 0600, the directory 0700) so a labeled session can still be judged after the
// host deletes its transcript. keepRenders is the only writer; every reader goes through sessionRender, which never writes.
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

// The kept text of `path`, or null when there is none or it cannot be read.
function readKept(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
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
// { kept, empty, unreadable }: renders written; sessions whose transcript reads but renders no text (nothing is written);
// sessions whose transcript is unreadable or absent. A session that already has a kept render counts in none. The write goes
// through a temp file and a rename (file 0600, directory 0700). Throws for a session id that is not a plain file name.
export function keepRenders({ evals, sessions }) {
  let kept = 0;
  let empty = 0;
  let unreadable = 0;
  for (const s of sessions) {
    if (s.excluded === true) continue;
    const path = renderPath(evals, s.sessionId);
    if (readKept(path) !== null) continue;
    if (!transcriptReadable(s.file)) { unreadable += 1; continue; }
    const text = renderForJudge(s.file);
    if (text.trim() === '') { empty += 1; continue; }
    ensureDir(dirname(path));
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, text, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    kept += 1;
  }
  return { kept, empty, unreadable };
}
