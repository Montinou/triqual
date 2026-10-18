// Contract checks on the methodology skill set. They read plugins/methodology/skills/*/SKILL.md at run time and hold
// for whatever skills exist, so a rename, an addition or a removal keeps them meaningful. Each check is a function of a
// `paths` object, so a meta-test can point it at a temp tree with a seeded defect and prove it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL = Object.freeze({
  skills: join(ROOT, 'plugins', 'methodology', 'skills'),
  commands: join(ROOT, 'plugins', 'methodology', 'commands'),
  agents: join(ROOT, 'plugins', 'roles', 'agents'),
  notice: join(ROOT, 'plugins', 'methodology', 'NOTICE'),
});
const { COMMANDS } = await import(pathToFileURL(join(ROOT, 'plugins', 'methodology', 'setup', 'triqual-shim.mjs')).href);

// The `triqual <word>` words the shim answers itself, without a COMMANDS entry (its HELP_FLAGS, `triqual help`).
const SHIM_BUILTINS = new Set(['help']);
// The `using-methodology` SKILL.md is loaded into every session: keep it small.
const USING_METHODOLOGY_MAX_CHARS = 5000;
// Placeholder paths in example text, not references: `<skill file>` → the literals it may contain.
const EXAMPLE_PATHS = {
  'writing-skills/SKILL.md': ['../some-skill', 'scripts/tool.sh', 'scripts/tool.js'],
  'writing-skills/anthropic-best-practices.md': [
    'scripts/helper.py', 'scripts/migrate.py', 'scripts/analyze_form.py', 'scripts/validate_fields.py',
    'scripts/fill_form.py', 'scripts/verify_output.py', 'ooxml/scripts/validate.py', 'ooxml/scripts/pack.py',
    'scripts/validate_boxes.py', 'scripts/pdf_to_images.py',
  ],
};

// Later tasks extend this: the skill directories under `skills`, sorted. A directory without SKILL.md is reported by the
// frontmatter check, so it is listed here too.
const skillDirs = (skills = REAL.skills) =>
  readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const walk = (dir, rel = '') =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walk(join(dir, entry.name), path) : [path];
    })
    .sort();
// Every file of every skill, as `<skill>/<path>`.
const skillFiles = (skills) => skillDirs(skills).flatMap((skill) => walk(join(skills, skill)).map((p) => `${skill}/${p}`));
const read = (skills, path) => readFileSync(join(skills, path), 'utf8');

// Lines outside fenced code blocks, with their 1-based numbers.
const linesOutsideFences = (text) => {
  const out = [];
  let fence = null;
  text.split('\n').forEach((line, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && m) {
      fence = m[1];
      return;
    }
    if (fence && m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) {
      fence = null;
      return;
    }
    if (!fence) out.push([i + 1, line]);
  });
  return out;
};

const frontmatterName = (text) => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return front ? /^name:\s*(.+?)\s*$/m.exec(front[1])?.[1] : undefined;
};

const nameProblems = ({ skills }) =>
  skillDirs(skills).flatMap((skill) => {
    if (!existsSync(join(skills, skill, 'SKILL.md'))) return [`${skill}: no SKILL.md`];
    const name = frontmatterName(read(skills, `${skill}/SKILL.md`));
    return name === skill ? [] : [`${skill}: frontmatter name is ${JSON.stringify(name)}`];
  });

// A `methodology:<x>` is a skill directory, or the plugin's slash command of that name (commands/<x>.md).
const methodologyRefProblems = ({ skills, commands }) => {
  const dirs = new Set(skillDirs(skills));
  const bad = [];
  for (const path of skillFiles(skills)) {
    for (const m of read(skills, path).matchAll(/(?<![\w-])methodology:([A-Za-z][A-Za-z0-9_-]*)/g)) {
      if (!dirs.has(m[1]) && !existsSync(join(commands, `${m[1]}.md`))) bad.push(`${path}: methodology:${m[1]}`);
    }
  }
  return bad;
};

