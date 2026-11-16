import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, TranscriptMissing, runCheck } from '../cli/lib/eval-checks.mjs';
import { loadJudgePrompt } from '../cli/lib/eval-judge.mjs';

const SRC = new URL('../cli/lib/eval-checks.mjs', import.meta.url);
const FIXTURES = fileURLToPath(new URL('./fixtures/eval-checks/', import.meta.url));
const JUDGES = fileURLToPath(new URL('../evals/judges/', import.meta.url));

test("runCheck returns the check's verdict", () => {
  const checks = {
    a: (signals) => (signals.n > 1 ? 'pass' : 'fail'),
    b: (_signals, transcriptPath) => (transcriptPath === '/t.jsonl' ? 'pass' : 'fail'),
  };
  assert.equal(runCheck('a', { n: 2 }, '/t.jsonl', checks), 'pass');
  assert.equal(runCheck('a', { n: 0 }, '/t.jsonl', checks), 'fail');
  assert.equal(runCheck('b', {}, '/t.jsonl', checks), 'pass');
});

test('an unknown id throws', () => {
  assert.throws(() => runCheck('nope', {}, '/t.jsonl', {}), /nope/);
  assert.throws(() => runCheck('toString', {}, '/t.jsonl', {}), /toString/);
  assert.deepEqual(Object.keys(CHECKS), ['owner-chased-progress']);
});

test('a missing transcript gives undecided', () => {
  const checks = { a: () => { throw new TranscriptMissing('/gone.jsonl'); } };
  assert.equal(runCheck('a', {}, '/gone.jsonl', checks), 'undecided');
});

test('other errors from a check propagate', () => {
  const checks = { a: () => { throw new Error('boom'); } };
  assert.throws(() => runCheck('a', {}, '/t.jsonl', checks), /boom/);
});

