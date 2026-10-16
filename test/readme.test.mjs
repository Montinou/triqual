import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../plugins/methodology/cli/lib/brand.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const version = (name) => JSON.parse(readFileSync(join(ROOT, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8')).version;

test('README plugins table carries the current plugin versions', () => {
  for (const name of ['methodology', 'progress-tracking', 'workflow-gate', 'roles', 'memory-report']) {
    assert.match(README, new RegExp(`\\| \`${name}\` \\| ${version(name).replace(/\./g, '\\.')} \\|`), name);
  }
});

test('README names the eight roles', () => {
  const row = README.split('\n').find((line) => line.startsWith('| `roles` |'));
  assert.ok(row, 'roles row');
  const shipped = readdirSync(join(ROOT, 'plugins', 'roles', 'agents')).filter((f) => f.endsWith('.md'));
  assert.equal(shipped.length, 8);
  for (const file of shipped) assert.ok(row.includes(`\`${file.slice(0, -3)}\``), file);
  assert.match(row, /Eight role agents/);
  assert.doesNotMatch(row, /safety-shadow/);
  assert.doesNotMatch(row, /Six role agents/);
  assert.doesNotMatch(row, /\bsix\b/i);
});

test('README gives the Codex routing of the role tiers, with no safety shadow', () => {
  const rows = README.split('\n').map((line) => line.trim()).filter((line) => /^\| `[a-z-]+`.*\| `gpt-/.test(line));
  assert.deepEqual(rows, [
    '| `hunter`, `brief-writer`, `safety-reviewer` | `gpt-6-luna` | `medium` |',
    '| `tdd-implementer`, `review-fixer` | `gpt-6.1-sol` | `low` |',
    '| `spec-reviewer`, `complex-implementer` | `gpt-6.1-sol` | `high` |',
    '| `final-adversarial-reviewer` | `gpt-6-astra` | `medium` |',
  ]);
  assert.doesNotMatch(README, /roles:safety-shadow|`safety-shadow`,|the safety shadow\)/);
  const roleEval = README.split('\n').find((line) => line.startsWith('| `triqual role-eval '));
  assert.ok(roleEval, 'triqual role-eval row');
  assert.match(roleEval, /retired `safety-shadow` kind/);
  assert.match(roleEval, /stored before/);
});

test('README lists triqual memory in the commands table', () => {
  assert.ok(README.split('\n').some((line) => line.startsWith('| `triqual memory ')), 'triqual memory row');
});

test('README lists every task role in the triqual tasks row, roles:complex-implementer included', () => {
  const row = README.split('\n').find((line) => line.startsWith('| `triqual tasks <subcommand>` |'));
  assert.ok(row, 'triqual tasks row');
  assert.ok(row.includes("A task's role is its plan `**Role:**` line (`coordinator`, `roles:tdd-implementer` by default, "
    + '`roles:complex-implementer` or `roles:review-fixer`); `check` flags any other.'), row);
});

test('README documents triqual tasks, triqual ui and the status-line snippet', () => {
  assert.match(README, /\| `triqual tasks /);
  assert.match(README, /\| `triqual ui \[--port N\] \[--open\]` \|/);
  assert.ok(README.includes('seg=$(command -v triqual >/dev/null && triqual tasks line 2>/dev/null)'));
  assert.doesNotMatch(README, /`triqual tasks`[^\n]*arrive in later releases/);
  assert.match(README, /`triqual suggest` arrives in a later release/);
  assert.doesNotMatch(README, /`triqual upstream-diff` arrives? in (a )?later release/);
  assert.match(README, /git 2\.31/);
  assert.match(README, /--separate-git-dir/);
});

test('README describes triqual doctor --repo as it is, and bare dotfile repos under local mode', () => {
  const row = README.split('\n').find((line) => line.startsWith('| `triqual doctor [--repo]` |'));
  assert.ok(row, 'doctor row');
  assert.doesNotMatch(row, /in a repo with `progress\.md`/);
  assert.match(row, /local mode/);
  assert.match(row, /`triqual tasks check`/);
  assert.match(README, /--bare[^\n]*\n?[^\n]*work[- ]tree/);
});

test('README documents triqual --help and triqual <command> --help', () => {
  const section = README.slice(README.indexOf('## `triqual` commands'));
  assert.match(section, /`triqual --help`/);
  assert.match(section, /`triqual <command> --help`/);
  assert.match(section, /`triqual help <command>`/);
});

test('README says older installs show only descriptions in the full help', () => {
  const section = README.slice(README.indexOf('## `triqual` commands'));
  assert.match(section, /older installs[^.]*only (the )?descriptions?[^.]*until[^.]*updated/i);
});

test('README lists triqual upstream-diff as available and triqual sync with superpowers@* and keepSuperseded', () => {
  const upstream = README.split('\n').find((line) => line.startsWith('| `triqual upstream-diff <version>'));
  assert.ok(upstream, 'upstream-diff row');
  for (const flag of ['--from', '--skill', '--patch', '--mark-reviewed']) assert.ok(upstream.includes(flag), flag);
  const sync = README.split('\n').find((line) => line.startsWith('| `triqual sync` |'));
  assert.ok(sync, 'sync row');
  assert.doesNotMatch(sync, /none in 0\.1\.0/);
  assert.match(sync, /`superpowers@\*`/);
  assert.match(sync, /keepSuperseded/);
});

test('README doctor row mentions the project-scope superseded warning and the unsplit fix', () => {
  const row = README.split('\n').find((line) => line.startsWith('| `triqual doctor [--repo]` |'));
  assert.match(row, /`\.claude\/settings\.json`/);
  assert.match(row, /`\.claude\/settings\.local\.json`/);
  assert.match(row, /split, then rerun \/methodology:setup/);
});

test('README documents triqual tracking write and the allow rule bootstrap offers', () => {
  const row = README.split('\n').find((line) => line.startsWith('| `triqual tracking write <entry\\|status\\|spec\\|plan> <draft> [--replace]` |'));
  assert.ok(row, 'triqual tracking write row');
  assert.match(row, /local mode/);
  assert.match(row, /lock/);
  assert.ok(README.includes('`Bash(triqual tracking:*)`'), 'the allow rule');
  const steps = README.slice(README.indexOf('node bin/bootstrap.mjs'), README.indexOf('Runs `triqual doctor`'));
  assert.match(steps, /`Bash\(triqual tracking:\*\)`[\s\S]{0,120}after asking/, 'bootstrap adds the rule after asking');
  // An existing narrow rule is kept and no longer counts as covering.
  assert.match(steps, /`Bash\(triqual tracking write:\*\)`[^\n]*(kept|stays)/);
  assert.match(steps, /`Bash\(triqual:\*\)`/);
});

test('README names the three tracking modes, store mode, its data directory and the Node 22.13 floor', () => {
  for (const text of ['`triqual progress-init --store`', '`triqual tracking add', '`triqual tracking status', '`triqual tracking log',
    'Node 22.13']) {
    assert.ok(README.includes(text), text);
  }
  assert.doesNotMatch(README, /Node 20/);
  assert.match(README, /committed, local and store/i);
  const start = README.indexOf('### Store mode');
  assert.ok(start !== -1, 'a Store mode section');
  const next = README.indexOf('\n##', start + 1);
  const section = README.slice(start, next === -1 ? undefined : next);
  assert.ok(section.includes('~/.local/share/triqual/tracking.db'), 'the default database path');
  assert.ok(section.includes('`XDG_DATA_HOME`'), 'XDG_DATA_HOME');
  assert.ok(section.includes('`TRIQUAL_TRACKING_DB`'), 'the override');
  assert.ok(section.includes('`backups/`'), 'the daily backups');
  assert.match(section, /Node 22\.13/);
  assert.match(section, /node:sqlite/);
  assert.match(section, /triqual tracking restore/);
  // export writes JSONL, which only import reads; restore takes a SQLite snapshot from backups/.
  assert.match(section, /tracking export` writes[^.]*JSONL/);
  assert.match(section, /tracking import\s+--replace --from <file>/);
  assert.match(section, /tracking restore <snapshot>` takes[^.]*`backups\/tracking-\*\.db`/);
  assert.doesNotMatch(section, /writes a snapshot/);
});

test('README lists the store-mode views in the commands table', () => {
  const rows = README.split('\n').filter((line) => line.startsWith('| `triqual tracking '));
  for (const text of ['triqual tracking add <draft>', 'triqual tracking status [--json]',
    'triqual tracking log [--last N]']) {
    assert.ok(rows.some((r) => r.startsWith(`| \`${text}`)), text);
  }
  const progressInit = README.split('\n').find((line) => line.startsWith('| `triqual progress-init '));
  assert.ok(progressInit.includes('--store'), 'progress-init row names --store');
  const doctor = README.split('\n').find((line) => line.startsWith('| `triqual doctor [--repo]` |'));
  assert.match(doctor, /store mode/);
});

test('README has a Codex and Grok section: setup, the one trust approval, the split, removal, Grok limits', () => {
  const start = README.indexOf('## Codex and Grok');
  assert.ok(start !== -1, 'Codex and Grok section');
  const next = README.indexOf('\n## ', start + 1);
  const section = README.slice(start, next === -1 ? undefined : next);
  // What bootstrap sets up.
  for (const text of ['`--yes`', '`~/.local/bin/triqual-hook`', '`methodology-codex`', '`~/.codex/skills/`', '`~/.codex/agents/`',
    '`project_doc_fallback_filenames`', '`~/.grok/hooks/triqual.json`', '`~/.grok/rules/triqual.md`']) {
    assert.ok(section.includes(text), text);
  }
  assert.match(section, /stale Grok[^.]*backed up/i, 'stale Grok plugin cleanup with a backup');
  // The one Codex trust approval: approved by the user in Codex, never written or bypassed by us.
  assert.match(section, /trust prompt/);
  assert.match(section, /never write[^.]*trust/i);
  assert.match(section, /never bypass/i);
  // The one-time split: never automatic, preview and confirm on a terminal, skipped under --yes.
  assert.ok(section.includes('`~/.codex/AGENTS.md`'), 'AGENTS.md');
  assert.ok(section.includes('`triqual sync --harness codex`'), 'the split command');
  assert.match(section, /one-time split/i);
  assert.match(section, /preview/);
  // Removal.
  assert.ok(section.includes('`triqual sync --remove-harness <id>`'), 'remove-harness');
  assert.ok(section.includes('`--restore-agents-md`'), 'restore-agents-md');
  // Grok limits and secrets.
  assert.match(section, /named agent/);
  assert.match(section, /stop and ask/);
  assert.match(section, /Claude compatibility/);
  assert.match(section, /`~\/\.grok\/config\.toml` is never read/);
  assert.match(section, /never backed up whole/);
  // No machine-specific values.
  assert.doesNotMatch(section, /\/Users\/|\/home\/[a-z]/);
});

test('README names the memory-report entry kinds and triqual memory repos', () => {
  const row = README.split('\n').find((line) => line.startsWith('| `memory-report` |'));
  assert.ok(row, 'memory-report row');
  for (const text of ['repositories', 'owners', '`github.com/acme/app`', '`github.com/acme/*`']) assert.ok(row.includes(text), text);
  const commands = README.split('\n').find((line) => line.startsWith('| `triqual memory '));
  assert.ok(commands.includes('repos [--json]'), 'triqual memory repos [--json]');
});

test('README gives never-send the same entry kinds, in both the commands row and the memory-report row', () => {
  const commands = README.split('\n').find((line) => line.startsWith('| `triqual memory '));
  assert.ok(commands.includes('`never <entry>…` / `unnever <entry>…`'), 'never <entry>');
  assert.doesNotMatch(commands, /`never <project>|`unnever <project>|projects that are never sent/);
  assert.ok(commands.includes('`allow`, `deny`, `never` and `unnever` take the same three entry kinds'), 'the three kinds');
  const row = README.split('\n').find((line) => line.startsWith('| `memory-report` |'));
  assert.ok(row.includes('the never-send list takes the same three kinds'), 'the memory-report row');
});

test('README is titled Triqual and documents the migration, the new install names and the deprecated cm names', () => {
  assert.match(README, /^# Triqual$/m);
  assert.ok(README.includes('claude plugin install memory-report@triqual'));
  assert.ok(README.includes('`methodology@triqual`'));
  assert.ok(README.includes('## Moving from the previous name'));
  assert.ok(README.includes('`triqual migrate`'));
  const steps = README.slice(README.indexOf('node bin/bootstrap.mjs'), README.indexOf('Runs `triqual doctor`'));
  assert.match(steps, /2\. Runs `triqual migrate`/);
  assert.ok(steps.includes('`~/.local/bin/triqual-hook`') && steps.includes('deprecated `cm` alias'));
});

test('README opens with what Triqual is, a quick start and what bootstrap changes, before the plugins table', () => {
  const at = (heading) => README.indexOf(heading);
  assert.ok(at('## Quick start') > 0 && at('### What `bootstrap` changes on your machine') > at('## Quick start'));
  assert.ok(at('## Plugins') > at('### What `bootstrap` changes on your machine'), 'the front matter comes before the plugins table');
  const intro = README.slice(0, at('## Quick start'));
  for (const plugin of ['methodology', 'progress-tracking', 'roles', 'workflow-gate', 'memory-report']) {
    assert.ok(intro.includes(`(\`${plugin}\``), `the front matter names ${plugin}`);
  }
  const quick = README.slice(at('## Quick start'), at('### What `bootstrap` changes on your machine'));
  // The quick start is the marketplace path, in this order, with no clone.
  const commands = ['/plugin marketplace add Montinou/triqual', '/plugin install methodology@triqual', '/methodology:setup', '/reload-plugins'];
  const positions = commands.map((command) => quick.indexOf(command));
  assert.ok(positions.every((position) => position !== -1), `the quick start has ${commands.join(', ')}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'the quick-start commands are in order');
  assert.ok(!quick.includes('git clone'), 'the quick start has no git clone');
  assert.ok(!quick.includes('node bin/bootstrap.mjs'), 'the quick start does not run bootstrap from a clone');
  assert.ok(quick.includes('Node 22.13'));
  // The clone and bootstrap are the full setup, in Install, and say what only they add.
  const install = README.slice(at('## Install'), at('## `triqual` commands'));
  assert.ok(install.includes('git clone https://github.com/') && install.includes('node bin/bootstrap.mjs'));
  assert.ok(install.indexOf('git clone https://github.com/') < install.indexOf('node bin/bootstrap.mjs'));
  assert.match(install, /full setup/i);
  assert.match(install, /Codex/);
  assert.match(install, /Grok/);
  assert.match(install, /`language`/);
  assert.ok(README.indexOf('node bin/bootstrap.mjs') > at('## Install'), 'the first node bin/bootstrap.mjs is in Install');
  const changes = README.slice(at('### What `bootstrap` changes on your machine'), at('## Plugins'));
  for (const touched of ['~/.local/bin/', '~/.claude/CLAUDE.md', '~/.claude/settings.json', '~/.claude/backups/']) {
    assert.ok(changes.includes(touched), `names ${touched}`);
  }
  assert.ok(changes.includes('/methodology:setup'), 'names the command whose changes it lists');
});

test('CONTRIBUTING.md and SECURITY.md exist, link each other and are published by the export manifest', () => {
  const contributing = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
  const security = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8');
  assert.match(contributing, /^# Contributing to Triqual$/m);
  assert.ok(contributing.includes('[SECURITY.md](SECURITY.md)') && contributing.includes('npm test'));
  assert.ok(contributing.includes('Node 22.13'), 'the Node floor matches the README');
  assert.match(security, /^# Security policy$/m);
  assert.ok(security.includes('Report a\nvulnerability') || security.includes('Report a vulnerability'), 'names the private reporting path');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'public-export.json'), 'utf8'));
  for (const file of ['CONTRIBUTING.md', 'SECURITY.md']) assert.ok(manifest.include.includes(file), `${file} is in the export manifest`);
});

test('README lists headjack as an optional external plugin', () => {
  const row = README.split('\n').find((line) => line.startsWith('| `headjack` | external |'));
  assert.ok(row, 'headjack row');
  for (const text of ['claude plugin install headjack@triqual', 'Node 22.16', '2.1.275', 'https://github.com/Montinou/headjack',
    '~/.local/bin', 'clone', 'not from the installed plugin']) {
    assert.ok(row.includes(text), text);
  }
  assert.doesNotMatch(row, /0\.1\.0/);
});

test('README states that the push consent also covers marking the PRs ready for review after the final review', () => {
  const text = README.replace(/\s+/g, ' ');
  const consent = text.slice(text.indexOf('Since 0.6.0 the methodology executes a plan as a stack'), text.indexOf('## Quick start'));
  assert.match(consent, /open and update draft PRs and mark them ready for review after the final review/);
  assert.match(consent, /authorizes that push of the plan's phase branches and draft PRs, and marking them ready for review after the final review, nothing else/);
});

test('README and CONTRIBUTING say development happens in the public repository, name the maintainer hooks and carry no private name', () => {
  const contributing = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
  // The forbidden names are built at runtime: the export rewrites the private slug to the public one in every tracked file, so
  // neither BRAND.source (public after the rewrite) nor a literal here may stand for the private name.
  const forbidden = [['triqual', 'private'].join('-'), BRAND.legacy.marketplace];
  for (const [name, text] of [['README', README], ['CONTRIBUTING', contributing]]) {
    const flat = text.replace(/\s+/g, ' ');
    // The public slug must stand alone: `Montinou/triqual` does not satisfy it.
    assert.match(flat, /Montinou\/triqual(?![\w-])/, `${name} names the public repository`);
    assert.match(flat, /development happens in this (public )?repository/i, `${name}: development happens here`);
    assert.match(flat, /pull requests? from outside[^.]*welcome|outside (contributors|pull requests?)[^.]*welcome/i, `${name}: outside pull requests are welcome`);
    assert.ok(flat.includes('node bin/install-hooks.mjs') && flat.includes('triqual progress-init --store'), `${name}: the hooks install`);
    assert.ok(flat.includes('node bin/lib/content-gate.mjs --all'), `${name}: the full gate run after a deny-list change`);
    assert.match(flat, /noreply/, `${name}: the public noreply identity`);
    assert.match(flat, /Update branch/, `${name}: the Update branch merge commit`);
    for (const term of forbidden) assert.ok(!text.includes(term), `${name}: no private or legacy name (${term})`);
  }
  assert.doesNotMatch(contributing, /published from a private/);
});