const roleRefProblems = ({ skills, agents }) => {
  const bad = [];
  for (const path of skillFiles(skills)) {
    for (const m of read(skills, path).matchAll(/(?<![\w-])roles:([A-Za-z][A-Za-z0-9_-]*)/g)) {
      if (!existsSync(join(agents, `${m[1]}.md`))) bad.push(`${path}: roles:${m[1]}`);
    }
  }
  return bad;
};

// A command is named in a markdown file as `triqual <cmd>` inside backticks, or at the start of a (fenced) line. Prose
// such as "triqual missing" in a script comment is not a command, so scripts are not scanned.
const triqualCommandProblems = ({ skills }, known = COMMANDS) => {
  const bad = [];
  for (const path of skillFiles(skills).filter((p) => p.endsWith('.md'))) {
    read(skills, path).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/(?:`|^\s*(?:\$\s+)?)triqual +([a-z][a-z0-9-]*)/g)) {
        if (!Object.hasOwn(known, m[1]) && !SHIM_BUILTINS.has(m[1])) bad.push(`${path}:${i + 1}: triqual ${m[1]}`);
      }
    });
  }
  return bad;
};

const linkProblems = ({ skills }) => {
  const bad = [];
  for (const path of skillFiles(skills)) {
    const text = read(skills, path);
    const base = posix.dirname(path);
    const examples = EXAMPLE_PATHS[path] ?? [];
    const check = (lineNo, target) => {
      const entry = `${path}:${lineNo}: ${target}`;
      if (examples.includes(target)) return;
      const resolved = posix.normalize(posix.join(base, decodeURI(target)));
      if (!existsSync(join(skills, resolved)) && !bad.includes(entry)) bad.push(entry);
    };
    // Relative script paths and `../` paths, in any file, in or out of backticks.
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/(?<![\w./-])(?:\.\.\/[\w./-]*|(?:[\w-]+\/)*scripts\/[\w.-]+)/g)) {
        check(i + 1, m[0].replace(/(?<!\.)\.$/, ''));
      }
    });
    if (!path.endsWith('.md')) continue;
    for (const [lineNo, line] of linesOutsideFences(text)) {
      for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = m[1].split('#')[0].split('?')[0];
        if (/^[a-z][a-z0-9+.-]*:/i.test(m[1]) || !target) continue;
        check(lineNo, target);
      }
    }
  }
  return bad;
};

// The visual companion runs on this machine only: no skill script may contain a URL whose host is not loopback.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const isScript = (path) => /(^|\/)scripts\//.test(path) || /\.(js|cjs|mjs|ts|sh)$/.test(path);
const loopbackProblems = ({ skills }) => {
  const bad = [];
  for (const path of skillFiles(skills).filter(isScript)) {
    read(skills, path).split('\n').forEach((raw, i) => {
      // Join adjacent string literals ('https:' + '//host', "http""://host") so a split URL reads whole.
      const line = raw.replace(/(['"`])\s*\+?\s*(['"`])/g, '');
      const urls = [
        ...line.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^\s'"`<>)\/:?#]*)/gi),
        // Protocol-relative: `//host` where host is a domain, an IPv4 address or a bracketed IPv6 address.
        ...line.matchAll(/(?<![\w:\/])\/\/(\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?=[\/:'"`\s]|$)/gi),
      ];
      for (const m of urls) {
        if (m[1] && !LOOPBACK_HOSTS.has(m[1].toLowerCase())) bad.push(`${path}:${i + 1}: ${m[0]}`);
      }
    });
  }
  return bad;
};

// `references/x.md`, `scripts/y.js`, ...: a backticked path whose first segment is the name of a folder some skill has
// must resolve against its own skill's root or against the naming file's directory, so a path under a folder this skill
// lacks fails too.
const backtickPathProblems = ({ skills }) => {
  const folders = new Set(
    skillDirs(skills).flatMap((skill) =>
      readdirSync(join(skills, skill), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    ),
  );
  const bad = [];
  for (const path of skillFiles(skills)) {
    const skill = path.split('/')[0];
    read(skills, path).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/`([\w.-]+)\/([^`\s]*[^`\s/])`/g)) {
        const target = `${m[1]}/${m[2]}`;
        if (!folders.has(m[1]) || (EXAMPLE_PATHS[path] ?? []).includes(target)) continue;
        if (!existsSync(join(skills, skill, target)) && !existsSync(join(skills, posix.join(posix.dirname(path), target)))) {
          bad.push(`${path}:${i + 1}: ${target}`);
        }
      }
    });
  }
  return bad;
};