test('the module imports only node: built-ins', () => {
  const lines = readFileSync(SRC, 'utf8').split('\n')
    .filter((l) => /^\s*(import\b|export\b[^\n]*\bfrom\b)/.test(l) || /\brequire\(|\bimport\(/.test(l));
  for (const l of lines) assert.match(l, /from\s+['"]node:[a-z/_]+['"]/, `non-builtin import: ${l}`);
});

// ---- the checks of the owner's taxonomy (one per `code` category) ----

for (const id of Object.keys(CHECKS)) {
  test(`${id} fails its failing fixture`, () => {
    assert.equal(runCheck(id, {}, `${FIXTURES}${id}.fail.jsonl`), 'fail');
  });
  test(`${id} passes its passing fixture`, () => {
    assert.equal(runCheck(id, {}, `${FIXTURES}${id}.pass.jsonl`), 'pass');
  });
}

test('owner-chased-progress also fails a Spanish chase message', () => {
  assert.equal(runCheck('owner-chased-progress', {}, `${FIXTURES}owner-chased-progress.fail-es.jsonl`), 'fail');
});

// Each genuine chase, alone as the owner's only message, fails; invented phrasing, English and Spanish.
const CHASES = [
  'Is anything happening?', 'Is it still working?', 'Are you still running?', 'Is this stuck?', 'Any progress?',
  'Any update on the task?', 'How much longer?', 'How much longer will it take?', 'How much more time do you need?',
  'How long will it take?', 'Why is it so slow?', 'Why is this taking so long?', 'This is taking too long.',
  "What's going on?", "What's going on with it?", "What's taking so long?",
  'Pasa algo?', 'Sigues ahi?', 'Cuanto falta?', 'Por que tarda tanto?', 'Esto tarda mucho.', 'Esto esta tan lento.',
  'Que esta pasando?', 'Hay novedades?', 'Alguna novedad?',
  'Sigue funcionando?', 'Sigue corriendo eso?', 'Sigue la ejecucion?', 'Sigue o se freno?', 'Cuanto le falta?',
  'Cuanto mas falta para terminar?', 'Que tanto falta?', 'Cuantas tareas faltan?', 'Cuantas tareas nos faltan todavia?',
  'Por que vamos tan lento?', 'Va muy lento.', 'Lo lento que van...', 'Que tanto han avanzado?',
  'No es demasiado el tiempo que tarda cada paso?', 'Y?', 'y?????', 'Y? sigue con eso?',
  'Could it be that something is stuck?', 'Is it still progressing?', 'Are we making progress?',
  'I have been waiting forever.',
  // the same phrases as stand-alone questions, with a filler or a different verb
  'Y cuanto falta?', 'Cuanto queda?', 'Cuanto me queda para terminar?', 'Sigue trabajando?', 'Sigue avanzando eso?', 'Y sigue funcionando?',
  'Ya se freno?', 'Se freno todo?', 'Cuantos pasos faltan todavia?', 'Dime cuanto falta.', 'Hay algun avance?', 'Hay avances con esto?',
  'Vamos muy lento.', 'Por que va tan lento?', 'Anda lento?', 'Lo lenta que vamos!', 'Is something stuck?', 'Are you making progress?',
  'Is it making progress on the job?', "I've been waiting for ages.", 'I am waiting forever for you.', 'Y?!',
  // the shapes real chases take: more text after the question, a longer sentence around the phrase
  'sigue corriendo eso? 50 minutos?', 'Sigue ejecutando? ya van 40 minutos', 'Y sigue avanzando? no veo cambios',
  'could it be that something is stuck? or is it still progressing? it has been over an hour on this phase',
  'Is this making progress? Nothing changed in ten minutes.', 'Are you still progressing? it has been an hour',
  'todavia por la tarea 15, que va lento, 3 horas lleva', 'Va lento, 3 horas con esto.', 'Vamos lento, no?',
  'esto va lento, llevamos 3 horas', 'deploy it now, I ve been waiting forever', "Ive been waiting forever, any news?",
  "I'm waiting forever here", 'I have been waiting for ages on this phase.',
  'y? como vamos?', 'Y? que paso?', 'y? terminaste', 'Y? sigue?', 'y? falta mucho?',
  'cuanto falta? estas hace un monton ya con esto', 'Cuanto queda? llevas horas.', 'Y cuanto le falta? ya paso mucho tiempo',
  'Cuantas tareas y fases faltan ahora?', 'Cuántas tareas y fases faltan ahora?', 'Cuantos pasos quedan en esta etapa?',
  'Cuantas tasks faltan?',
  'Cuantas fases y tareas son y faltan?',
  // round 4: an ambiguous phrase tied to the work by a duration or a work noun, and the bare forms
  // round 5: a real duration or work noun, and bare questions that end with "todavia"
  'Va lento todavia?', 'Esto va tan lento aun?', 'Esto va lento, ya van 3 horas', 'Va lento, llevo 2 horas esperando.',
  'La fase 3 va lenta, hace rato que no avanza', 'El agente anda lento, ya paso una hora?',
  'Va lento el subagente, ya paso una hora', 'El agente anda lento hace rato', 'Sigue ejecutando el orquestador? se ve quieto',
  'Sigue corriendo la tarea 4? llevo media hora', 'Cuantas faltan?', 'Cuantas quedan todavia?', 'Cuantas etapas nos quedan?',
  'Cuantos steps y phases faltan?', 'Por que anda lento?', 'Esto esta tan lento todavia?', 'Todavia va lento, 2 horas ya.',
  'sigue corriendo el coso ese? 50 minutos?', 'sigue ejecutando la fase 2?', 'Sigue corriendo todo ese proceso? ya paso una hora',
  'Y sigue ejecutando el agente, no?', 'Cuantas tareas y fases eh faltan ahora?', 'Cuantos pasos y etapas che nos faltan?',
];
// Ordinary talk that shares words with a chase passes.
const ORDINARY = [
  'The query is too slow, add an index.', 'How long should the retry wait?', 'Reject any update that fails validation.',
  'Sigue con el plan.', 'Y despues corre los tests.', 'Y si usamos otra tabla?', 'Faltan los tests del modulo nuevo.',
  'El servidor va a quedar lento con ese indice?', 'Cuantas filas tiene la tabla?', 'Waiting on the review is fine.',
  'The job got stuck in the old queue design, so we replaced it.',
  // about the product, the users or the data, not the work in progress
  'La pagina va muy lenta en mobile, optimizala.', 'El sitio anda lento con ese cambio.', 'La app va lenta en Safari.',
  'Verifica que sigue funcionando el endpoint viejo.', 'Sigue funcionando el login despues del cambio?',
  'Sigue trabajando con la rama main.', 'Sigue avanzando con la tarea 3.',
  'Si el usuario se freno en el checkout, mostra un aviso.', 'El auto se freno de golpe en la animacion, arreglalo.',
  'Cuanto falta para el limite de rate en la API?', 'Cuanto le falta al cliente para pagar? calcula el saldo.',
  'Cuantos campos le faltan al formulario?', 'Cuantas migraciones faltan aplicar en prod?',
  'Y? que opinas del diseño?', 'y? es mejor la opcion A o la B?',
  'Are we making progress on the roadmap this quarter?',
  'Users complain they have been waiting forever for the page to load.',
  'Check if something is stuck in the queue.',
  'Hay avances en el ticket de Jira del cliente?',
  // invented look-alikes of each tightened pattern
  'El endpoint va lento cuando hay muchos usuarios.', 'Las queries andan lentas en el reporte.', 'Mi compu va lenta hoy.',
  'Sigue funcionando el cron nocturno?', 'Sigue corriendo el servicio en el servidor viejo?', 'Sigue avanzando con el refactor.',
  'Revisa si el worker se freno por falta de memoria.', 'Se freno el pago en la pantalla de checkout?',
  'Cuanto queda de saldo en la cuenta?', 'Cuanto falta para el release de produccion?', 'Calcula cuanto falta de stock.',
  'Cuantos usuarios faltan por migrar?', 'Cuantas tablas le faltan a este esquema?',
  'Hay novedades en el changelog de la libreria?', 'Hay avances en el roadmap del producto?', 'Y? cual prefieres, azul o verde?',
  'Is something stuck in the dead letter queue?', 'Anything is stuck behind the load balancer.',
  'Are we making progress against the competitor this year?', 'Is it progressing toward the quarterly goal?',
  'Customers have been waiting forever for a refund.', 'The build page has been waiting forever for the CDN.',
  // round 4: ambiguous phrases about the product, with no duration, work noun or assistant as the subject
  'Por que va tan lento el endpoint de busqueda?', 'Por que anda lento el login?', 'Esto va lento en Safari, revisalo.',
  'Siento que va lento desde el ultimo deploy.', 'Noto que anda lento desde que agregamos el indice.',
  'El dashboard carga, pero va lento.', 'Revisa el endpoint de usuarios, va lento.',
  'Creo que va lento por el N+1, revisa las queries.',
  'Cuantas tareas de Jira quedan en el sprint?', 'Cuantos pasos del wizard faltan completar para el usuario?',
  'Cuantas migraciones faltan?', 'Cuantos usuarios faltan?', 'Sigue corriendo el cron nocturno?',
  // round 5: "todavia" is not a duration, a duration can describe the product, a work noun can be a product entity
  'El endpoint todavia va lento, revisa el indice.', 'Todavia va lento el endpoint despues del cambio.', 'Va lento el login todavia?',
  'La query va lenta, tarda 2 minutos.', 'El reporte anda lento, tarda 10 minutos en generarse.',
  'La app anda lenta en el plan gratuito.', 'La pagina de tareas va muy lenta.', 'El listado de tasks anda lento con muchos items.',
  // round 5 look-alikes: a duration of the product, a work noun inside a product entity
  'La query va lenta, demora unos 5 minutos.', 'El export anda lento, tarda como 2 horas en terminar.', 'The report anda lento, takes 3 minutes.',
  'La pagina de agentes va lenta.', 'El panel del orquestador anda lento.', 'Va lento el endpoint del plan premium.',
  'El listado de fases anda lento en mobile.', 'Todavia anda lento el endpoint de login?',
  // round 4 look-alikes: the same words, no duration or work noun, or another noun counted
  'La query va lenta con 3 joins.', 'El login anda lento en Safari.', 'Va lento con un monton de usuarios.',
  'Cuantos endpoints faltan documentar?', 'Cuantas pruebas de carga faltan para el cliente?', 'Cuantos clientes quedan por migrar?',
  'Sigue corriendo el job de reportes?', 'Sigue ejecutando el script de seed?', 'Esto va tan lento en el emulador de Android.',
  'Cuantas tareas de limpieza quedan en el backlog del producto?',
  // look-alikes of the shapes widened in round 2
  'Verifica que sigue corriendo el cron viejo?', 'Sigue ejecutando los tests con el flag nuevo? usa node 22.',
  'Cuantas tareas les faltan a los clientes nuevos?',
  'Cuantos pasos le faltan al usuario en el checkout?', 'Cuantas tareas le quedan al equipo de soporte este mes?',
  'Va lento el endpoint de busqueda.', 'Dime si va lento en mobile.', 'Confirma que va lento con el filtro activo.',
  'Sigue corriendo el servicio en prod? revisa los logs.', 'Sigue funcionando? el login es lo que importa.' ,
  "The users said they've been waiting forever for the export.", 'Is it progressing toward the migration target?',
  'Cuanto falta para el limite de uso? avisame si pasa de 80.', 'Check if something is stuck in the queue? use the admin page.',
];
test('owner-chased-progress fails each genuine chase on its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chase-'));
  try {
    for (const [i, text] of CHASES.entries()) {
      const file = join(dir, `${i}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
      assert.equal(runCheck('owner-chased-progress', {}, file), 'fail', text);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('owner-chased-progress passes ordinary talk that shares words with a chase', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ordinary-'));
  try {
    for (const [i, text] of ORDINARY.entries()) {
      const file = join(dir, `${i}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
      assert.equal(runCheck('owner-chased-progress', {}, file), 'pass', text);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('owner-chased-progress is undecided when the transcript is gone', () => {
  assert.equal(runCheck('owner-chased-progress', {}, `${FIXTURES}missing.jsonl`), 'undecided');
});

// ---- the judge prompts (one per `judge` category of the owner's taxonomy) ----

const JUDGE_IDS = ['broke-standing-instruction', 'unverified-claim', 'unchecked-premise', 'heavier-than-needed', 'stopped-early', 'harmful-side-effect'];

for (const id of JUDGE_IDS) {
  test(`the ${id} judge prompt loads, pins a full model and names one failure`, () => {
    const p = loadJudgePrompt(`${JUDGES}${id}.md`);
    assert.match(p.model, /^claude-/);
    assert.match(p.body, /PASS:/);
    assert.match(p.body, /FAIL:/);
    assert.match(p.body, /Critique:/);
    // invented examples only: no session id (a UUID) and no path of a real machine
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(p.body), 'names a session id');
    assert.ok(!/\/(?:Users|home)\/[a-z]/i.test(p.body.replace(/\/home\/x\//g, '')), 'names a real path');
  });
}
