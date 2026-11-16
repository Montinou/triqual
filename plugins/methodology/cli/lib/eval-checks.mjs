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
// A question that ends right there, and where a Spanish chase may start: the message or a sentence, or after a filler.
const Q_END = '\\s*\\?+\\s*$';
// "todavia" and "still" end a bare question ("esto esta tan lento todavia?"); they are not durations.
const STILL = '(?: (?:todavia|aun|still))?';
const START = '(?:^|[.?!,]\\s+|\\b(?:y|pero|entonces|ok|oye|dime|decime|avisame)\\s+)';
// Some phrases fit the work in progress and the product alike ("va lento", "sigue corriendo el cron?", "cuantas
// tareas de Jira quedan"). Those sit in AMBIGUOUS and count only when the same message names the work: a duration or a
// work noun. A bare question with no noun ("cuanto falta?") or one about us or you ("vamos lento") needs neither.
// A duration counts when it is about the wait; "tarda 2 minutos" or "en 3 horas" describes the product. A work noun
// counts when it is the work in progress; "la pagina de tareas" and "el plan gratuito" are product entities.
const DURATION = /\b(?:\d+|un|una|media|par de|varias|muchas) (?:mins?|minutos?|minutes?|horas?|hs|hrs?|hours?|dias?|days?)\b|\bhace (?:rato|un monton)\b/g;
const PRODUCT_DURATION = /\b(?:tarda|tardan|tardo|demora|demoran|demoro|takes|took|en|in)(?: (?:unos|unas|about|como))? $/;
const WNOUN = '(?:tareas|fases|pasos|etapas|tasks|steps|phases)';
const WORK_NOUN = /\b(?:tareas?|fases?|tasks?|phases?|orquestador|agentes?|subagentes?|agents?|orchestrator)\b/g;
const PRODUCT_NOUN = /\b(?:de|del|of) $/;
const countsIn = (re, skip, t) => [...t.matchAll(re)].some((m) => !skip.test(t.slice(0, m.index)));
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
  /\bcuanto (?:mas (?:va a )?(?:tardar|demorar|tarda|demora)|tiempo (?:mas|falta))\b/, /\bcuanto (?:va a )?(?:tardar|demorar)\b/,
  /\bpor que (?:tarda|demora|esta tardando|esta demorando|es tan lent|esta tan lent)/,
  /\b(?:vas|estas) (?:esta |va |es )?tan lent[oa]\b/, new RegExp(`^(?:esto|eso|ello|todo) (?:esta |va |es )?tan lent[oa]${STILL}${BARE_END}`), /\b(?:(?:esto|eso|ello|todo) (?:tarda|demora)|(?:tardas|demoras)) (?:mucho|tanto)\b/,
  new RegExp(`\\bque esta pasando(?:${BARE_END}| con (?:esto|eso|ello)${BARE_END})`), new RegExp(`${START}(?:hay (?:algun |alguna )?|alguna |algun )(?:avances?|novedades?|novedad|progreso)(?: (?:en|con|de) (?:${WORK}|eso|esto|ello|la tarea|el trabajo))?${BARE_END}`),
  // Still going or halted, how much is left, the pace, and the bare "y?" nudge. Each is a stand-alone question, or its
  // subject is us, you or the work in progress: "se freno en el checkout" and "va lenta la app" are about the product.
  // Text may follow the question: a real chase often adds how long it has been.
  new RegExp(`${START}sigue (?:funcionando|trabajando|corriendo|andando|avanzando|ejecutando)(?: (?:eso|esto|ello|todo|ahi))?${Q_END}`),
  new RegExp(`${START}sigue (?:corriendo|ejecutando|trabajando|avanzando|andando)(?: (?:eso|esto|ello|todo|ahi))?\\s*\\?`),
  new RegExp(`${START}sigue la ejecucion${Q_END}`),
  new RegExp(`\\bsigue o se freno${Q_END}`), new RegExp(`${START}(?:ya )?se freno(?: (?:eso|esto|ello|todo))?${Q_END}`),
  new RegExp(`${START}(?:cuanto|que tanto) (?:mas )?(?:(?:le|nos|te|me) )?(?:falta|queda)(?:\\s*\\?|${BARE_END}| para (?:terminar|acabar|finalizar)(?: (?:esto|eso|todo))?${BARE_END})`),
  new RegExp(`${START}cuant[oa]s (?:(?:nos|te|me) )?(?:faltan|quedan)(?:${BARE_END}| (?:todavia|aun)${BARE_END})`),
  // The counted noun must be work: "cuantas tareas de Jira quedan" and "cuantos usuarios faltan" are about the product.
  new RegExp(`\\bcuant[oa]s ${WNOUN}(?: (?:y|o|e) ${WNOUN}){0,2}(?: (?!(?:le|les|de|del|en|para|con|a|al)\\b)\\w+){0,2} (?:faltan|quedan)\\b`),
  // "va lento": about us or you ("vamos lento"), or the whole message ("va muy lento?"); with another subject see AMBIGUOUS.
  new RegExp(`\\b(?:vas|vamos|andas|andamos) (?:muy |tan |re |demasiado )?lent[oa]s?\\b`),
  new RegExp(`^(?:y )?(?:por que )?(?:(?:todo|esto) )?(?:va|van|anda|andan) (?:muy |tan |re |demasiado )?lent[oa]s?${STILL}${BARE_END}`),
  new RegExp(`\\blo lent[oa]s? que (?:va|van|vamos|vas|anda|andan)${BARE_END}`),
  /\b(?:cuanto|que tanto) (?:ha|han|has|hemos) avanzado\b/, /\bdemasiado (?:el )?tiempo que (?:tarda|demora|lleva)\b/,
  new RegExp(`^y\\s*\\?+(?:[?!]*\\s*$|\\s*(?:como vamos|como va|sigue|seguis|que paso|que pasa|falta|terminaste)\\b)`),
  new RegExp(`\\b(?:something|anything) is stuck\\s*\\?`), new RegExp(`\\bis (?:something|anything) stuck${Q_END}`),
  new RegExp(`\\b(?:is (?:it|this)|are (?:you|we)) (?:still )?(?:progressing|making progress)(?: on ${WORK})?(?=\\s*(?:[?!.,]|$))`),
  new RegExp(`\\bi(?:['’ ]?ve| have|['’ ]?m| am) (?:been )?waiting (?:forever|for ages)\\b`),
];
const AMBIGUOUS = [
  new RegExp(`${START}sigue (?:corriendo|ejecutando)[^.?!]{0,30}\\?`),
  /\b(?:va|van|anda|andan) (?:muy |tan |re |demasiado |super )?lent[oa]s?\b/,
  /\b(?:esto|eso|ello|todo) (?:esta |va |es )?tan lent[oa]\b/,
];
const isChase = (t) => CHASE.some((re) => re.test(t)) || (AMBIGUOUS.some((re) => re.test(t)) && (countsIn(DURATION, PRODUCT_DURATION, t) || countsIn(WORK_NOUN, PRODUCT_NOUN, t)));
const plain = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// owner-chased-progress: "fail" when at least one owner message chases progress.
const ownerChasedProgress = (_signals, transcriptPath) => {
  const chased = ownerMessages(records(transcriptPath)).some((m) => isChase(plain(m)));
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