// The skills are triqual's own: none carries the footer that attributed a file to an upstream release ("Forked from
// superpowers 6.4.2 ..."), wherever it sits in the file. The credit lives in NOTICE and the READMEs.
const forkFooterProblems = ({ skills }) =>
  skillDirs(skills).flatMap((skill) => {
    const file = join(skills, skill, 'SKILL.md');
    return existsSync(file) && /Forked from/.test(readFileSync(file, 'utf8')) ? [`${skill}/SKILL.md`] : [];
  });

// A scheme whose host comes from a variable (`'http://' + host`, `ws://${host}`, `"https://$HOST"`) cannot be checked
// statically, so only these known local-address builders may contain one: [skill file, its exact trimmed line].
const LOCAL_ADDRESS_BUILDERS = [
  ['brainstorming/scripts/server.cjs', "return 'http://' + urlHostForHttp(URL_HOST) + ':' + PORT + '/?key=' + TOKEN;"],
  ['brainstorming/scripts/server.cjs', "return origin === 'http://' + host;"],
  [
    'brainstorming/scripts/helper.js',
    "return 'ws://' + window.location.host + (key ? '/?key=' + encodeURIComponent(key) : '');",
  ],
];
const SCHEME_VARIABLE = /\b[a-z][a-z0-9+.-]*:\/\/(?:['"`]\s*\+|\$\{?[A-Za-z_]|\$\()/i;
// The offending lines, and which exemptions matched a line (an exemption that matches none is stale).
const schemeVariableScan = ({ skills }, builders) => {
  const bad = [];
  const used = new Set();
  for (const path of skillFiles(skills).filter(isScript)) {
    read(skills, path).split('\n').forEach((line, i) => {
      if (!SCHEME_VARIABLE.test(line)) return;
      const k = builders.findIndex(([p, text]) => p === path && text === line.trim());
      if (k === -1) bad.push(`${path}:${i + 1}: ${line.trim()}`);
      else used.add(k);
    });
  }
  return { bad, used };
};
const schemeVariableProblems = (paths, builders = LOCAL_ADDRESS_BUILDERS) => schemeVariableScan(paths, builders).bad;
const staleBuilders = (paths, builders = LOCAL_ADDRESS_BUILDERS) => {
  const { used } = schemeVariableScan(paths, builders);
  return builders.filter((_, k) => !used.has(k)).map(([p, text]) => `${p}: ${text}`);
};

// The workspace ledger is `sdd-ledger.md` in every skill file. A path in the old `<workspace>/progress.md` form, in
// `$var/progress.md` or `sdd/.../progress.md`, any `/progress.md` in a script, and the pre-rename `.superpowers/sdd`
// directory all fail, except the one line of the workspace script that adopts a legacy ledger.
const LEGACY_ADOPTION = {
  path: 'subagent-driven-development/scripts/sdd-workspace',
  line: 'legacy="$root/.superpowers/sdd/$slug/progress.md"',
};
const WORKSPACE_LEDGER = /(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<workspace>|sdd\/\S*?)\/progress\.md/;
const ledgerProblems = ({ skills }) => {
  const bad = [];
  for (const path of skillFiles(skills)) {
    read(skills, path).split('\n').forEach((line, i) => {
      if (path === LEGACY_ADOPTION.path && line === LEGACY_ADOPTION.line) return;
      const named = WORKSPACE_LEDGER.test(line) || (isScript(path) && /\/progress\.md/.test(line));
      if (named || /\.superpowers\/sdd/.test(line)) bad.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  return bad;
};

// diagnosing-methodology files and searches issues with the authenticated `gh` only: no `curl`, no github.com URL.
const GH_SKILL = 'diagnosing-methodology';
const ghOnlyProblems = ({ skills }) =>
  skillFiles(skills)
    .filter((path) => path.startsWith(`${GH_SKILL}/`))
    .flatMap((path) =>
      read(skills, path).split('\n').flatMap((line, i) =>
        /\bcurl\b|https?:\/\/(api\.)?github\.com/.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [],
      ),
    );

// ... and its issues reference requires that `gh` be authenticated first: the file exists and says `gh auth status`.
const GH_ISSUES_REFERENCE = `${GH_SKILL}/references/github-issues.md`;
const ghAuthProblems = ({ skills }) => {
  if (!existsSync(join(skills, GH_ISSUES_REFERENCE))) return [`${GH_ISSUES_REFERENCE} is missing`];
  return /gh auth status/.test(read(skills, GH_ISSUES_REFERENCE)) ? [] : [`${GH_ISSUES_REFERENCE} does not require gh auth status`];
};

// Safety lines that must survive a rewrite: skill → the exact text, with why it matters.
const PINS = [
  {
    skill: 'brainstorming',
    text: '<HARD-GATE>',
    why: 'no implementation before the design is approved',
  },
  {
    skill: 'test-driven-development',
    text: 'NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST',
    why: 'the Iron Law: TDD first',
  },
  {
    skill: 'subagent-driven-development',
    text: 'Never skip the task review (the one exception is a task with no commit range: see When the stage does not run)',
    why: 'the gate and the review run on every task with commits',
  },
];
const pinProblems = ({ skills }, pins = PINS) =>
  pins.flatMap(({ skill, text, why }) => {
    const file = join(skills, skill, 'SKILL.md');
    if (!existsSync(file)) return [`${skill}/SKILL.md is missing (${why})`];
    // The text may wrap across lines in the file.
    const flat = readFileSync(file, 'utf8').replace(/\s*\n\s*/g, ' ');
    return flat.includes(text) ? [] : [`${skill}/SKILL.md lost its pinned line: ${text} (${why})`];
  });

// A temp skill tree for the meta-tests: `files` maps `<skill>/<path>` to its text.
const fixture = (t, files, { agents = [], commands = [] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'skills-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text = '') => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  for (const [path, text] of Object.entries(files)) put(join(root, 'skills', path), text);
  for (const name of agents) put(join(root, 'agents', `${name}.md`));
  for (const name of commands) put(join(root, 'commands', `${name}.md`));
  return { skills: join(root, 'skills'), commands: join(root, 'commands'), agents: join(root, 'agents') };
};
const skillMd = (name, body = '') => `---\nname: ${name}\ndescription: x\n---\n${body}\n`;

test('there is a skill set to check', () => {
  assert.ok(skillDirs().length > 0);
});

test('every skill has frontmatter name equal to its directory', () => {
  assert.deepEqual(nameProblems(REAL), []);
});

test('every methodology:<x> reference names an existing skill', () => {
  assert.deepEqual(methodologyRefProblems(REAL), []);
});

test('every roles:<x> reference names an agent file of the roles plugin', () => {
  assert.deepEqual(roleRefProblems(REAL), []);
});

test('every triqual <cmd> a skill names is a shim command or a shim built-in', () => {
  assert.deepEqual(triqualCommandProblems(REAL), []);
});

test('every relative markdown link and relative script path in the skills resolves', () => {
  assert.deepEqual(linkProblems(REAL), []);
});

test('no skill script contains a URL outside loopback hosts', () => {
  assert.deepEqual(loopbackProblems(REAL), []);
});

test('every backticked folder/file path a skill names resolves', () => {
  assert.deepEqual(backtickPathProblems(REAL), []);
});

test('no SKILL.md has a fork footer', () => {
  assert.deepEqual(forkFooterProblems(REAL), []);
});

test('a scheme with a variable host appears only in the known local-address builders', () => {
  assert.deepEqual(schemeVariableProblems(REAL), []);
});

test('every local-address exemption still names a line', () => {
  assert.deepEqual(staleBuilders(REAL), [], 'LOCAL_ADDRESS_BUILDERS lists a line that no longer exists');
});

test('the workspace ledger is sdd-ledger.md everywhere', () => {
  assert.deepEqual(ledgerProblems(REAL), []);
});

test('diagnosing-methodology files and searches issues with authenticated gh only', (t) => {
  if (!existsSync(join(REAL.skills, GH_SKILL))) {
    t.skip(`no ${GH_SKILL} skill directory (renamed or removed by a later phase: re-key GH_SKILL)`);
    return;
  }
  assert.deepEqual(ghAuthProblems(REAL), [], 'the issues reference does not require an authenticated gh');
  assert.deepEqual(ghOnlyProblems(REAL), [], 'unauthenticated fallbacks (curl, github.com URLs) remain');
});

test(`using-methodology/SKILL.md is at most ${USING_METHODOLOGY_MAX_CHARS} characters`, () => {
  const text = read(REAL.skills, 'using-methodology/SKILL.md');
  assert.ok(text.length <= USING_METHODOLOGY_MAX_CHARS, `${text.length} characters`);
});

test('brainstorming keeps its HARD-GATE', () => {
  assert.deepEqual(pinProblems(REAL, PINS.filter((p) => p.skill === 'brainstorming')), []);
});

test('test-driven-development keeps TDD first (the Iron Law)', () => {
  assert.deepEqual(pinProblems(REAL, PINS.filter((p) => p.skill === 'test-driven-development')), []);
});

test('subagent-driven-development keeps the gate on every task with commits', () => {
  assert.deepEqual(pinProblems(REAL, PINS.filter((p) => p.skill === 'subagent-driven-development')), []);
});

test('NOTICE names superpowers and its author', () => {
  const notice = readFileSync(REAL.notice, 'utf8');
  for (const needle of ['superpowers', 'Jesse Vincent', 'github.com/obra/superpowers', 'MIT', 'LICENSE-superpowers']) {
    assert.ok(notice.includes(needle), `NOTICE lacks ${needle}`);
  }
  assert.ok(existsSync(join(dirname(REAL.notice), 'LICENSE-superpowers')), 'LICENSE-superpowers is missing');
});

test('the root and the methodology README credit superpowers', () => {
  for (const path of [join(ROOT, 'README.md'), join(ROOT, 'plugins', 'methodology', 'README.md')]) {
    const text = readFileSync(path, 'utf8');
    assert.match(text, /fork of \[?superpowers\]?[^\n]*Jesse Vincent/, `${path} has no credit line`);
  }
});

test('the checks fail on a seeded defect', async (t) => {
  await t.test('a frontmatter name that differs from the directory', (t2) => {
    const p = fixture(t2, { 'a/SKILL.md': skillMd('b') });
    assert.deepEqual(nameProblems(p), ['a: frontmatter name is "b"']);
  });
  await t.test('a methodology: reference to a missing skill, but not to a slash command', (t2) => {
    const p = fixture(t2, { 'a/SKILL.md': skillMd('a', 'Use methodology:ghost, methodology:a and /methodology:setup.') },
      { commands: ['setup'] });
    assert.deepEqual(methodologyRefProblems(p), ['a/SKILL.md: methodology:ghost']);
  });
  await t.test('a roles: reference to a missing agent', (t2) => {
    const p = fixture(t2, { 'a/SKILL.md': skillMd('a', '`roles:hunter` and `roles:ghost`') }, { agents: ['hunter'] });
    assert.deepEqual(roleRefProblems(p), ['a/SKILL.md: roles:ghost']);
  });
  await t.test('a triqual command the shim lacks', (t2) => {
    const p = fixture(t2, { 'a/SKILL.md': skillMd('a', 'Run `triqual tasks list`, `triqual help`, `triqual ghost`.\n\n```\ntriqual phantom x\n```') });
    assert.deepEqual(triqualCommandProblems(p, { tasks: [] }), [
      'a/SKILL.md:5: triqual ghost',
      'a/SKILL.md:8: triqual phantom',
    ]);
  });
  await t.test('a broken markdown link and a broken script path, but not an example or a good one', (t2) => {
    const p = fixture(t2, {
      'a/SKILL.md': skillMd('a', '[ok](other.md) [bad](gone.md) [web](https://x.dev) [anchor](#top)\nRun `scripts/run.sh` or `scripts/gone.sh`.'),
      'a/other.md': '',
      'a/scripts/run.sh': '',
    });
    assert.deepEqual(linkProblems(p).sort(), ['a/SKILL.md:5: gone.md', 'a/SKILL.md:6: scripts/gone.sh']);
  });
  await t.test('a non-loopback URL in a script, but not a loopback one or one in a markdown file', (t2) => {
    const p = fixture(t2, {
      'a/SKILL.md': skillMd('a', 'See https://example.com/docs.'),
      'a/scripts/s.js': "const ok = 'http://127.0.0.1:3000';\nconst ws = 'ws://localhost/x';\nfetch('https://evil.example/' + 1);\nconst split = 'http:' + '//cdn.example.org';\nconst rel = '//cdn.example.net/x.js';",
    });
    assert.deepEqual(loopbackProblems(p), [
      'a/scripts/s.js:3: https://evil.example',
      'a/scripts/s.js:4: http://cdn.example.org',
      'a/scripts/s.js:5: //cdn.example.net',
    ]);
  });
  await t.test('a backticked path under a skill folder that does not exist, but not a good one or a non-folder prefix', (t2) => {
    const p = fixture(t2, {
      'a/SKILL.md': skillMd('a', 'Read `references/ok.md`, `references/gone.md`, `scripts/gone.sh` and `src/anything.md`.'),
      'a/references/ok.md': '',
      'b/scripts/x.sh': '',
    });
    assert.deepEqual(backtickPathProblems(p), [
      'a/SKILL.md:5: references/gone.md',
      'a/SKILL.md:5: scripts/gone.sh',
    ]);
  });
  await t.test('a SKILL.md with a Forked from footer, at the end or anywhere', (t2) => {
    const p = fixture(t2, {
      'a/SKILL.md': skillMd('a', 'body\n\nForked from superpowers 6.4.2 (skills/a), MIT © Jesse Vincent — see LICENSE-superpowers.'),
      'b/SKILL.md': skillMd('b', 'Credit: see NOTICE.'),
      'c/SKILL.md': skillMd('c', 'Forked from somewhere, mid-file.\n\nMore text.'),
      'd/SKILL.md': skillMd('d', 'a forked from lowercase is not the footer'),
    });
    assert.deepEqual(forkFooterProblems(p), ['a/SKILL.md', 'c/SKILL.md']);
  });
  await t.test('a scheme with a variable host outside the allow list, and a stale exemption', (t2) => {
    const p = fixture(t2, {
      'a/SKILL.md': skillMd('a'),
      'a/scripts/s.js':
        "const ok = 'http://' + host;\nconst bad = 'http://' + remoteHost;\nconst tpl = `ws://${remote}/x`;\nconst sh = \"https://$HOST/x\";",
    });
    const builders = [
      ['a/scripts/s.js', "const ok = 'http://' + host;"],
      ['a/scripts/gone.js', "return 'http://' + gone;"],
    ];
    assert.deepEqual(schemeVariableProblems(p, builders), [
      "a/scripts/s.js:2: const bad = 'http://' + remoteHost;",
      'a/scripts/s.js:3: const tpl = `ws://${remote}/x`;',
      'a/scripts/s.js:4: const sh = "https://$HOST/x";',
    ]);
    assert.deepEqual(staleBuilders(p, builders), ["a/scripts/gone.js: return 'http://' + gone;"]);
  });
  await t.test('a workspace ledger that is not sdd-ledger.md, and .superpowers/sdd outside the legacy line', (t2) => {
    const p = fixture(t2, {
      'a/SKILL.md': skillMd('a', 'Write sdd-ledger.md. Not <workspace>/progress.md.\nNor $ws/progress.md or sdd/x/progress.md.\nOld: .superpowers/sdd/x'),
      'a/scripts/s.sh': 'cat "$w/progress.md"',
      'subagent-driven-development/SKILL.md': skillMd('subagent-driven-development'),
      'subagent-driven-development/scripts/sdd-workspace': `${LEGACY_ADOPTION.line}\nlegacy2="$root/.superpowers/sdd/$slug"`,
    });
    assert.deepEqual(ledgerProblems(p), [
      'a/SKILL.md:5: Write sdd-ledger.md. Not <workspace>/progress.md.',
      'a/SKILL.md:6: Nor $ws/progress.md or sdd/x/progress.md.',
      'a/SKILL.md:7: Old: .superpowers/sdd/x',
      'a/scripts/s.sh:1: cat "$w/progress.md"',
      'subagent-driven-development/scripts/sdd-workspace:2: legacy2="$root/.superpowers/sdd/$slug"',
    ]);
  });
  await t.test('curl and a github.com URL in a diagnosing-methodology file, but not in another skill', (t2) => {
    const p = fixture(t2, {
      [`${GH_SKILL}/SKILL.md`]: skillMd(GH_SKILL, 'Use gh issue list.'),
      [`${GH_SKILL}/references/i.md`]: 'Fallback: curl -s https://api.github.com/search/issues\nSee https://github.com/x/y',
      'other/SKILL.md': skillMd('other', 'curl https://github.com/x'),
    });
    assert.deepEqual(ghOnlyProblems(p), [
      `${GH_SKILL}/references/i.md:1: Fallback: curl -s https://api.github.com/search/issues`,
      `${GH_SKILL}/references/i.md:2: See https://github.com/x/y`,
    ]);
  });
  await t.test('a github-issues.md that is missing or lacks gh auth status, but not one that requires it', (t2) => {
    const missing = fixture(t2, { [`${GH_SKILL}/SKILL.md`]: skillMd(GH_SKILL) });
    assert.deepEqual(ghAuthProblems(missing), [`${GH_ISSUES_REFERENCE} is missing`]);
    const lacking = fixture(t2, { [GH_ISSUES_REFERENCE]: 'Use `gh issue list`.' });
    assert.deepEqual(ghAuthProblems(lacking), [`${GH_ISSUES_REFERENCE} does not require gh auth status`]);
    const ok = fixture(t2, { [GH_ISSUES_REFERENCE]: 'First run:\n\n```\ngh auth status\n```' });
    assert.deepEqual(ghAuthProblems(ok), []);
  });
  await t.test('a pinned line that was removed', (t2) => {
    const p = fixture(t2, { 'brainstorming/SKILL.md': skillMd('brainstorming', 'no gate here') });
    assert.equal(pinProblems(p, PINS.filter((x) => x.skill === 'brainstorming')).length, 1);
    assert.equal(pinProblems(p).length, 3, 'a missing skill file is reported too');
  });
});
