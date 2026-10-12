// Static checks on the superpowers fork (spec Addendum E.2, E.4, E.7).
// Every later skill task keeps these green. Orchestration skills that a later task adapts stay in PENDING,
// and their cases run as `todo` (reported, never skipped) until that task removes them from the set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, posix, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(PLUGIN, 'skills');

// Skill directory renames (upstream → fork), E.2.
const SKILL_RENAMES = {
  'using-superpowers': 'using-methodology',
  'diagnosing-superpowers': 'diagnosing-methodology',
  'finishing-a-development-branch': 'finishing-branch',
};

// Orchestration skills a later task still adapts; each task removed its skills from this set (T4: using-methodology;
// T5: brainstorming, writing-plans; T6: subagent-driven-development; T7: executing-plans, finishing-branch). Empty now.
const PENDING = new Set([]);

// Role templates (path under skills/) → the exact dispatch headers they carry (E.4).
const ROLE_HEADERS = {
  'subagent-driven-development/implementer-prompt.md': ['Subagent (<task role>):'],
  'subagent-driven-development/task-reviewer-prompt.md': ['Subagent (roles:spec-reviewer):'],
  'subagent-driven-development/safety-review-prompt.md': ['Subagent (roles:safety-reviewer):'],
  'subagent-driven-development/hunter-prompt.md': ['Subagent (roles:hunter):'],
  'subagent-driven-development/re-review-prompt.md': [
    'Subagent (roles:spec-reviewer):',
    'Subagent (roles:safety-reviewer):',
  ],
  'subagent-driven-development/final-review-prompt.md': ['Subagent (roles:final-adversarial-reviewer):'],
  'requesting-code-review/code-reviewer.md': ['Subagent (roles:spec-reviewer):'],
  'brainstorming/spec-document-reviewer-prompt.md': ['Subagent (roles:final-adversarial-reviewer):'],
};

// Upstream placeholders in example commands, not paths: `<skill>/<file>` → the literal it may contain.
const EXAMPLE_PATHS = {
  'writing-skills/SKILL.md': ['../some-skill', 'scripts/tool.sh'],
  'writing-skills/anthropic-best-practices.md': ['scripts/helper.py'],
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
// A scheme whose host comes from a variable (`'http://' + host`, `\`ws://${host}\``, `"https://$HOST"`) cannot be
// checked statically. Only these known local-address builders may do it: `<path>` → its exact trimmed line.
const LOCAL_ADDRESS_BUILDERS = [
  ['brainstorming/scripts/server.cjs', "return 'http://' + urlHostForHttp(URL_HOST) + ':' + PORT + '/?key=' + TOKEN;"],
  ['brainstorming/scripts/server.cjs', "return origin === 'http://' + host;"],
  [
    'brainstorming/scripts/helper.js',
    "return 'ws://' + window.location.host + (key ? '/?key=' + encodeURIComponent(key) : '');",
  ],
];
const SCHEME_VARIABLE = /\b[a-z][a-z0-9+.-]*:\/\/(?:['"`]\s*\+|\$\{?[A-Za-z_]|\$\()/i;
const GENERIC_AGENT_SKILL = 'dispatching-parallel-agents';
// Files outside it that may name a generic agent (F.7, F.10): the Codex and Grok references, which rule one out.
const GENERIC_AGENT_EXEMPT = new Set([
  'using-methodology/references/codex-tools.md',
  'using-methodology/references/grok-tools.md',
]);

const upstream = JSON.parse(readFileSync(join(PLUGIN, 'upstream.json'), 'utf8'));
const VENDORED = Object.keys(upstream.vendored.files).sort();
const UPSTREAM_SKILLS = [...new Set(VENDORED.map((path) => path.split('/')[0]))].sort();
const forkName = (upstreamName) => SKILL_RENAMES[upstreamName] ?? upstreamName;
const upstreamName = (fork) =>
  Object.keys(SKILL_RENAMES).find((name) => SKILL_RENAMES[name] === fork) ?? fork;
const attribution = (skill) =>
  `Forked from superpowers ${upstream.vendored.version} (skills/${upstreamName(skill)}), MIT © Jesse Vincent — see LICENSE-superpowers.`;

// using-methodology's supersede rule (E.3), exactly as its SKILL.md states it.
const SUPERSEDE_RULE =
  '- **Superseded plugin:** never use a `superpowers:*` skill when one is listed: `methodology` supersedes it. Use the matching `methodology:*` skill instead.';

// using-methodology's skill-suggest and mirror-language rules (§11), exactly as its SKILL.md states them.
const SKILL_SUGGEST_RULE =
  "- **Skill suggestions:** a `skill-suggest` line names a vault skill that may fit the request. If it fits, offer to install it with the `skillvault add` command the suggestion gives, before improvising. Never install it without your human partner's OK; for a plugin, ask for `/reload-plugins` afterwards.";
const LANGUAGE_RULE =
  '- **Language:** artifacts (skills, specs, plans, ledgers, code, commits, progress entries) are in English. Conversation mirrors the language of the user\'s message; a mixed message uses the dominant language.';

// sdd-workspace's legacy adoption (E.5): the one line that names the pre-fork workspace ledger.
const LEGACY_ADOPTION = ['legacy="$root/.superpowers/sdd/$slug/progress.md"'];

// Exact lines where "superpowers" may appear under skills/ (E.2): the attributions, using-methodology's supersede
// rule and sdd-workspace's legacy-adoption line.
const ATTRIBUTIONS = new Set(UPSTREAM_SKILLS.map((name) => attribution(forkName(name))));
const ALLOW_SUPERPOWERS = new Set([...ATTRIBUTIONS, SUPERSEDE_RULE, ...LEGACY_ADOPTION]);

const walk = (dir, rel = '') =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walk(join(dir, entry.name), path) : [path];
    })
    .sort();

const skillDirs = () =>
  readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
const skillFiles = (skill) => walk(join(SKILLS, skill)).map((path) => `${skill}/${path}`);
const read = (path) => readFileSync(join(SKILLS, path), 'utf8');
const exists = (path) => existsSync(join(SKILLS, path));
const isScript = (path) => /(^|\/)scripts\//.test(path) || /\.(js|cjs|mjs|ts|sh)$/.test(path);

// Per PENDING skill: how many of its cases ran and how many failed. A PENDING skill whose cases all pass must
// leave PENDING (checked by the last test in this file).
const pendingRuns = new Map();
const caseFor = (skill, check) => {
  if (!PENDING.has(skill)) return [{ todo: false }, check];
  const record = pendingRuns.get(skill) ?? { ran: 0, failed: 0 };
  pendingRuns.set(skill, record);
  return [
    { todo: `${skill} is adapted in a later task` },
    () => {
      record.ran += 1;
      try {
        check();
      } catch (error) {
        record.failed += 1;
        throw error;
      }
    },
  ];
};

// One subtest per skill; a PENDING skill's case is `todo` until its task lands.
const perSkill = async (t, check, skills = skillDirs()) => {
  for (const skill of skills) await t.test(skill, ...caseFor(skill, () => check(skill)));
};

// "superpowers" may appear only in an allowlisted line, and an attribution line only as the last line of its own
// skill's SKILL.md.
const allowedSuperpowers = (path, lines, i) => {
  if (!ALLOW_SUPERPOWERS.has(lines[i])) return false;
  if (!ATTRIBUTIONS.has(lines[i])) return true;
  const skill = path.split('/')[0];
  const last = lines.findLastIndex((line) => line.trim());
  return path === `${skill}/SKILL.md` && i === last && lines[i] === attribution(skill);
};

// A dispatch, anywhere in a line: `Subagent (<type>):` or `Agent (<type>):` in any case, or an untyped `Subagent:`.
// The untyped form stays case-sensitive: prose such as "Dispatch code reviewer subagent:" is not a dispatch line.
const TYPED_DISPATCH = /\b(?:sub)?agent\s*\(([^)]*)\)\s*:/gi;
const UNTYPED_DISPATCH = /\bSubagent\s*:/g;
const dispatchesIn = (line) => [
  ...[...line.matchAll(TYPED_DISPATCH)].map((m) => ({ text: m[0], type: m[1].trim() })),
  ...[...line.matchAll(UNTYPED_DISPATCH)].map((m) => ({ text: m[0], type: undefined })),
];
const isDispatch = (line) => dispatchesIn(line).length > 0;
// The implementer's `<task role>` placeholder is valid in this template only.
const TASK_ROLE_TEMPLATE = 'subagent-driven-development/implementer-prompt.md';
const ROLE_AGENTS = new Set(
  readdirSync(join(PLUGIN, '..', 'roles', 'agents'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `roles:${name.slice(0, -3)}`),
);

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
    // A closing fence: same character, at least as long, no info string (CommonMark).
    if (fence && m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) {
      fence = null;
      return;
    }
    if (!fence) out.push([i + 1, line]);
  });
  return out;
};

