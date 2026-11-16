// Code checks for session evaluators: one deterministic check per failure category. node: built-ins only,
// so a snapshot copy of this file runs alone.
import { readFileSync } from 'node:fs';

// Thrown by a check that needs the transcript when the file is gone; runCheck turns it into "undecided".
export class TranscriptMissing extends Error {
  constructor(file) {
    super(`transcript not found: ${file}`);
    this.name = 'TranscriptMissing';
    this.file = file;
  }
}

// The JSON records of a transcript; a missing file is TranscriptMissing, an unparseable line is skipped.
function records(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (err) {
    if (err?.code === 'ENOENT') throw new TranscriptMissing(file);
    throw err;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line is not a record */ }
  }
  return out;
}

// The harness writes into the owner's turn: system reminders, task notifications, command echoes, hook feedback, the
// summary that opens a continued session. None of it is the owner's message. A record the harness flags (isMeta,
// isSidechain, isCompactSummary) is dropped whole; tagged blocks are cut out of the text; a message that is only a
// known harness line is dropped.
const INJECTED_TAGS = /<(system-reminder|task-notification|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)\b[^>]*>[\s\S]*?<\/\1>/g;
const INJECTED_LINES = /^\s*(?:Caveat: The messages below were generated|\[Request interrupted|This session is being continued|Stop hook feedback)/;

// The owner's typed messages, in order. A message with tool results is the harness returning a tool's output.
export function ownerMessages(recs) {
  const out = [];
  for (const rec of recs) {
    if (rec === null || typeof rec !== 'object' || rec.type !== 'user') continue;
    if (rec.isMeta === true || rec.isSidechain === true || rec.isCompactSummary === true) continue;
    const c = rec.message?.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c) && !c.some((b) => b?.type === 'tool_result')) {
      text = c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    }
    text = text.replace(INJECTED_TAGS, ' ').trim();
    if (text !== '' && !INJECTED_LINES.test(text)) out.push(text);
  }
  return out;
}

// Phrases that ask whether anything is happening, how much longer it will take, or why it is slow, in English and
// Spanish. Matched on lowercase text without accents. The question must be about the work in progress: the subject
// is it, this, that, you or the task/job, or the phrase stands alone as the question. So "the query is too slow",
// "reject any update that ...", "how long should the retry wait" and "what's going on with this stack trace" are
// ordinary talk, not chasing.
const WORK = '(?:it|this|that|the (?:whole )?(?:thing|task|job|process|run|build))';
const BARE_END = '\\s*[?!.]*\\s*$';
const CHASE = [
  /\b(?:is|are) (?:anything|something) (?:happening|going on)\b/, /\banything (?:happening|going on)\b/,
  /\b(?:is (?:it|this) still|are you(?: still)?) (?:working|running|stuck|frozen|hung|doing anything|there|alive)\b/,
  /\bis (?:it|this) (?:stuck|frozen|hung|doing anything|alive)\b/,
  new RegExp(`(?:^|[.?!]\\s+)any (?:progress|updates?|news)(?: on ${WORK})?${BARE_END}`),
  new RegExp(`\\bhow much (?:longer|more time)(?:${BARE_END}|,| (?:until|before|for|to go|left|will ${WORK}|does ${WORK}|is ${WORK}|do (?:i|we|you) (?:need|have|wait))\\b)`),
  /\bhow long (?:will|is|does|until|before) (?:it|this|that|the (?:whole )?(?:thing|task|job|process|run))\b[^.?!]{0,30}\b(?:take|left|longer|more|going)\b/,
  /\bwhy (?:is|are|was) (?:it|this|that|you) (?:so |being so |taking so |taking too )?(?:slow|long)\b/,
  new RegExp(`\\b(?:${WORK}|you)(?: is| are|'s)? taking (?:so|too) long\\b`),
  new RegExp(`\\b(?:${WORK}|you)(?: is| are|'s) (?:so|too) slow\\b`),
  new RegExp(`\\bwhat(?:'s| is) (?:happening|going on)(?:${BARE_END}| (?:with|on) ${WORK}${BARE_END})`), /\bwhat(?:'s| is) taking so long\b/,
  /\bpasa algo\b/, /\besta pasando algo\b/, /\b(?:sigues|estas) (?:ahi|funcionando|corriendo|trabajando|vivo)\b/, /\bsigue (?:ahi|vivo)\b/,
  /\besta (?:colgado|trabado)\b/, /\b(?:todavia|aun) esta (?:funcionando|trabajando)\b/, /\bse (?:colgo|trabo|quedo (?:pegado|colgado|trabado))\b/,
  /\bcuanto (?:falta|queda|mas (?:va a )?(?:tardar|demorar|tarda|demora)|tiempo (?:mas|falta))\b/, /\bcuanto (?:va a )?(?:tardar|demorar)\b/,
  /\bpor que (?:tarda|demora|esta tardando|esta demorando|es tan lent|esta tan lent)/,
  /\b(?:esto|eso|ello|todo|va|vas|estas) (?:esta |va |es )?tan lent[oa]\b/, /\b(?:(?:esto|eso|ello|todo) (?:tarda|demora)|(?:tardas|demoras)) (?:mucho|tanto)\b/,
  new RegExp(`\\bque esta pasando(?:${BARE_END}| con (?:esto|eso|ello)${BARE_END})`), /\b(?:hay|alguna) (?:avances?|novedades?|novedad|progreso)\b/,
];
const plain = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// owner-chased-progress: "fail" when at least one owner message chases progress.
const ownerChasedProgress = (_signals, transcriptPath) => {
  const chased = ownerMessages(records(transcriptPath)).some((m) => CHASE.some((re) => re.test(plain(m))));
  return chased ? 'fail' : 'pass';
};

// { [categoryId]: (signals, transcriptPath) => "pass" | "fail" }, one per `code` category of the taxonomy.
export const CHECKS = { 'owner-chased-progress': ownerChasedProgress };

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
