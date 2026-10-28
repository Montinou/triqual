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
// Placeholder paths in example text, not references: `<skill file>` → the literals it may contain. No skill has any now
// (writing-skills moved to headjack).
const EXAMPLE_PATHS = {};

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
      // A file under `<skill>/references/` carries section text that was written for SKILL.md, so a target in it also
      // resolves against its skill's root, like a backticked path (see backtickPathProblems).
      const fromRoot = /^[^/]+\/references\//.test(path) ? posix.normalize(posix.join(path.split('/')[0], decodeURI(target))) : null;
      if (!existsSync(join(skills, resolved)) && !(fromRoot && existsSync(join(skills, fromRoot))) && !bad.includes(entry)) bad.push(entry);
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
  path: 'executing-plans/scripts/sdd-workspace',
  line: '  const legacy = join(root, `.superpowers/sdd/${slug}/progress.md`);',
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

// Every command a skill tells an agent to run is one plain command: the worktree guard of a Claude Code session
// refuses a compound shell command it cannot verify. In a fenced bash/sh block every line is a command; outside one, an
// inline `code` span is a command when it starts with triqual, node, git, gh, bash, scripts/, `cd`, `mktemp`, `rm` or a
// variable assignment (an optional opening parenthesis aside). An unlabelled fence holds a prompt template or an
// example: there a line that starts like a command, and every inline span inside the line, is held to the same rule
// (a labelled non-shell fence, such as `text`, is output and exempt). None may chain (`&&`, `;`), substitute (`$(…)`, backticks)
// or change directory first. A value that needs a command's output is a separate step that
// runs the command and names its output.
const COMMAND_START = /^\(?(?:triqual|node|git|gh|bash|cd|mktemp|rm)(?:\s|$)|^scripts\/|^[A-Za-z_]\w*=\S/;
const COMPOUND = /&&|;|\$\(|`|^\(?cd(?:\s|$)/;
const SHELL_FENCE = /^(?:bash|sh)$/;
const plainCommandProblems = ({ skills }) => {
  const bad = [];
  for (const path of skillFiles(skills).filter((p) => p.endsWith('.md'))) {
    let fence = null;
    let shell = false;
    let bare = false;
    read(skills, path).split('\n').forEach((line, i) => {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!fence && m) {
        fence = m[1];
        shell = SHELL_FENCE.test(m[2].trim().split(/\s/)[0]);
        bare = !m[2].trim();
        return;
      }
      if (fence && m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) {
        fence = null;
        return;
      }
      const flag = (text) => bad.push(`${path}:${i + 1}: ${text}`);
      if (fence) {
        const command = line.replace(/\s+#.*$/, '').trim();
        if (shell && command && !command.startsWith('#') && COMPOUND.test(command)) flag(command);
        if (!bare) return;
        if (COMMAND_START.test(command) && COMPOUND.test(command)) flag(command);
      }
      for (const span of line.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
        const command = span[1].trim();
        if (COMMAND_START.test(command) && COMPOUND.test(command)) flag(command);
      }
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
    skill: 'executing-plans',
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

// The eleven skills (the ten of 1.0 and auditing-performance), and nothing else.
const TEN_SKILLS = [
  'auditing-performance', 'brainstorming', 'diagnosing-methodology', 'executing-plans', 'finishing-branch', 'reviewing-code',
  'systematic-debugging', 'test-driven-development', 'using-methodology', 'verification-before-completion', 'writing-plans',
];

// No skill tells an agent to dispatch a generic `general-purpose` agent: every dispatch names a role. The harness
// references say what a harness does about a missing role, so they may name the generic agent to forbid it.
const GENERIC_AGENT_EXEMPT = new Set(['using-methodology/references/codex-tools.md', 'using-methodology/references/grok-tools.md']);
const genericAgentProblems = ({ skills }) =>
  skillFiles(skills)
    .filter((path) => path.endsWith('.md') && !GENERIC_AGENT_EXEMPT.has(path))
    .flatMap((path) =>
      read(skills, path).split('\n').flatMap((line, i) => (/general-purpose/i.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
    );

// The reviewer template of reviewing-code dispatches roles:spec-reviewer: its first dispatch line is exactly this.
const REVIEWER_TEMPLATE = 'reviewing-code/reviewer-prompt.md';
const REVIEWER_DISPATCH = 'Subagent (roles:spec-reviewer):';
const reviewerTemplateProblems = ({ skills }) => {
  if (!existsSync(join(skills, REVIEWER_TEMPLATE))) return [`${REVIEWER_TEMPLATE} is missing`];
  const first = read(skills, REVIEWER_TEMPLATE).split('\n').find((line) => /Subagent\s*\(/.test(line));
  return first?.trim() === REVIEWER_DISPATCH ? [] : [`${REVIEWER_TEMPLATE}: first dispatch line is ${JSON.stringify(first)}`];
};

// fence cooperation (design U9): a denial is a stop-and-ask, and `fence hatch` appears only in the clause that forbids
// suggesting it: the one sentence of FENCE_DENIAL_RULE, whole. A paragraph is text between blank lines; a sentence is
// text up to a full stop, question mark or exclamation mark, with line breaks folded.
const FENCE_DENIAL_RULE = 'A refusal that names fence, a policy or a protected path, or that you cannot explain, is a denial: stop, report the denied call and its path, and ask the human; never retry a variant of the call, never suggest `fence hatch`, and never edit fence\'s policy; when in doubt, stop.';
const FENCE_PINS = [
  { skill: 'executing-plans', text: FENCE_DENIAL_RULE, why: 'a fence denial is a stop-and-ask, never a retry' },
  { skill: 'finishing-branch', text: FENCE_DENIAL_RULE, why: 'a fence denial is a stop-and-ask in every run' },
  { skill: 'finishing-branch', text: 'a local merge to a protected branch is a human step', why: 'with fence installed the merge is the human\'s to run' },
];
// The sentences of `text` that name fence hatch and are not FENCE_DENIAL_RULE.
const hatchOffenders = (text) =>
  text.split(/\n\s*\n/).flatMap((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim().split(/(?<=[.!?])\s+/))
    .filter((sentence) => /fence hatch/i.test(sentence) && sentence !== FENCE_DENIAL_RULE);
const fenceHatchProblems = ({ skills }) =>
  skillFiles(skills)
    .filter((path) => path.endsWith('.md'))
    .flatMap((path) => hatchOffenders(read(skills, path)).map((sentence) => `${path}: ${sentence.slice(0, 80)}`));
// The last heading (indented ones, inside a prompt template, included) before the first occurrence of `needle` in `text`.
const headingBefore = (text, needle) => {
  const at = text.indexOf(needle);
  return at < 0 ? null : (text.slice(0, at).match(/^ *#{1,6} .*$/gm) ?? []).at(-1)?.trim() ?? null;
};

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

test('skill commands are plain', () => {
  assert.deepEqual(plainCommandProblems(REAL), []);
});

test('exactly these 10 skills exist', () => {
  assert.deepEqual(skillDirs(), TEN_SKILLS);
});

test('no skill names a generic general-purpose agent outside the codex and grok references', () => {
  assert.deepEqual(genericAgentProblems(REAL), []);
});

test('reviewing-code dispatches roles:spec-reviewer first in its reviewer template', () => {
  assert.deepEqual(reviewerTemplateProblems(REAL), []);
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

test('executing-plans keeps the gate on every task with commits', () => {
  assert.deepEqual(pinProblems(REAL, PINS.filter((p) => p.skill === 'executing-plans')), []);
});

test('executing-plans keeps the fence stop-and-ask line and finishing-branch the fence human step', () => {
  assert.deepEqual(pinProblems(REAL, FENCE_PINS), []);
});

test('no skill or template names fence hatch except in the clause that forbids suggesting it', () => {
  assert.deepEqual(fenceHatchProblems(REAL), []);
  const carriers = skillFiles(REAL.skills).filter((path) => path.endsWith('.md') && /fence hatch/.test(read(REAL.skills, path)));
  assert.deepEqual(carriers, [
    'brainstorming/spec-document-reviewer-prompt.md',
    'executing-plans/SKILL.md', 'executing-plans/final-review-prompt.md', 'executing-plans/hunter-prompt.md',
    'executing-plans/implementer-prompt.md', 'executing-plans/orchestrator-prompt.md', 'executing-plans/re-review-prompt.md',
    'executing-plans/safety-review-prompt.md',
    'executing-plans/task-reviewer-prompt.md', 'finishing-branch/SKILL.md', 'reviewing-code/reviewer-prompt.md',
  ]);
  // The role agents are outside the skills; their definitions are checked the same way.
  for (const file of readdirSync(REAL.agents).filter((name) => name.endsWith('.md'))) {
    assert.deepEqual(hatchOffenders(readFileSync(join(REAL.agents, file), 'utf8')), [], file);
  }
});

// The denial rule reaches every role that can meet a denial: each dispatch template (a prompt file with a `Subagent (`
// dispatch) and each role agent definition carries it once, under its own heading. A new template or role without it
// fails here.
const DISPATCH_TEMPLATES = skillFiles(REAL.skills).filter(
  (path) => path.endsWith('-prompt.md') && /^\s*Subagent \(/m.test(read(REAL.skills, path)),
);
const ROLE_AGENT_FILES = readdirSync(REAL.agents).filter((name) => name.endsWith('.md')).sort();
const carrierProblems = (label, text) => {
  const flatText = text.replace(/\s*\n\s*/g, ' ');
  const problems = [];
  if (flatText.split(FENCE_DENIAL_RULE).length !== 2) problems.push(`${label}: the denial rule must appear exactly once`);
  if (headingBefore(text, FENCE_DENIAL_RULE)?.replace(/^#+ /, '') !== 'Denied by Policy') problems.push(`${label}: not under a Denied by Policy heading`);
  return problems;
};

test('every dispatch template and every role agent carries the denial rule once, under its own heading', () => {
  assert.ok(DISPATCH_TEMPLATES.length >= 8, DISPATCH_TEMPLATES.join(', '));
  for (const needed of ['reviewing-code/reviewer-prompt.md', 'brainstorming/spec-document-reviewer-prompt.md']) {
    assert.ok(DISPATCH_TEMPLATES.includes(needed), `${needed} is not recognized as a dispatch template`);
  }
  assert.equal(ROLE_AGENT_FILES.length, 9, ROLE_AGENT_FILES.join(', '));
  assert.deepEqual([
    ...DISPATCH_TEMPLATES.flatMap((path) => carrierProblems(path, read(REAL.skills, path))),
    ...ROLE_AGENT_FILES.flatMap((file) => carrierProblems(`roles/agents/${file}`, readFileSync(join(REAL.agents, file), 'utf8'))),
  ], []);
});

test('the denial rule stands under its own heading in the orchestrator and finishing-branch, not under a fence-only one', () => {
  assert.equal(headingBefore(read(REAL.skills, 'executing-plans/SKILL.md'), FENCE_DENIAL_RULE), '## Denied by Policy');
  assert.equal(headingBefore(read(REAL.skills, 'finishing-branch/SKILL.md'), FENCE_DENIAL_RULE), '### Denied by Policy');
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
  await t.test('a general-purpose agent in a skill, but not in the codex and grok references', (t2) => {
    const p = fixture(t2, {
      'a/SKILL.md': skillMd('a', 'Dispatch a General-Purpose agent.'),
      'using-methodology/references/codex-tools.md': 'Never spawn a general-purpose agent in place of a role.',
      'using-methodology/references/claude-code-tools.md': 'general-purpose, model: sonnet',
    });
    assert.deepEqual(genericAgentProblems(p), [
      'a/SKILL.md:5: Dispatch a General-Purpose agent.',
      'using-methodology/references/claude-code-tools.md:1: general-purpose, model: sonnet',
    ]);
  });
  await t.test('a reviewer template that is missing or dispatches another role first', (t2) => {
    assert.deepEqual(reviewerTemplateProblems(fixture(t2, { 'a/SKILL.md': skillMd('a') })), [`${REVIEWER_TEMPLATE} is missing`]);
    const p = fixture(t2, { [REVIEWER_TEMPLATE]: '# T\n\nSubagent (roles:hunter):\nSubagent (roles:spec-reviewer):\n' });
    assert.deepEqual(reviewerTemplateProblems(p), [`${REVIEWER_TEMPLATE}: first dispatch line is "Subagent (roles:hunter):"`]);
    const ok = fixture(t2, { [REVIEWER_TEMPLATE]: '# T\n\n```\nSubagent (roles:spec-reviewer):\n  description: x\n```\n' });
    assert.deepEqual(reviewerTemplateProblems(ok), []);
  });
  await t.test('fence hatch outside the denial rule sentence, even in a sentence that forbids suggesting it', (t2) => {
    const p = fixture(t2, {
      'a/notes.md': 'When denied, you may try `fence hatch` to open it.\nNever mind.',
      'a/prompt.md': `## Denied by Policy\n\n    ${FENCE_DENIAL_RULE.replace(', and ask', ',\n    and ask')}\n\nThen ask the human.`,
      'a/partial.md': 'You may stop, but never suggest `fence hatch`, and then retry a variant.',
      'b/notes.md': 'Use Fence Hatch for this.',
    });
    assert.deepEqual(fenceHatchProblems(p), [
      'a/notes.md: When denied, you may try `fence hatch` to open it.',
      'a/partial.md: You may stop, but never suggest `fence hatch`, and then retry a variant.',
      'b/notes.md: Use Fence Hatch for this.',
    ]);
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
  await t.test('a compound command in a bash block or an inline span, but not a plain one, a comment or a non-shell block', (t2) => {
    const p = fixture(t2, {
      'a/SKILL.md': skillMd(
        'a',
        [
          'Run `git status`, `node a.mjs x`, `(cd "$W" && node a.mjs y)`, `d=$(mktemp -d)` and `a; b`.',
          'Prose with && and ; and $(x) is not a command.',
          '```bash',
          '# a comment; with a semicolon',
          'git rev-parse HEAD  # trailing; comment',
          'BASE=$(git rev-parse HEAD~1)',
          'cd "$path"',
          'if [ -f go.mod ]; then go mod download; fi',
          'git add a && git commit -m x',
          'node a.mjs',
          '```',
          '```text',
          'git add a && git commit -m x',
          '```',
          '```',
          'Template prose with a; b and a plain `git status`.',
          '    BASE_SHA=$(git log | head -1)',
          'Export it: `d=$(mktemp -d) && git archive <sha> | tar -x -C "$d"`.',
          '```',
        ].join('\n'),
      ),
    });
    assert.deepEqual(plainCommandProblems(p), [
      'a/SKILL.md:5: (cd "$W" && node a.mjs y)',
      'a/SKILL.md:5: d=$(mktemp -d)',
      'a/SKILL.md:10: BASE=$(git rev-parse HEAD~1)',
      'a/SKILL.md:11: cd "$path"',
      'a/SKILL.md:12: if [ -f go.mod ]; then go mod download; fi',
      'a/SKILL.md:13: git add a && git commit -m x',
      'a/SKILL.md:21: BASE_SHA=$(git log | head -1)',
      'a/SKILL.md:22: d=$(mktemp -d) && git archive <sha> | tar -x -C "$d"',
    ]);
  });
  await t.test('a workspace ledger that is not sdd-ledger.md, and .superpowers/sdd outside the legacy line', (t2) => {
    const p = fixture(t2, {
      'a/SKILL.md': skillMd('a', 'Write sdd-ledger.md. Not <workspace>/progress.md.\nNor $ws/progress.md or sdd/x/progress.md.\nOld: .superpowers/sdd/x'),
      'a/scripts/s.sh': 'cat "$w/progress.md"',
      'executing-plans/SKILL.md': skillMd('executing-plans'),
      'executing-plans/scripts/sdd-workspace': `${LEGACY_ADOPTION.line}\nlegacy2="$root/.superpowers/sdd/$slug"`,
    });
    assert.deepEqual(ledgerProblems(p), [
      'a/SKILL.md:5: Write sdd-ledger.md. Not <workspace>/progress.md.',
      'a/SKILL.md:6: Nor $ws/progress.md or sdd/x/progress.md.',
      'a/SKILL.md:7: Old: .superpowers/sdd/x',
      'a/scripts/s.sh:1: cat "$w/progress.md"',
      'executing-plans/scripts/sdd-workspace:2: legacy2="$root/.superpowers/sdd/$slug"',
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