// FORK.md: `## <Section>` blocks.
const forkDoc = () => {
  const text = readFileSync(join(PLUGIN, 'FORK.md'), 'utf8');
  const sections = new Map();
  const order = [];
  let current = null;
  for (const line of text.split('\n')) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      order.push(current);
      sections.set(current, []);
    } else if (current) sections.get(current).push(line);
  }
  const entries = (name, re) =>
    (sections.get(name) ?? []).map((line) => re.exec(line)).filter(Boolean);
  const renames = entries('Renames', /^- `([^`]+)` → `([^`]+)`\s*(?:—|:)\s*\S/).map((m) => ({
    from: m[1],
    to: m[2],
  }));
  const removed = entries('Removed', /^- `([^`]+)`\s*(?:—|:)\s*\S/).map((m) => m[1]);
  const derived = entries('Derived', /^- `([^`]+)` ← `([^`]+)`\s*(?:—|:)\s*\S/).map((m) => ({
    path: m[1],
    source: m[2],
  }));
  return { text, sections, order, renames, removed, derived };
};

// Maps an upstream path through the Renames entries; a file entry beats a directory entry.
const mapPath = (renames, path) => {
  const file = renames.find((r) => !r.from.endsWith('/') && r.from === path);
  if (file) return file.to;
  const dir = renames
    .filter((r) => r.from.endsWith('/') && path.startsWith(r.from))
    .sort((a, b) => b.from.length - a.from.length)[0];
  return dir ? dir.to + path.slice(dir.from.length) : path;
};

test('every forked skill has frontmatter name equal to its directory', async (t) => {
  await perSkill(t, (skill) => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(read(`${skill}/SKILL.md`));
    assert.ok(front, `${skill}/SKILL.md has no frontmatter`);
    const name = /^name:\s*(.+?)\s*$/m.exec(front[1]);
    assert.equal(name?.[1], skill);
  });
  await t.test('the 15 directories carry the fork names', () => {
    assert.deepEqual(skillDirs(), UPSTREAM_SKILLS.map(forkName).sort());
  });
});

test('every forked SKILL.md ends with the attribution line', async (t) => {
  await perSkill(t, (skill) => {
    const lines = read(`${skill}/SKILL.md`).replace(/\n+$/, '').split('\n');
    assert.equal(lines.at(-1), attribution(skill));
  });
});

// The upstream files the fork is checked against (E.2, E.7): the last reviewed release's, as `--mark-reviewed` records
// them in upstream.json's reviewed.files, else the vendored release's. A file ported from a later reviewed release is
// then upstream, not fork-only, and a file that release added but the fork did not take must be registered as Removed.
const baselineFiles = (doc) => Object.keys(doc.reviewed?.files ?? doc.vendored.files).sort();

// Baseline files that are neither in the fork (at their own or their renamed path) nor registered as Removed.
const unregisteredRemoved = ({ baseline, renames, removed, exists: has }) => {
  const isRemoved = (path) =>
    removed.some((entry) => entry === path || (entry.endsWith('/') && path.startsWith(entry)));
  return baseline.filter((path) => {
    if (has(path)) return false;
    const mapped = mapPath(renames, path);
    if (mapped !== path && has(mapped)) return false;
    return !(isRemoved(path) || isRemoved(mapped));
  });
};

// Fork files that neither come from the baseline (through the renames), nor are a file rename's target, nor are
// registered as Derived.
const unregisteredForkOnly = ({ baseline, renames, derived, files }) => {
  const fromUpstream = new Set(baseline.map((path) => mapPath(renames, path)));
  return files.filter((path) => {
    if (fromUpstream.has(path)) return false;
    if (renames.some((r) => !r.to.endsWith('/') && r.to === path)) return false;
    return !derived.some((d) => d.path === path);
  });
};

const BASELINE = baselineFiles(upstream);

test('FORK.md registers every renamed path and every removed upstream file', () => {
  const { renames, removed } = forkDoc();
  const unregistered = unregisteredRemoved({ baseline: BASELINE, renames, removed, exists });
  assert.deepEqual(unregistered, [], `not registered in FORK.md Renames or Removed: ${unregistered.join(', ')}`);
});

test('FORK.md registers every fork-only file', () => {
  const { renames, derived } = forkDoc();
  const unregistered = unregisteredForkOnly({ baseline: BASELINE, renames, derived, files: walk(SKILLS) });
  assert.deepEqual(unregistered, [], `fork-only files not registered in FORK.md Derived: ${unregistered.join(', ')}`);
  for (const d of derived) {
    assert.ok(BASELINE.includes(d.source), `Derived ${d.path}: source ${d.source} is not an upstream file`);
  }
});

test('the FORK.md checks compare against the last reviewed release, else the vendored one', () => {
  const vendored = { version: '1.0.0', files: { 'a/SKILL.md': 'v1', 'a/dropped.md': 'v1' } };
  // Release 1.1.0 added a/ported.md (the fork took it) and a/skipped.md (the fork did not), and deleted a/dropped.md.
  const reviewed = { version: '1.1.0', files: { 'a/SKILL.md': 'v2', 'a/ported.md': 'v2', 'a/skipped.md': 'v2' } };
  const fork = ['a/SKILL.md', 'a/mine.md', 'a/ported.md'];
  const has = (path) => fork.includes(path);
  const check = (doc) => ({
    forkOnly: unregisteredForkOnly({ baseline: baselineFiles(doc), renames: [], derived: [], files: fork }),
    removed: unregisteredRemoved({ baseline: baselineFiles(doc), renames: [], removed: [], exists: has }),
  });
  // Before a --mark-reviewed that records files: the vendored release, so the ported file reads as fork-only.
  assert.deepEqual(check({ vendored, reviewed: { version: '1.0.0' } }),
    { forkOnly: ['a/mine.md', 'a/ported.md'], removed: ['a/dropped.md'] });
  // After it: the ported file passes, the fork-only file still fails, and the file not taken must be registered.
  assert.deepEqual(check({ vendored, reviewed }), { forkOnly: ['a/mine.md'], removed: ['a/skipped.md'] });
  assert.deepEqual(unregisteredRemoved({
    baseline: baselineFiles({ vendored, reviewed }), renames: [], removed: ['a/skipped.md'], exists: has,
  }), []);
});

test("FORK.md has a review log whose last line names upstream.json's reviewed.version", () => {
  const { sections, order } = forkDoc();
  assert.equal(order.at(-1), 'Review log', 'FORK.md must end with its Review log section');
  const log = sections.get('Review log').filter((line) => /^\d{4}-\d{2}-\d{2} /.test(line));
  assert.ok(log.length > 0, 'the review log has no entries');
  for (const line of log) assert.match(line, /^\d{4}-\d{2}-\d{2} \d+\.\d+\.\d+ \S/);
  const last = sections
    .get('Review log')
    .filter((line) => line.trim())
    .at(-1);
  assert.equal(last, log.at(-1), 'the last line of the review log must be a log entry');
  assert.equal(last.split(' ')[1], upstream.reviewed.version);
});

test('every methodology:<x> reference names an existing skill directory', async (t) => {
  const dirs = new Set(skillDirs());
  await perSkill(t, (skill) => {
    const bad = [];
    for (const path of skillFiles(skill)) {
      for (const m of read(path).matchAll(/(?<![\w-])methodology:([A-Za-z0-9_-]+)/g)) {
        if (!dirs.has(m[1])) bad.push(`${path}: methodology:${m[1]}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});

