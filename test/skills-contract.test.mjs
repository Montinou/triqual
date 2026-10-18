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
  await t.test('a pinned line that was removed', (t2) => {
    const p = fixture(t2, { 'brainstorming/SKILL.md': skillMd('brainstorming', 'no gate here') });
    assert.equal(pinProblems(p, PINS.filter((x) => x.skill === 'brainstorming')).length, 1);
    assert.equal(pinProblems(p).length, 3, 'a missing skill file is reported too');
  });
});
