import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { redact, SECRET_PATTERNS } from '../src/log/redact.mjs';
import { UNKNOWN } from '../src/norm/unknown.mjs';
import { normalize } from '../src/norm/normalize.mjs';

const R = '[redacted]';
const filler = (ch, n) => ch.repeat(n);

// One fixture per SECRET_PATTERNS entry, in order. Every secret-shaped value is assembled from pieces, so no literal
// secret is in this file.
const FIXTURES = [
  ['an sk- key', 'sk-' + filler('a', 24)],
  ['a Google AIza key', 'AIza' + filler('b', 32)],
  ['a GitHub ghp token', 'gh' + 'p_' + filler('c', 32)],
  ['a GitHub fine-grained token', 'github' + '_pat_' + filler('d', 24)],
  ['a Slack token', 'xo' + 'xb-' + filler('1', 12)],
  ['an AWS access key id', 'AK' + 'IA' + filler('A', 16)],
  ['a PEM block', '-----' + 'BEGIN PRIVATE KEY-----\n' + filler('e', 20) + '\n-----END PRIVATE KEY-----'],
  ['a Bearer token', 'Bea' + 'rer ' + filler('f', 30)],
  ['URL credentials', 'https:' + '//deploy:' + filler('g', 8) + '@host.example'],
  ['a key=value secret', 'pass' + 'word=' + filler('h', 14)],
  ['a vck key', 'vck' + '_' + filler('i', 24)],
  ['a JWT', 'ey' + 'J' + filler('j', 24) + '.' + filler('k', 24)],
  ['a Stripe key', 'sk' + '_live_' + filler('l', 20)],
];

test('the fixtures cover every SECRET_PATTERNS entry', () => {
  assert.equal(SECRET_PATTERNS.length, 13);
  assert.equal(FIXTURES.length, SECRET_PATTERNS.length);
  FIXTURES.forEach(([name, value], i) => assert.ok(SECRET_PATTERNS[i].test(value), `${name} matches pattern ${i}`));
});

// A URL whose password is already redacted still has the shape pattern 9 looks for; that form is the output.
const anyPattern = (text) => SECRET_PATTERNS.some((p) => p.test(text.replace(/:\/\/[^/\s:@]+:\[redacted\]@/g, '')));

FIXTURES.forEach(([name, value]) => {
  test(`redacts ${name}`, () => {
    const out = redact({ note: `before ${value} after`, nested: { list: [`x ${value}`] } });
    for (const text of [out.note, out.nested.list[0]]) {
      assert.ok(text.includes(R), text);
      assert.ok(!text.includes(value), text);
      assert.equal(anyPattern(text), false, `a pattern still matches: ${text}`);
    }
    assert.ok(out.note.startsWith('before '));
  });
});

test('inline env values are always redacted', () => {
  const out = redact({
    raw: 'FOO=plain-value BAR="two words" API_HOST=x.example make build && BAZ=1 run',
    call: { commands: [{ argv: ['make', 'build'], env: { FOO: 'plain-value', BAR: UNKNOWN, N: 7 } }] },
  });
  assert.equal(out.raw, `FOO=${R} BAR=${R} API_HOST=${R} make build && BAZ=${R} run`);
  assert.deepEqual(out.call.commands[0].env, { FOO: R, BAR: UNKNOWN, N: 7 });
  assert.equal(out.call.commands[0].env.BAR, UNKNOWN);
  assert.equal(redact({ raw: 'export TOKEN_X=abc123 && echo ok' }).raw, `export TOKEN_X=${R} && echo ok`);
});

test('-H Authorization: Bearer … value redacted', () => {
  const secret = 'Bea' + 'rer ' + filler('z', 10);
  const out = redact({
    raw: `curl -H "Authorization: ${secret}" -H 'Cookie: sid=abc; t=9' -H "X-Api-Key: k1" --header "authorization: ${secret}" -H "Accept: text/html" https://example.invalid/`,
    argv: ['curl', '-H', `Authorization: ${secret}`, '--header', 'Cookie: a=b', '-H', 'x-api-key: k9', '-H', 'Accept: text/html', '-HAuthorization: raw1', '--header=Cookie: c=d'],
  });
  assert.equal(
    out.raw,
    `curl -H "Authorization: ${R}" -H 'Cookie: ${R}' -H "X-Api-Key: ${R}" --header "authorization: ${R}" -H "Accept: text/html" https://example.invalid/`,
  );
  assert.deepEqual(out.argv, [
    'curl', '-H', `Authorization: ${R}`, '--header', `Cookie: ${R}`, '-H', `x-api-key: ${R}`, '-H', 'Accept: text/html',
    `-HAuthorization: ${R}`, `--header=Cookie: ${R}`,
  ]);
});

test('--token abc redacted', () => {
  const out = redact({
    raw: 'tool --token abc --password=hunter --secret "s p" --api-key k --verbose run',
    argv: ['tool', '--token', 'abc', '--password=hunter', '--secret', 's p', '--api-key', 'k', '--verbose', 'run'],
  });
  assert.equal(out.raw, `tool --token ${R} --password=${R} --secret ${R} --api-key ${R} --verbose run`);
  assert.deepEqual(out.argv, ['tool', '--token', R, `--password=${R}`, '--secret', R, '--api-key', R, '--verbose', 'run']);
});