test('every relative path and markdown link under skills/ resolves', async (t) => {
  await perSkill(t, (skill) => {
    const bad = [];
    for (const path of skillFiles(skill)) {
      const text = read(path);
      const base = posix.dirname(path);
      const examples = EXAMPLE_PATHS[path] ?? [];
      const check = (lineNo, target) => {
        const resolved = posix.normalize(posix.join(base, decodeURI(target)));
        const entry = `${path}:${lineNo}: ${target}`;
        if (!existsSync(join(SKILLS, resolved)) && !bad.includes(entry)) bad.push(entry);
      };
      text.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/\.\.\/[\w./-]*/g)) {
          const target = m[0].replace(/(?<!\.)\.$/, '');
          if (!examples.includes(target)) check(i + 1, target);
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
    assert.deepEqual(bad, []);
  });
});

test('"superpowers" appears only in allowlisted lines', async (t) => {
  await perSkill(t, (skill) => {
    const bad = [];
    for (const path of skillFiles(skill)) {
      const lines = read(path).split('\n');
      lines.forEach((line, i) => {
        if (/superpowers/i.test(line) && !allowedSuperpowers(path, lines, i)) bad.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(bad, []);
  });
});

test('each role template carries its exact header', async (t) => {
  for (const [path, headers] of Object.entries(ROLE_HEADERS)) {
    const skill = path.split('/')[0];
    await t.test(path, ...caseFor(skill, () => {
      assert.ok(exists(path), `${path} is missing`);
      const lines = read(path).split('\n').map((line) => line.trim());
      const dispatches = lines.filter(isDispatch);
      assert.ok(headers.includes(dispatches[0]), `${path}: the first dispatch line is not a header: ${dispatches[0]}`);
      for (const header of headers) assert.ok(lines.includes(header), `${path} lacks the header ${header}`);
      const others = dispatches.filter((line) => !headers.includes(line));
      assert.deepEqual(others, [], `${path} carries other dispatch lines`);
    }));
  }
});

// The E.7 check on one skill under `root` (the skills directory or a temp copy of it): its lines that mention a
// generic agent, outside GENERIC_AGENT_EXEMPT.
const genericMentions = (skill, root = SKILLS) =>
  walk(join(root, skill))
    .map((path) => `${skill}/${path}`)
    .filter((path) => !GENERIC_AGENT_EXEMPT.has(path))
    .flatMap((path) =>
      readFileSync(join(root, path), 'utf8')
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /general-purpose/i.test(line))
        .map(([n, line]) => `${path}:${n}: ${line.trim()}`),
    );

test('only dispatching-parallel-agents mentions a generic agent', async (t) => {
  await perSkill(
    t,
    (skill) => assert.deepEqual(genericMentions(skill), []),
    skillDirs().filter((skill) => skill !== GENERIC_AGENT_SKILL),
  );
});

test('generic-agent check exempts only codex-tools.md and grok-tools.md', (t) => {
  // F.7: the Codex and Grok references may name a generic agent (to rule it out); any other file of the skill may not.
  assert.deepEqual([...GENERIC_AGENT_EXEMPT].sort(), [
    'using-methodology/references/codex-tools.md',
    'using-methodology/references/grok-tools.md',
  ]);
  const root = mkdtempSync(join(tmpdir(), 'generic-agent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skill = 'using-methodology';
  cpSync(join(SKILLS, skill), join(root, skill), { recursive: true });
  const mention = '\nNever spawn a general-purpose agent in place of a role.\n';
  const exempt = ['references/codex-tools.md', 'references/grok-tools.md'];
  for (const file of exempt) appendFileSync(join(root, skill, file), mention);
  assert.deepEqual(genericMentions(skill, root), [], 'a mention in an exempt reference fails the check');

  const others = walk(join(root, skill)).filter((path) => !exempt.includes(path));
  assert.ok(others.includes('references/claude-code-tools.md') && others.includes('SKILL.md'), others.join(', '));
  for (const file of others) {
    const path = join(root, skill, file);
    const before = readFileSync(path, 'utf8');
    appendFileSync(path, mention);
    const found = genericMentions(skill, root);
    assert.equal(found.length, 1, `a mention added to ${file} is not reported: ${found.join(' | ')}`);
    assert.ok(found[0].startsWith(`${skill}/${file}:`), found[0]);
    writeFileSync(path, before);
  }
});

test('every Subagent dispatch names a role agent', async (t) => {
  // Outside dispatching-parallel-agents a dispatch is `roles:<name>` (an agent of plugin roles), or the implementer's
  // `<task role>` placeholder in its own template; an untyped `Subagent:` or any other type fails.
  // dispatching-parallel-agents may also dispatch its generic fallback, which must name a model.
  const generic = /^general-purpose,\s*model:\s*\S+$/;
  await perSkill(t, (skill) => {
    const bad = [];
    for (const path of skillFiles(skill)) {
      read(path)
        .split('\n')
        .forEach((line, i) => {
          for (const { text, type } of dispatchesIn(line)) {
            const ok =
              type !== undefined &&
              (ROLE_AGENTS.has(type) ||
                (type === '<task role>' && path === TASK_ROLE_TEMPLATE) ||
                (skill === GENERIC_AGENT_SKILL && generic.test(type)));
            if (!ok) bad.push(`${path}:${i + 1}: ${text}`);
          }
        });
    }
    assert.deepEqual(bad, []);
  });
});

test('the workspace ledger is sdd-ledger.md everywhere', async (t) => {
  const workspaceLedger = /(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<workspace>|sdd\/\S*?)\/progress\.md/;
  await perSkill(t, (skill) => {
    const bad = [];
    for (const path of skillFiles(skill)) {
      const lines = read(path).split('\n');
      lines.forEach((line, i) => {
        if (allowedSuperpowers(path, lines, i)) return;
        const named = workspaceLedger.test(line) || (isScript(path) && /\/progress\.md/.test(line));
        if (named || /\.superpowers\/sdd/.test(line)) bad.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(bad, []);
  });
});

test('no skill script contains a URL outside loopback hosts', async (t) => {
  await perSkill(t, (skill) => {
    const bad = [];
    for (const path of skillFiles(skill).filter(isScript)) {
      read(path)
        .split('\n')
        .forEach((raw, i) => {
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
    assert.deepEqual(bad, []);
  });
});

test('a scheme with a variable host appears only in the known local-address builders', async (t) => {
  const used = new Set();
  await perSkill(t, (skill) => {
    const bad = [];
    for (const path of skillFiles(skill).filter(isScript)) {
      read(path)
        .split('\n')
        .forEach((line, i) => {
          if (!SCHEME_VARIABLE.test(line)) return;
          const k = LOCAL_ADDRESS_BUILDERS.findIndex(([p, text]) => p === path && text === line.trim());
          if (k === -1) bad.push(`${path}:${i + 1}: ${line.trim()}`);
          else used.add(k);
        });
    }
    assert.deepEqual(bad, []);
  });
  await t.test('every exemption still names a line', () => {
    const stale = LOCAL_ADDRESS_BUILDERS.filter((_, k) => !used.has(k)).map(([p, text]) => `${p}: ${text}`);
    assert.deepEqual(stale, [], 'LOCAL_ADDRESS_BUILDERS lists a line that no longer exists');
  });
});

test('every file a skill names in backticks under one of its own directories exists', async (t) => {
  // `references/x.md`, `scripts/y.js`, …: a backtick path whose first segment is a skill folder name (a directory of
  // any forked skill) must resolve against the skill root or against the naming file's directory, so a path under a
  // folder this skill lacks fails too.
  const folders = new Set(
    skillDirs().flatMap((skill) =>
      readdirSync(join(SKILLS, skill), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    ),
  );
  await perSkill(t, (skill) => {
    const bad = [];
    for (const path of skillFiles(skill)) {
      read(path)
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(/`([\w.-]+)\/([^`\s]*[^`\s/])`/g)) {
            const target = `${m[1]}/${m[2]}`;
            if (!folders.has(m[1]) || (EXAMPLE_PATHS[path] ?? []).includes(target)) continue;
            if (!exists(`${skill}/${target}`) && !exists(posix.join(posix.dirname(path), target))) {
              bad.push(`${path}:${i + 1}: ${target}`);
            }
          }
        });
    }
    assert.deepEqual(bad, []);
  });
});

test('the four non-Claude harness references are gone', () => {
  const references = 'using-methodology/references';
  for (const name of ['antigravity', 'gemini', 'muse', 'pi']) {
    const gone = walk(SKILLS).filter((path) => posix.basename(path) === `${name}-tools.md`);
    assert.deepEqual(gone, [], `${name}-tools.md is still present`);
  }
  for (const name of ['claude-code', 'codex', 'hermes']) {
    assert.ok(exists(`${references}/${name}-tools.md`), `${references}/${name}-tools.md is missing`);
  }
});

test('the Codex and Grok references route roles and skills as F.7 says', () => {
  const codex = read('using-methodology/references/codex-tools.md');
  assert.ok(codex.includes('`roles:<name>`'), 'codex-tools.md does not name the role dispatch');
  assert.ok(codex.includes('`agent_type: "<name>"`'), 'codex-tools.md does not map a role to agent_type');
  assert.match(codex, /`methodology:<x>` is the skill `<x>`/, 'codex-tools.md does not map methodology:<x>');
  const grok = read('using-methodology/references/grok-tools.md');
  assert.ok(grok.includes('SDD is unavailable in Grok: stop and ask your human partner.'), 'grok-tools.md lacks the rule');
  assert.match(grok, /cannot select a named agent/, 'grok-tools.md does not state the P6d result');
  const lines = read('using-methodology/SKILL.md').split('\n');
  const platforms = lines.slice(lines.indexOf('## Platform Adaptation'));
  assert.ok(platforms.includes('- Grok: `references/grok-tools.md`'), 'SKILL.md does not list the Grok reference');
  const { derived } = forkDoc();
  assert.ok(derived.some((d) => d.path === 'using-methodology/references/grok-tools.md'), 'FORK.md lacks grok-tools.md');
  const adaptations = forkDoc().sections.get('Text adaptations').join('\n');
  assert.match(adaptations, /references\/codex-tools\.md`'s "Role routing on spawns" is rewritten/, 'FORK.md lacks the rewrite');
});

test("diagnosing-methodology points at this system's files", () => {
  const text = read('diagnosing-methodology/SKILL.md');
  assert.ok(text.includes('.methodology/sdd'), 'no mention of .methodology/sdd');
  assert.ok(
    text.includes('~/.claude/plugins/cache/triqual'),
    'no mention of ~/.claude/plugins/cache/triqual',
  );
  assert.ok(text.includes('~/.config/triqual/diagnosing/'), 'no mention of its workspace');
});

test('diagnosing-methodology files and searches issues with authenticated gh only', () => {
  const issues = read('diagnosing-methodology/references/github-issues.md');
  assert.match(issues, /gh auth status/, 'github-issues.md does not require an authenticated gh');
  const bad = skillFiles('diagnosing-methodology').flatMap((path) =>
    read(path)
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /\bcurl\b|https?:\/\/(api\.)?github\.com/.test(line))
      .map(([n, line]) => `${path}:${n}: ${line.trim()}`),
  );
  assert.deepEqual(bad, [], 'unauthenticated fallbacks (curl, github.com URLs) remain');
});

test("using-methodology states the skill-suggest and mirror-language rules", () => {
  const lines = read('using-methodology/SKILL.md').split('\n');
  assert.ok(lines.includes(SKILL_SUGGEST_RULE), 'the skill-suggest rule is missing or changed');
  assert.ok(lines.includes(LANGUAGE_RULE), 'the mirror-language rule is missing or changed');
});

// brainstorming and writing-plans (T5): tracking paths, the audit, the §6.2 task format with **Role:**, the companion.
const TRACKED = ['brainstorming', 'writing-plans'];
const AUDITOR = 'roles:final-adversarial-reviewer';
const TASK_ROLES = ['roles:tdd-implementer', 'roles:complex-implementer', 'roles:review-fixer'];
const NOT_OPTED_IN = /^- \*\*Not opted in\*\*/;
const skillLines = (skill) => read(`${skill}/SKILL.md`).split('\n').map((line) => line.trim());
// Lines of every file of the tracked skills, as `[path, 1-based number, trimmed line]`.
const trackedLines = () =>
  TRACKED.flatMap((skill) =>
    skillFiles(skill).flatMap((path) =>
      read(path)
        .split('\n')
        .map((line, i) => [path, i + 1, line.trim()]),
    ),
  );
// The lines of SKILL.md between two headings (the first heading included, the second excluded).
const section = (skill, from, to) => {
  const lines = skillLines(skill);
  const start = lines.indexOf(from);
  const end = lines.indexOf(to, start + 1);
  assert.ok(start >= 0, `${skill}: no heading ${from}`);
  assert.ok(end > start, `${skill}: no heading ${to} after ${from}`);
  return lines.slice(start, end);
};

test('brainstorming and writing-plans take specsDir and plansDir from triqual tasks paths --json', () => {
  for (const skill of TRACKED) {
    const lines = skillLines(skill);
    assert.ok(lines.some((line) => line.includes('`triqual tasks paths --json`')), `${skill} does not run triqual tasks paths --json`);
    for (const label of ['- **Opted in**', '- **Not opted in**', '- **`triqual` missing**']) {
      assert.ok(lines.some((line) => line.startsWith(label)), `${skill} lacks the case ${label}`);
    }
    const missing = lines.find((line) => line.startsWith('- **`triqual` missing**'));
    assert.match(missing, /exit 3/, `${skill}: the triqual-missing case does not name exit 3`);
    assert.match(missing, /`PATH`/, `${skill}: the triqual-missing case does not name PATH`);
    assert.match(missing, /as not opted in/, `${skill}: triqual missing is not handled as not opted in`);
    assert.match(missing, /once/, `${skill}: triqual missing is not said once`);
    const notOptedIn = lines.find((line) => NOT_OPTED_IN.test(line));
    assert.match(notOptedIn, /`"optedIn": false`/, `${skill}: the not-opted-in case does not name optedIn false`);
    assert.match(notOptedIn, /exit 2/, `${skill}: the not-opted-in case does not name an older exit 2`);
  }
  assert.ok(skillLines('brainstorming').some((line) => line.includes('`specsDir`')), 'brainstorming does not use specsDir');
  assert.ok(skillLines('writing-plans').some((line) => line.includes('`plansDir`')), 'writing-plans does not use plansDir');
  assert.ok(
    skillLines('brainstorming').find((line) => NOT_OPTED_IN.test(line)).includes('`docs/specs/`'),
    "brainstorming's fallback does not name docs/specs/",
  );
  assert.ok(
    skillLines('writing-plans').find((line) => NOT_OPTED_IN.test(line)).includes('`docs/plans/`'),
    "writing-plans' fallback does not name docs/plans/",
  );
  const bad = trackedLines()
    .filter(([, , line]) => /docs\/(specs|plans)\//.test(line) && !NOT_OPTED_IN.test(line))
    .map(([path, n, line]) => `${path}:${n}: ${line}`);
  assert.deepEqual(bad, [], 'docs/specs/ or docs/plans/ outside the not-opted-in fallback sentence');
});

test('when not opted in neither skill creates progress.md or runs triqual tasks init', () => {
  for (const skill of TRACKED) {
    const rule = skillLines(skill).find((line) => NOT_OPTED_IN.test(line));
    assert.ok(rule, `${skill} has no not-opted-in case`);
    assert.match(rule, /never create `progress\.md`/, `${skill}: the not-opted-in case does not forbid creating progress.md`);
    assert.match(rule, /no `triqual tasks` command/, `${skill}: the not-opted-in case does not forbid triqual tasks`);
  }
  // Every other line that names `triqual tasks init` or `progress.md` is an instruction for an opted-in repo.
  const bad = trackedLines()
    .filter(([, , line]) => /triqual tasks init|progress\.md/.test(line) && !NOT_OPTED_IN.test(line))
    .filter(([, , line]) => !/\bopted in\b/i.test(line.replace(/not opted in/gi, '')))
    .map(([path, n, line]) => `${path}:${n}: ${line}`);
  assert.deepEqual(bad, [], 'triqual tasks init or progress.md named outside an opted-in instruction');
});

test('brainstorming runs triqual suggest and skips silently on exit 3', () => {
  const lines = skillLines('brainstorming');
  const i = lines.findIndex((line) => line.includes('`triqual suggest'));
  assert.ok(i >= 0, 'brainstorming does not run triqual suggest');
  assert.match(lines[i], /exit 3/, 'the triqual suggest line does not name exit 3');
  assert.match(lines[i], /silently/, 'the triqual suggest line does not skip silently');
  assert.ok(i < lines.indexOf('## Three Paths'), 'triqual suggest does not run at the start');
});

test('triqual suggest is skipped silently when triqual is not on PATH', () => {
  for (const skill of TRACKED) {
    const line = skillLines(skill).find((l) => l.includes('`triqual suggest') && /exit 3/.test(l));
    assert.ok(line, `${skill} has no triqual suggest exit-3 line`);
    for (const needle of ['`command -v triqual`', 'exit 127', '`PATH`']) {
      assert.ok(line.includes(needle), `${skill}: the triqual suggest skip does not name ${needle}`);
    }
    assert.match(line, /silently/, `${skill}: the triqual suggest skip is not silent`);
  }
});

test("brainstorming's spec commit carries the tracking files when opted in (committed mode)", () => {
  const lines = skillLines('brainstorming');
  const steps = [
    lines.find((l) => l.startsWith('6. **Write design doc**')),
    lines.find((l) => l.startsWith('- Commit the design document')),
  ];
  for (const step of steps) {
    assert.ok(step, 'a spec commit step is missing');
    for (const needle of ['`"mode": "committed"`', '`progress.md`', '`status.md`']) {
      assert.ok(step.includes(needle), `the spec commit step does not name ${needle}: ${step}`);
    }
    assert.match(step, /\bopted in\b/, `the spec commit rule is not tied to an opted-in repo: ${step}`);
  }
});

test("FORK.md registers the companion's remote branding and telemetry under Removed", () => {
  const { sections } = forkDoc();
  const find = (name) => (sections.get(name) ?? []).join('\n');
  const removed = find('Removed');
  assert.match(removed, /`brainstorming\/scripts\/server\.cjs`/, 'Removed does not name the companion server');
  assert.match(removed, /remote branding/, 'Removed does not name the remote branding');
  assert.match(removed, /telemetry/, 'Removed does not name the telemetry switch');
  assert.doesNotMatch(find('Text adaptations'), /remote branding|telemetry/, 'still listed under Text adaptations');
});

test('the spec and plan audit is always roles:final-adversarial-reviewer', () => {
  const template = 'brainstorming/spec-document-reviewer-prompt.md';
  assert.deepEqual(ROLE_HEADERS[template], [`Subagent (${AUDITOR}):`]);
  const prompt = read(template);
  assert.deepEqual(
    prompt.split('\n').flatMap(dispatchesIn).map((d) => d.type),
    [AUDITOR],
    `${template} dispatches something other than ${AUDITOR}`,
  );
  assert.match(prompt, /\bplan\b/i, `${template} does not cover the plan audit`);
  const conditional = /delegat|optional|unless|\bif\b|\bmay\b|\boffer|\bask\b/i;
  for (const skill of TRACKED) {
    const lines = skillLines(skill);
    const audit = lines.filter((line) => line.includes(AUDITOR));
    assert.ok(audit.length > 0, `${skill} does not dispatch ${AUDITOR}`);
    assert.ok(lines.some((line) => line.includes('spec-document-reviewer-prompt.md')), `${skill} does not name the template`);
    for (const line of audit) assert.doesNotMatch(line, conditional, `${skill}: the audit reads as conditional: ${line}`);
  }
  // No wording hands the audit to the user's choice, and no other reviewer is offered.
  const bad = trackedLines()
    .filter(([, , line]) => /delegat|spec-reviewer|safety-reviewer|code-reviewer|requesting-code-review/i.test(line))
    .map(([path, n, line]) => `${path}:${n}: ${line}`);
  assert.deepEqual(bad, []);
  const named = (skill) =>
    new Set(skillFiles(skill).flatMap((path) => [...read(path).matchAll(/roles:[a-z-]+/g)].map((m) => m[0])));
  assert.deepEqual([...named('brainstorming')], [AUDITOR], 'brainstorming names another role');
  const extra = [...named('writing-plans')].filter((role) => role !== AUDITOR && !TASK_ROLES.includes(role));
  assert.deepEqual(extra, [], 'writing-plans names a role that is neither the auditor nor a task role');
});

test('writing-plans ends with triqual tasks init and the progress.md/status.md registration when opted in', () => {
  const lines = skillLines('writing-plans');
  const init = lines.findIndex((line) => line.includes('`triqual tasks init <plan>`'));
  assert.ok(init >= 0, 'writing-plans does not run triqual tasks init <plan>');
  assert.match(lines[init], /\bopted in\b/i, 'triqual tasks init is not tied to an opted-in repo');
  assert.ok(init > lines.indexOf('## Self-Review'), 'triqual tasks init runs before the self-review');
  assert.ok(init < lines.indexOf('## Execution Handoff'), 'triqual tasks init runs after the execution handoff');
  const register = section('writing-plans', '## Register the Plan', '## Execution Handoff').join('\n');
  for (const name of ['`progress`', '`status`', '`progress.md`', '`status.md`']) {
    assert.ok(register.includes(name), `the registration does not name ${name}`);
  }
});

test('writing-plans in a local-mode repo drafts the plan in the OS temp dir and runs triqual tasks init --adopt', () => {
  const lines = skillLines('writing-plans');
  const adopt = lines.find((line) => line.includes('`triqual tasks init --adopt <draft>`'));
  assert.ok(adopt, 'writing-plans does not run triqual tasks init --adopt <draft>');
  assert.match(adopt, /`"mode": "local"`/, 'the adopt line is not tied to local mode');
  assert.match(adopt, /OS temp dir/, 'the draft does not go to the OS temp dir');
  const guard = lines.find((line) => line.includes('`.git/`') && /\bnever\b/i.test(line));
  assert.ok(guard, 'writing-plans does not forbid writing under .git/');
  assert.match(guard, /file tools/, 'the .git/ guard does not name the file tools');
});

// T16: in local mode the tracking files live under the git dir, where Claude Code refuses an agent's file writes, so
// the forked skills draft in the OS temp dir and land the draft with `triqual tracking write`. Committed mode is unchanged.
const ROUTED = {
  brainstorming: ['spec'],
  'writing-plans': ['plan', 'entry', 'status'],
  'subagent-driven-development': ['entry', 'status'],
  'executing-plans': ['entry', 'status'],
  'finishing-branch': ['entry', 'status'],
};

test('forked skills route local-mode tracking writes through triqual tracking write', () => {
  for (const [skill, kinds] of Object.entries(ROUTED)) {
    const lines = skillFiles(skill).flatMap((path) => read(path).split('\n').map((line) => [path, line.trim()]));
    const routed = lines.filter(([, line]) => line.includes('`triqual tracking write '));
    assert.ok(routed.length > 0, `${skill} never runs triqual tracking write`);
    for (const kind of kinds) {
      assert.ok(
        routed.some(([, line]) => line.includes(`\`triqual tracking write ${kind} <draft>`)),
        `${skill} does not land its ${kind} with triqual tracking write ${kind} <draft>`,
      );
    }
    for (const [path, line] of routed) {
      assert.match(
        line,
        /`"mode": "local"`|local mode|`"mode": "store"`|store mode/,
        `${path}: triqual tracking write outside a local-mode or store-mode rule: ${line}`,
      );
    }
    assert.ok(routed.some(([, line]) => /OS temp dir/.test(line)), `${skill}: the draft does not go to the OS temp dir`);
    const guard = lines.find(([, line]) => line.includes('`.git/`') && /\bnever\b/i.test(line) && /file tools/.test(line));
    assert.ok(guard, `${skill} does not forbid file-tool writes under .git/`);
  }
  // Every draft gets a unique temp path (parallel subagents and sessions share the temp dir): every line that lands one
  // names mktemp. A plan or spec lands under its draft's basename, so it is drafted under its final name in a
  // `mktemp -d` dir; entries and status drafts may use any name.
  const landing = /`triqual tracking write (entry|status|spec|plan) <draft>/g;
  for (const skill of Object.keys(ROUTED)) {
    for (const path of skillFiles(skill).filter((p) => p.endsWith('.md'))) {
      for (const line of read(path).split('\n')) {
        const kinds = [...line.matchAll(landing)].map((m) => m[1]);
        if (kinds.length === 0) continue;
        assert.match(line, /mktemp/, `${path}: the draft has no unique name from mktemp: ${line.trim()}`);
        assert.doesNotMatch(line, /`\/tmp`/, `${path}: the draft names a fixed /tmp path: ${line.trim()}`);
        if (kinds.some((k) => k === 'plan' || k === 'spec')) {
          assert.match(line, /mktemp -d/, `${path}: a plan or spec draft is not in a mktemp -d dir: ${line.trim()}`);
        }
      }
    }
  }
  for (const [skill, final] of [['writing-plans', '$d/YYYY-MM-DD-<feature-name>.md'], ['brainstorming', '$d/YYYY-MM-DD-<topic>-design.md']]) {
    assert.ok(read(`${skill}/SKILL.md`).includes(`\`${final}\``), `${skill} does not draft under the final name ${final}`);
  }
  // The implementer and fixer brief carries the local-mode route, since the implementer writes the task's entry.
  const tracking = read('subagent-driven-development/implementer-prompt.md');
  assert.match(tracking, /`triqual tracking write entry <draft>`/, 'the implementer Tracking section lacks triqual tracking write entry');
});

// Plan Store-2 T2: the planning and closing skills carry the store-mode rules (R1 documents, R3 entries without a commit,
// R4 status, R6 history) beside the local-mode ones, keyed on `"mode": "store"` and pointing at the reference.
// A block is a paragraph or one list item, so a rule wrapped over several lines is read whole.
const blocks = (skill) => {
  const out = [];
  let current = [];
  for (const raw of read(`${skill}/SKILL.md`).split('\n')) {
    if (raw.trim() === '' || /^\s*(?:- |\d+\. )/.test(raw)) {
      if (current.length) out.push(current.join(' '));
      current = [];
    }
    if (raw.trim() !== '') current.push(raw.trim());
  }
  if (current.length) out.push(current.join(' '));
  return out;
};
const STORE_RULE = /`"mode": "store"`|store mode/;
const storeBlocks = (skill, needle) => blocks(skill).filter((block) => block.includes(needle) && STORE_RULE.test(block));

test('brainstorming, writing-plans and finishing-branch land a store-mode entry that ends without a commit', () => {
  for (const skill of ['brainstorming', 'writing-plans', 'finishing-branch']) {
    const rule = storeBlocks(skill, '`triqual tracking add').filter((block) => block.includes('--no-commit'));
    assert.ok(rule.length > 0, `${skill}: no store-mode rule names triqual tracking add and --no-commit together`);
    assert.ok(
      blocks(skill).some((block) => STORE_RULE.test(block) && block.includes('`store-mode.md`')),
      `${skill}: no store-mode rule points at the store-mode.md reference`,
    );
  }
});

test('brainstorming and writing-plans land store-mode documents with triqual tracking write', () => {
  for (const [skill, kind] of [['brainstorming', 'spec'], ['writing-plans', 'plan']]) {
    const rule = storeBlocks(skill, `\`triqual tracking write ${kind} <draft>`);
    assert.ok(rule.length > 0, `${skill}: no store-mode rule names triqual tracking write ${kind} <draft>`);
    assert.ok(rule.some((block) => block.includes('mktemp -d')), `${skill}: the store-mode draft is not in a mktemp -d dir`);
  }
});

test('finishing-branch and writing-plans change one store-mode status section with triqual tracking status set --section', () => {
  for (const skill of ['finishing-branch', 'writing-plans']) {
    assert.ok(
      storeBlocks(skill, '`triqual tracking status set --section').length > 0,
      `${skill}: no store-mode rule names triqual tracking status set --section`,
    );
  }
});

// `triqual tasks check` accepts only --staged and parses strictly, so --plan there is a usage error (exit 2); --plan belongs
// to the ledger moves and the close. No clause of a store-mode rule may pair the check (`check`, `tasks check`) with --plan.
test('no store-mode rule of the planning and closing skills pairs the tasks check with --plan', () => {
  for (const skill of ['brainstorming', 'writing-plans', 'finishing-branch']) {
    for (const block of blocks(skill).filter((b) => STORE_RULE.test(b))) {
      for (const clause of block.split(/[.;:]\s/)) {
        assert.ok(
          !(/\bcheck\b/.test(clause) && clause.includes('--plan')),
          `${skill}: a store-mode clause pairs the check with --plan: ${clause}`,
        );
      }
    }
  }
});

test('diagnosing-methodology reads store-mode history through triqual tracking log and triqual tasks export', () => {
  const rule = storeBlocks('diagnosing-methodology', '`triqual tracking log');
  assert.ok(rule.length > 0, 'no store-mode rule names triqual tracking log');
  assert.ok(rule.some((block) => block.includes('`triqual tasks export --json`')), 'the rule does not name triqual tasks export --json');
});

// Every ledger move in the two execution skills names its plan: with several active plans, `triqual tasks` refuses a move
// without --plan, and with one it could pick another plan's ledger.
test('subagent-driven-development and executing-plans pass --plan to every triqual tasks move', () => {
  const move = /triqual tasks (?:start|review|rework|done|block|drop|reopen|restore|retitle) T[^`;\]\n]*/g;
  for (const path of ['subagent-driven-development/SKILL.md', 'executing-plans/SKILL.md']) {
    const moves = [...read(path).matchAll(move)].map((m) => m[0]);
    assert.ok(moves.length > 0, `${path} names no ledger move`);
    const bare = moves.filter((m) => !/ --plan \S/.test(m));
    assert.deepEqual(bare, [], `${path}: ledger moves without --plan`);
  }
});

test('writing-plans emits the §6.2 task format', () => {
  const block = section('writing-plans', '## Task Structure', '## What a Step Contains');
  assert.ok(block.some((line) => /^### Task N: /.test(line)), 'no `### Task N:` heading');
  assert.ok(block.includes('**Depends on:** T1, T3'), 'no `**Depends on:** T1, T3` line');
  assert.ok(block.some((line) => line.startsWith('**Skills:** ')), 'no `**Skills:**` line');
  const lines = skillLines('writing-plans');
  assert.ok(
    lines.some((line) => line.includes('`**Depends on:**`') && /\bomit/i.test(line) && /\bnone\b/i.test(line)),
    'the Depends-on line is not omitted when a task has none',
  );
  const skills = lines.find((line) => line.includes('`**Skills:**`') && line.includes('`triqual suggest'));
  assert.ok(skills, '`**Skills:**` is not tied to triqual suggest');
  assert.match(skills, /exit 3/, 'the Skills line does not skip on exit 3');
});

test('writing-plans assigns a **Role:** to every task', () => {
  const block = section('writing-plans', '## Task Structure', '## What a Step Contains');
  assert.ok(block.includes('**Role:** roles:tdd-implementer'), 'the task template has no `**Role:**` line');
  const lines = skillLines('writing-plans');
  const rule = section('writing-plans', '## Task Roles', '## Task Structure');
  const text = rule.join('\n');
  assert.ok(lines.some((line) => line.includes('`**Role:**`') && /every task/i.test(line)), 'no Role for every task');
  for (const role of [...TASK_ROLES, 'coordinator']) assert.ok(text.includes(`\`${role}\``), `the rule lacks ${role}`);
  for (const role of TASK_ROLES) assert.ok(ROLE_AGENTS.has(role), `${role} is not an agent of plugin roles`);
  const line = (needle) => rule.find((l) => l.includes(needle)) ?? '';
  assert.match(line('`roles:tdd-implementer`'), /default/i, 'roles:tdd-implementer is not the default');
  assert.match(line('`roles:review-fixer`'), /fix/i, 'the rule for roles:review-fixer is not named');
  for (const word of [/multi-system/i, /live state/i, /costly/i]) {
    assert.match(line('`roles:complex-implementer`'), word, `the complex-implementer rule does not name ${word}`);
  }
  for (const word of [/probe/i, /rollout/i, /checkpoint/i]) {
    assert.match(line('`coordinator`'), word, `the coordinator rule does not name ${word}`);
  }
  assert.ok(rule.some((l) => /reviewer roles/i.test(l) && /\bnever\b/i.test(l)), 'reviewer roles are not excluded');
});

test("writing-plans' header names methodology:subagent-driven-development", () => {
  const header = skillLines('writing-plans').find((line) => line.startsWith('> **For agentic workers:**'));
  assert.ok(header, 'no plan header line for agentic workers');
  assert.ok(header.includes('methodology:subagent-driven-development'), header);
  assert.ok(header.includes('methodology:executing-plans'), header);
});

// Spawned children: a temp HOME, no XDG_CONFIG_HOME, and no variable that steers the companion.
const companionEnv = (extra = {}) => {
  const env = { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'fork-home-')), ...extra };
  delete env.XDG_CONFIG_HOME;
  delete env.CODEX_CI;
  for (const key of Object.keys(env)) {
    if (/^BRAINSTORM_|TELEMETRY|^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC$/.test(key) && !(key in extra)) delete env[key];
  }
  return env;
};
const SCRIPTS = join(SKILLS, 'brainstorming', 'scripts');

test('the visual companion stores sessions under .methodology/brainstorm/ and ensures .methodology/.gitignore', () => {
  const project = mkdtempSync(join(tmpdir(), 'fork-companion-'));
  const env = companionEnv();
  let sessionDir = null;
  try {
    const r = spawnSync('bash', [join(SCRIPTS, 'start-server.sh'), '--project-dir', project, '--background'], {
      env,
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const info = JSON.parse(r.stdout.trim().split('\n').at(-1));
    sessionDir = dirname(info.screen_dir);
    assert.ok(
      info.screen_dir.startsWith(join(project, '.methodology', 'brainstorm') + sep),
      `screen_dir ${info.screen_dir} is not under .methodology/brainstorm/`,
    );
    assert.equal(readFileSync(join(project, '.methodology', '.gitignore'), 'utf8'), '*\n');
    assert.ok(read('brainstorming/visual-companion.md').includes('.methodology/brainstorm/'), 'the guide does not name it');
  } finally {
    if (sessionDir) spawnSync('bash', [join(SCRIPTS, 'stop-server.sh'), sessionDir], { env, timeout: 20000 });
    rmSync(project, { recursive: true, force: true });
    rmSync(env.HOME, { recursive: true, force: true });
  }
});

test('server.cjs renders no remote branding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fork-server-'));
  const token = randomBytes(32).toString('hex');
  const env = companionEnv({ BRAINSTORM_DIR: dir, BRAINSTORM_TOKEN: token, BRAINSTORM_HOST: '127.0.0.1' });
  const child = spawn(process.execPath, [join(SCRIPTS, 'server.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 10000);
      child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'server-started') {
            clearTimeout(timer);
            resolve(event);
          }
        } catch {
          /* not an event line */
        }
      });
    });
    const page = async () => {
      const res = await fetch(`http://127.0.0.1:${info.port}/`, {
        headers: { cookie: `brainstorm-key-${info.port}=${token}` },
      });
      assert.equal(res.status, 200);
      return res.text();
    };
    const pages = [await page()];
    writeFileSync(join(info.screen_dir, 'choice.html'), '<h2>Pick one</h2>');
    pages.push(await page());
    assert.match(pages[1], /Pick one/, 'the fragment was not served in the frame');
    for (const html of pages) {
      const hosts = [...html.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^\s'"`<>)\/:?#]*)/gi)]
        .map((m) => m[1])
        .filter((host) => host && !LOOPBACK_HOSTS.has(host.toLowerCase()));
      assert.deepEqual(hosts, [], 'the page names a remote host');
      assert.doesNotMatch(html, /<img\b/i, 'the page loads an image');
      assert.doesNotMatch(html, /superpowers|prime radiant/i, 'the page carries upstream branding');
    }
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
    rmSync(env.HOME, { recursive: true, force: true });
  }
});

// Keep this test last: it reads what the PENDING cases above recorded.
test('PENDING lists only skills that still fail a case', () => {
  const done = [...PENDING].filter((skill) => {
    const record = pendingRuns.get(skill);
    return record && record.ran > 0 && record.failed === 0;
  });
  assert.deepEqual(done, [], `every case passes; remove it from PENDING: ${done.join(', ')}`);
});

// ---- role tiers v2: the safety shadow is retired, the complex implementer is a role -----------------------------------

test('no skill file names the retired safety shadow, apart from the SDD Record rule that says it is no longer written', () => {
  const live = skillDirs().flatMap((skill) => skillFiles(skill))
    .flatMap((path) => read(path).split('\n').map((line, i) => [path, i + 1, line]))
    .filter(([, , line]) => /safety[- ]shadow|\bthe shadow\b|shadow-candidates/i.test(line))
    .filter(([path, , line]) => !(path === 'subagent-driven-development/SKILL.md'
      && line.includes('No `safety-shadow` record is written any more')))
    .map(([path, n, line]) => `${path}:${n}: ${line.trim()}`);
  assert.deepEqual(live, []);
});

test('dispatching-parallel-agents offers every role agent, the complex implementer included', () => {
  const text = read('dispatching-parallel-agents/SKILL.md');
  const rows = text.split('\n').filter((line) => /^\| .+ \| `roles:[a-z-]+` \|$/.test(line));
  const offered = new Set(rows.map((row) => /`(roles:[a-z-]+)`/.exec(row)[1]));
  assert.deepEqual([...offered].sort(), [...ROLE_AGENTS].sort());
  const complex = rows.find((row) => row.includes('`roles:complex-implementer`'));
  assert.match(complex, /multi-system|live state|costly/i, complex);
});
