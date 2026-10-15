// The setup skill (public-export plan T6): frontmatter, the commands it names, step order and the question budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDENTITY_NOTE } from '../cli/memory.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(join(root, 'skills', 'setup', 'SKILL.md'), 'utf8');
const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
const front = match ? match[1] : '';
const body = match ? match[2] : '';

test('frontmatter names the skill setup and says how to ask for it', () => {
  assert.ok(match, 'SKILL.md starts with a frontmatter block');
  assert.match(front, /^name: setup$/m);
  const description = /^description: (.+)$/m.exec(front);
  assert.ok(description && description[1].trim().length > 0, 'non-empty description');
  assert.ok(description[1].includes('set up memory-report'), description[1]);
});

test('every `triqual memory <subcommand>` in the body is listed by --help', () => {
  const help = spawnSync(process.execPath, [join(root, 'cli', 'memory.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  const listed = new Set([...help.stdout.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]));
  assert.ok(listed.has('setup') && listed.has('allow'), [...listed].join(','));
  const named = new Set([...body.matchAll(/triqual memory ([a-z][a-z-]*)/g)].map((m) => m[1]));
  assert.ok(named.size > 0, 'the body names triqual memory commands');
  for (const sub of named) assert.ok(listed.has(sub), `triqual memory ${sub} is not in --help`);
});

test('the lists and the suggestion are read before setup --done', () => {
  const done = body.indexOf('setup --done');
  assert.ok(done > -1, 'setup --done is named');
  for (const needle of ['allow --list', 'never --list', 'block --list', 'setup --suggest --json']) {
    const at = body.indexOf(needle);
    assert.ok(at > -1, `${needle} is named`);
    assert.ok(at < done, `${needle} comes before setup --done`);
  }
});

test('it names the decline path and the no-terms flag', () => {
  assert.ok(body.includes('setup --decline'));
  assert.ok(body.includes('--no-client-terms'));
});

test('step 4 stops without writing on "no"; step 7 forbids adding or removing what the user did not state; step 5 mentions report --now', () => {
  const step = (n) => new RegExp(`^${n}\\. [\\s\\S]*?(?=^\\d+\\. |$(?![\\s\\S]))`, 'm').exec(body)?.[0].replace(/\s+/g, ' ') ?? '';
  assert.match(step(4), /On "no", stop without writing/);
  assert.match(step(7), /Never add or remove a project, term or flag the user did not state/);
  assert.match(step(5), /triqual memory report --now/);
  assert.match(step(5), /new settings/);
});

test('AskUserQuestion appears exactly twice', () => {
  assert.equal(raw.split('AskUserQuestion').length - 1, 2);
});

test('no absolute home path', () => {
  assert.doesNotMatch(raw, /\/Users\/|\/home\//);
});

test('--help lists triqual memory repos', () => {
  const help = spawnSync(process.execPath, [join(root, 'cli', 'memory.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^ {2}repos \[--json\] /m);
});

// Repo-identity (spec 5.3): owners come first, candidates are filtered by them, merges are shown and never run, the
// three entry kinds are named, counts come from the JSON, and step 5 says what the first report after 0.2.0 does.
const flat = body.replace(/\s+/g, ' ');
const section = (from, to) => flat.slice(flat.indexOf(from), to === undefined ? undefined : flat.indexOf(to));
const stepText = (n) => new RegExp(`^${n}\\. [\\s\\S]*?(?=^\\d+\\. |$(?![\\s\\S]))`, 'm').exec(body)?.[0].replace(/\s+/g, ' ') ?? '';

test('owners come before candidates: step 2a reads owners, step 2b reads candidates', () => {
  const a = body.indexOf('2a');
  const b = body.indexOf('2b');
  assert.ok(a > -1 && b > a, '2a comes before 2b');
  const twoA = body.slice(a, b);
  assert.ok(twoA.includes('`owners`'), '2a reads owners');
  assert.doesNotMatch(twoA, /candidates/, '2a does not read candidates');
  assert.ok(body.slice(b).includes('`candidates`'), '2b reads candidates');
});

test('2a asks which owners to allow or never send, never as question options, and states the count of listed candidates', () => {
  const twoA = section('2a', '2b');
  assert.match(twoA, /which owners to \*\*allow\*\*/);
  assert.match(twoA, /never as question options/);
  assert.match(twoA, /An owner entry covers that owner's future repositories too/);
  assert.match(twoA, /`repos\.unambiguous` of the projects listed below/);
  assert.doesNotMatch(twoA, /withCwd/);
  assert.match(twoA, /not covered by an owner entry/);
  assert.match(twoA, /can still be allowed by name/);
});
test('2b leaves out the candidates whose owner the user chose in 2a', () => {
  const twoB = section('2b', ' 3. ');
  assert.match(twoB, /Leave out any candidate whose `owner` the user chose in 2a to allow or never send/);
});

test('merges are shown after 2b as information only, and the setup never runs them', () => {
  const merges = flat.indexOf('When `merges` is not empty');
  assert.ok(merges > flat.indexOf('2b') && merges < flat.indexOf(' 3. '), 'merges sit inside 2b');
  assert.match(flat, /`merges` is not empty, show them[^.]*as information only/);
  assert.match(flat, /The setup never runs them\./);
  assert.match(flat, /claude-mem's merge has no undo/);
});

test('step 4 lists names, repositories and owners for the allowlist and for never-send', () => {
  const s4 = stepText(4);
  for (const word of ['names', 'repositories', 'owners', 'allowlist', 'never-send list', 'github.com/acme/app', 'github.com/acme/*']) {
    assert.ok(s4.includes(word), word);
  }
});

test('the entry kinds and the URL normalization are named in the skill', () => {
  assert.ok(body.includes('github.com/acme/app') && body.includes('github.com/acme/*'));
  assert.ok(flat.includes('https://github.com/Acme/App.git'), 'the example URL');
  assert.match(flat, /A pasted URL is normalized before it is stored/);
});
test('step 5 gives the real cause: the newly created map reads as rebuilt until a report succeeds', () => {
  const s5 = stepText(5);
  assert.match(s5, /upgrade from 0\.2\.0/);
  assert.match(s5, /the first report may run with insights off when never-send has repository or owner entries/);
  assert.match(s5, /the newly created map reads as rebuilt until a report succeeds/);
  assert.doesNotMatch(s5, /does not exist/);
  assert.match(s5, /the next successful report sends normally/i);
});

test('step 5 says that until a report succeeds the insights allow by name only', () => {
  const s5 = stepText(5);
  assert.match(s5, /until a report succeeds, the insights allow by name only/i);
  assert.match(s5, /a project allowed just by repository or owner is not sent in that report/);
});
test('the skill quotes the identity note the code prints', () => {
  const head = IDENTITY_NOTE.split(':')[0];
  const quoted = `${head.charAt(0).toLowerCase()}${head.slice(1)}`;
  assert.ok(flat.includes(`note "${quoted}"`), quoted);
});

test('--help names entries, not projects, for allow, deny, never and unnever, and gives the three kinds', () => {
  const help = spawnSync(process.execPath, [join(root, 'cli', 'memory.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  for (const line of ['allow <entry>...', 'deny <entry>...', 'never <entry>...', 'unnever <entry>...']) {
    assert.ok(help.stdout.includes(line), line);
  }
  assert.doesNotMatch(help.stdout, /<project>/);
  assert.match(help.stdout, /a name \(acme\), a repository \(host\/owner\/name\) or an owner \(host\/owner\/\*\)/);
});