test('-p<value> is redacted for mysql-style clients only', () => {
  const out = redact({
    raw: 'mysql -u root -pS3cret db; mysqldump -p"a b" x | gzip; find . -perm 644 -print; cp -p a b',
    argv: ['mysql', '-u', 'root', '-pS3cret', 'db'],
    other: { argv: ['find', '.', '-perm', '644'] },
  });
  assert.equal(out.raw, `mysql -u root -p${R} db; mysqldump -p${R} x | gzip; find . -perm 644 -print; cp -p a b`);
  assert.deepEqual(out.argv, ['mysql', '-u', 'root', `-p${R}`, 'db']);
  assert.deepEqual(out.other.argv, ['find', '.', '-perm', '644']);
});

test('user:pass@ in URLs is redacted and the rest of the URL is kept', () => {
  const url = 'https:' + '//alice:' + 'pw' + '@git.example.invalid/repo.git';
  const out = redact({ raw: `git clone ${url}`, argv: ['git', 'clone', url] });
  const redactedUrl = 'https:' + '//alice:' + R + '@git.example.invalid/repo.git';
  assert.equal(out.raw, `git clone ${redactedUrl}`);
  assert.deepEqual(out.argv, ['git', 'clone', redactedUrl]);
});

test('a PEM block is redacted through its END line', () => {
  const pem = '-----' + 'BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----';
  const out = redact({ raw: `echo "${pem}" > key.pem` });
  assert.equal(out.raw, `echo "${R}" > key.pem`);
});

test('raw field is redacted too', () => {
  const secret = 'sk-' + filler('q', 30);
  const out = redact({ decision: 'deny', raw: `API_KEY=${secret} curl --token ${secret} https://example.invalid` });
  assert.equal(out.raw.includes(secret), false);
  assert.equal(out.raw, `API_KEY=${R} curl --token ${R} https://example.invalid`);
});

test('non-secret text is untouched', () => {
  const entry = {
    ts: '2026-10-17T10:00:00.000Z',
    host: 'claude',
    tool: 'Bash',
    cwd: '/work/repo',
    raw: 'git status && make build --jobs=4 -p; ls -la /tmp ./x=y/z --out=dir',
    call: { commands: [{ argv: ['git', 'status'], env: {}, classes: ['read'], reads: ['/work/repo'], writes: [], domains: ['example.com'] }], opaque: null },
    decision: 'allow',
    latency: { total_ms: 12, engine_ms: 3 },
    flag: true,
    none: null,
  };
  const copy = structuredClone(entry);
  assert.deepEqual(redact(entry), copy);
  assert.deepEqual(entry, copy);
});

test('redact returns a new entry and leaves its input unchanged', () => {
  const input = { raw: 'FOO=bar run', call: { commands: [{ argv: ['run'], env: { FOO: 'bar' } }] } };
  const before = structuredClone(input);
  const out = redact(input);
  assert.notEqual(out, input);
  assert.deepEqual(input, before);
  assert.deepEqual(redact(out), out);
});

// ---- fix round 1 ---------------------------------------------------------------------------------

test('env assignments are redacted wherever a word starts, with any lead keyword', () => {
  const cases = [
    ['if x; then FOO=abc run; fi', `if x; then FOO=${R} run; fi`],
    ['for i in a; do FOO=abc run; done', `for i in a; do FOO=${R} run; done`],
    ['time FOO=abc run', `time FOO=${R} run`],
    ['sudo FOO=abc run', `sudo FOO=${R} run`],
    ['sudo -E env -i FOO=abc BAR=def run', `sudo -E env -i FOO=${R} BAR=${R} run`],
    ['(FOO=abc run)', `(FOO=${R} run)`],
    ['{ FOO=abc run; }', `{ FOO=${R} run; }`],
    ['! FOO=abc run', `! FOO=${R} run`],
    ['echo `FOO=abc run`', `echo \`FOO=${R} run\``],
    ['echo $(FOO=abc run)', `echo $(FOO=${R} run)`],
    ['a && FOO=abc run || BAR=def run | BAZ=1 run', `a && FOO=${R} run || BAR=${R} run | BAZ=${R} run`],
    ['PATH+=abc run', `PATH+=${R} run`],
    ['make CC=gcc build', `make CC=${R} build`],
  ];
  for (const [input, expected] of cases) assert.equal(redact({ raw: input }).raw, expected, input);
  // a flag value, a path with an equals sign and a mid-word name are not assignments
  const same = 'run --out=dir ./x=y/z a.b=c -k=v';
  assert.equal(redact({ raw: same }).raw, same);
});

test('env values honour quotes, escaped quotes and escaped spaces', () => {
  const cases = [
    ['FOO="a \\"b c\\" d" run', `FOO=${R} run`],
    ["FOO='x y' run", `FOO=${R} run`],
    ['FOO=a\\ b\\ c run', `FOO=${R} run`],
    ['FOO=pre"in side"post run', `FOO=${R} run`],
    ['FOO="unterminated value', `FOO=${R}`],
    ['FOO=a;BAR=b', `FOO=${R};BAR=${R}`],
  ];
  for (const [input, expected] of cases) assert.equal(redact({ raw: input }).raw, expected, input);
});

