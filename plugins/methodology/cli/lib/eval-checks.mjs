// Code checks for session evaluators: one deterministic check per failure category. node: built-ins only,
// so a snapshot copy of this file runs alone.

// Thrown by a check that needs the transcript when the file is gone; runCheck turns it into "undecided".
export class TranscriptMissing extends Error {
  constructor(file) {
    super(`transcript not found: ${file}`);
    this.name = 'TranscriptMissing';
    this.file = file;
  }
}

// { [categoryId]: (signals, transcriptPath) => "pass" | "fail" }. Filled by the category checks.
export const CHECKS = {};

// The verdict of one check: "pass", "fail", or "undecided" when the transcript it needs is gone.
export function runCheck(id, signals, transcriptPath, checks = CHECKS) {
  if (!Object.hasOwn(checks, id)) throw new Error(`unknown check: ${id}`);
  try {
    return checks[id](signals, transcriptPath);
  } catch (err) {
    if (err instanceof TranscriptMissing) return 'undecided';
    throw err;
  }
}