test('URL credentials: empty user, ":" inside the password, host and path kept', () => {
  const u = (user, pw, rest) => 'https:' + '//' + user + ':' + pw + '@' + rest;
  const out = (user, rest) => 'https:' + '//' + user + ':' + R + '@' + rest;
  const cases = [
    [u('', 'pw1', 'h.example/p'), out('', 'h.example/p')],
    [u('deploy', 'pa:ss:wd', 'h.example:8443/p?q=1'), out('deploy', 'h.example:8443/p?q=1')],
    [u('deploy', 'p@ss', 'h.example'), out('deploy', 'h.example')],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redact({ raw: `git clone ${input} dir` }).raw, `git clone ${expected} dir`, input);
    assert.deepEqual(redact({ argv: ['git', 'clone', input] }).argv, ['git', 'clone', expected], input);
  }
});

test('the header regex is linear on long runs of spaces', () => {
  const spaces = ' '.repeat(40000);
  const inputs = [`-H${spaces}`, `-H ${spaces}Authorization${spaces}`, `-H "Authorization${spaces}`, `-H=${spaces}=${spaces}x`, `--header${spaces}Cookie${spaces}:${spaces}`];
  for (const input of inputs) {
    const start = process.hrtime.bigint();
    redact({ raw: input });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 500, `${ms} ms for ${input.slice(0, 20)}`);
  }
});

test('a cyclic entry yields a marker and never throws', () => {
  const a = { argv: ['x'] };
  a.argv.push(a);
  a.self = a;
  const out = redact(a);
  assert.ok(JSON.stringify(out).includes('[redacted-depth]'));
  const b = { argv: [] };
  b.argv.push(b.argv);
  assert.ok(JSON.stringify(redact(b)).includes('[redacted-depth]'));
  const c = { list: [] };
  c.list.push(c);
  assert.ok(JSON.stringify(redact(c)).includes('[redacted-depth]'));
});

test('--secret=s p as one argv element is redacted to the end of the element', () => {
  const out = redact({ argv: ['tool', '--secret=s p', '--token=a b c', '--api-key=k'] });
  assert.deepEqual(out.argv, ['tool', `--secret=${R}`, `--token=${R}`, `--api-key=${R}`]);
});

// ---- argv secrets scrubbed from the paths the normalizer derived from them ------------------------

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fence-redact-')));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const commandsOf = (text) => {
  const r = normalize(text, { cwd: TMP, home: path.join(TMP, 'home'), env: {} });
  assert.ok(Array.isArray(r.commands), JSON.stringify(r));
  return r.commands;
};

test('argv secrets do not survive in reads, writes, ops or domains (real normalizer output)', () => {
  const secret = 'Zq9' + 'Vw3xT';
  const pw = 'Hk4' + 'Rm8nP';
  const cases = [
    `sudo mysql -p${secret} db`,
    `mysql -p${secret} < in.sql`,
    `tool --token ${secret} x`,
    `tool --token=${secret} > out.txt`,
    `tool --password ${secret} --secret=${secret}`,
    `curl -H "Authorization: Bearer ${secret}" https:` + `//u:${pw}@h.example/p`,
  ];
  for (const text of cases) {
    const commands = commandsOf(text);
    assert.ok(commands.some((c) => JSON.stringify(c).includes(secret) || JSON.stringify(c).includes(pw)), `premise: ${text}`);
    const out = redact({ call: { commands }, raw: text });
    const json = JSON.stringify(out);
    assert.equal(json.includes(secret), false, `${text} -> ${json}`);
    assert.equal(json.includes(pw), false, `${text} -> ${json}`);
    // the cwd stays readable and only the secret component of a path is replaced
    for (const c of out.call.commands) {
      assert.equal(c.cwd, TMP);
      for (const p of [...c.reads, ...c.writes]) assert.ok(p.startsWith(`${TMP}${path.sep}`), p);
    }
  }
  const out = redact({ call: { commands: commandsOf(`sudo mysql -p${secret} db`) } });
  assert.deepEqual(out.call.commands[0].argv, ['mysql', `-p${R}`, 'db']);
  assert.ok(out.call.commands[0].reads.includes(path.join(TMP, R)));
  assert.ok(out.call.commands[0].reads.includes(path.join(TMP, 'db')));
});

test('a short argv secret does not eat the redaction marker or the fields outside reads/writes/ops/domains', () => {
  const entry = { cwd: '/work/red', raw: 'run --token e', argv: ['run', '--token', 'e'], reads: ['/work/red/e/x'], writes: [] };
  const out = redact(entry);
  assert.equal(out.cwd, '/work/red');
  assert.equal(out.raw, `run --token ${R}`);
  assert.deepEqual(out.argv, ['run', '--token', R]);
  assert.deepEqual(out.reads, [`/work/r${R}d/${R}/x`]);
  assert.deepEqual(redact(out), out);
});
