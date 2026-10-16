import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { drift, sessionContext } from '../cli/drift.mjs';
import { MARKERS } from '../cli/lib/fsx.mjs';
import { expectedRules, harnessPaths } from '../cli/lib/harnesses.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GLOBAL = readFileSync(join(PLUGIN_ROOT, 'rules', 'global.md'), 'utf8');
const SUPERSEDED = 'superpowers@superpowers-marketplace';
const RULES_NOTICE = 'global rules out of date: run `triqual sync`';
const PLUGIN_NOTICE = `superseded plugin still enabled: ${SUPERSEDED} — run \`triqual sync\``;
const current = (body = GLOBAL.trim()) => `# Machine\n\n${MARKERS.start}\n${body}\n${MARKERS.end}\n`;

// cli: write ~/.local/bin/triqual.mjs, the installed CLI; without it sessionContext gives the setup notice instead.
function withHome(fn, { claudeMd = current(), settings = '{}\n', cli = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cm-drift-'));
  try {
    mkdirSync(join(home, '.claude'));
    if (cli) {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      writeFileSync(join(home, '.local', 'bin', 'triqual.mjs'), '// The `triqual` shim.\n');
    }
    if (claudeMd !== null) writeFileSync(join(home, '.claude', 'CLAUDE.md'), claudeMd);
    if (settings !== null) writeFileSync(join(home, '.claude', 'settings.json'), settings);
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function withPluginCopy(supersedes, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-plugin-'));
  try {
    const root = join(dir, 'methodology');
    cpSync(PLUGIN_ROOT, root, { recursive: true });
    writeFileSync(join(root, 'rules', 'manifest.json'), JSON.stringify({ version: 1, supersedes }) + '\n');
    return fn(root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('drift returns null when the section equals global.md', () => {
  withHome((home) => {
    assert.equal(drift({ home, pluginRoot: PLUGIN_ROOT }), null);
  });
});

test('drift reports out-of-date rules when the section is missing', () => {
  withHome((home) => {
    assert.ok(drift({ home, pluginRoot: PLUGIN_ROOT }).includes(RULES_NOTICE));
  }, { claudeMd: '# Machine\n' });
});

test('drift reports out-of-date rules when the section differs', () => {
  withHome((home) => {
    assert.ok(drift({ home, pluginRoot: PLUGIN_ROOT }).includes(RULES_NOTICE));
  }, { claudeMd: current('## Old rules') });
});

test('drift reports a superseded plugin that is still enabled', () => {
  withPluginCopy([SUPERSEDED], (pluginRoot) => {
    withHome((home) => {
      const notice = drift({ home, pluginRoot });
      assert.ok(notice.includes(PLUGIN_NOTICE));
      assert.equal(notice.includes(RULES_NOTICE), false);
    }, { settings: JSON.stringify({ enabledPlugins: { [SUPERSEDED]: true } }) });
    withHome((home) => {
      assert.equal(drift({ home, pluginRoot }), null);
    }, { settings: JSON.stringify({ enabledPlugins: { [SUPERSEDED]: false } }) });
  });
});

test('drift never throws on missing or broken files', () => {
  withPluginCopy([SUPERSEDED], (pluginRoot) => {
    withHome((home) => {
      assert.ok(drift({ home, pluginRoot }).includes(RULES_NOTICE));
    }, { claudeMd: null });
    withHome((home) => {
      assert.equal(drift({ home, pluginRoot }), null);
    }, { settings: null });
    withHome((home) => {
      assert.equal(drift({ home, pluginRoot }), null);
    }, { settings: '{ not json' });
    withHome((home) => {
      assert.ok(drift({ home, pluginRoot }).includes(RULES_NOTICE));
    }, { claudeMd: `${MARKERS.start}\nunterminated\n`, settings: '{ not json' });
  });
  assert.doesNotThrow(() => drift({ home: join(tmpdir(), 'cm-drift-missing-home'), pluginRoot: join(tmpdir(), 'nope') }));
});

// On resume with superpowers disabled (and no keepSuperseded), the one line that tells a resumed pre-rollout session which
// skills are active (spec Addendum E.3).
const RESUME_NOTE = 'triqual: methodology skills are active (methodology:using-methodology); superpowers is disabled';

test('drift.mjs as a hook on resume prints the drift lines, or the resume note, and exits 0', () => {
  const cli = join(PLUGIN_ROOT, 'cli', 'drift.mjs');
  // Never log into a real plugin data dir, and never reach the real config through XDG_CONFIG_HOME.
  const { CLAUDE_PLUGIN_DATA: _, XDG_CONFIG_HOME: __, ...env } = process.env;
  const run = (home) => spawnSync(process.execPath, [cli], {
    env: { ...env, HOME: home }, input: '{"hook_event_name":"SessionStart","source":"resume"}', encoding: 'utf8',
  });
  withHome((home) => {
    const r = run(home);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, RESUME_NOTE);
  });
  withHome((home) => {
    const r = run(home);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(out.hookSpecificOutput.additionalContext.includes(RULES_NOTICE));
  }, { claudeMd: `${MARKERS.start}\nbroken\n`, settings: '{ not json' });
});

test('hooks.json registers drift.mjs on SessionStart', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks, {
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|resume|clear|compact',
          hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/cli/drift.mjs"', timeout: 10 }],
        },
      ],
    },
  });
});

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z drift: .+$/;

test('drift logs a swallowed error as one line in <dataDir>/log, and returns the same notice', () => {
  const data = mkdtempSync(join(tmpdir(), 'cm-drift-data-'));
  try {
    withPluginCopy([SUPERSEDED], (pluginRoot) => {
      withHome((home) => {
        assert.equal(drift({ home, pluginRoot, dataDir: join(data, 'nested') }), null);
        const log = readFileSync(join(data, 'nested', 'log'), 'utf8');
        const lines = log.trimEnd().split('\n');
        assert.equal(lines.length, 1, log);
        assert.match(lines[0], LOG_LINE);
        assert.match(lines[0], /JSON/);
      }, { settings: '{ not json' });
    });
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test('drift logs nothing for a missing file, nor without a data dir, and never throws when logging fails', () => {
  const data = mkdtempSync(join(tmpdir(), 'cm-drift-data-'));
  try {
    withPluginCopy([SUPERSEDED], (pluginRoot) => {
      withHome((home) => {
        assert.equal(drift({ home, pluginRoot, dataDir: data }), null);
        assert.equal(existsSync(join(data, 'log')), false);
      }, { settings: null });
      withHome((home) => {
        assert.equal(drift({ home, pluginRoot }), null);
        // The data dir path runs through a regular file: mkdir and append both fail.
        writeFileSync(join(data, 'file'), '');
        assert.equal(drift({ home, pluginRoot, dataDir: join(data, 'file', 'sub') }), null);
      }, { settings: '{ not json' });
    });
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test('drift.mjs as a hook logs to ${CLAUDE_PLUGIN_DATA}/log and still exits 0', () => {
  const data = mkdtempSync(join(tmpdir(), 'cm-drift-data-'));
  try {
    withHome((home) => {
      const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'cli', 'drift.mjs')], {
        env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: data }, input: '{"source":"resume"}', encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '');
      assert.match(readFileSync(join(data, 'log'), 'utf8').trimEnd(), LOG_LINE);
    }, { settings: '{ not json' });
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

// SessionStart entry point (spec Addendum E.3): drift lines, then the wrapped using-methodology on
// startup/clear/compact; drift lines only on resume.
const SKILL_PATH = join('skills', 'using-methodology', 'SKILL.md');
const SKILL_TEXT = readFileSync(join(PLUGIN_ROOT, SKILL_PATH), 'utf8').replace(/\n+$/, '');
const WRAPPED = (skillText) => `<EXTREMELY_IMPORTANT>\nYou have the methodology skills.\n\n**Below is the full content of your 'methodology:using-methodology' skill - your introduction to using skills. For all other skills, use the 'Skill' tool:**\n\n${skillText}\n</EXTREMELY_IMPORTANT>`;
const BOTH_DRIFT = { claudeMd: '# Machine\n', settings: JSON.stringify({ enabledPlugins: { [SUPERSEDED]: true } }) };

function runHook(pluginRoot, home, input, extraEnv = {}) {
  // Never log into a real plugin data dir, and never reach the real config through XDG_CONFIG_HOME.
  const { CLAUDE_PLUGIN_DATA: _, XDG_CONFIG_HOME: __, ...env } = process.env;
  return spawnSync(process.execPath, [join(pluginRoot, 'cli', 'drift.mjs')], {
    env: { ...env, HOME: home, ...extraEnv }, input, encoding: 'utf8',
  });
}
const contextOf = (r) => {
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  return out.hookSpecificOutput.additionalContext;
};

test('startup injects the drift lines then the wrapped using-methodology', () => {
  withPluginCopy([SUPERSEDED], (pluginRoot) => {
    withHome((home) => {
      const lines = drift({ home, pluginRoot });
      assert.ok(lines.includes(RULES_NOTICE) && lines.includes(PLUGIN_NOTICE));
      for (const source of ['startup', 'clear', 'compact']) {
        assert.equal(sessionContext({ home, pluginRoot, source }), `${lines}\n\n${WRAPPED(SKILL_TEXT)}`, source);
      }
      const r = runHook(pluginRoot, home, JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }));
      assert.equal(contextOf(r), `${lines}\n\n${WRAPPED(SKILL_TEXT)}`);
    }, BOTH_DRIFT);
    withHome((home) => {
      assert.equal(sessionContext({ home, pluginRoot, source: 'startup' }), WRAPPED(SKILL_TEXT));
      const r = runHook(pluginRoot, home, JSON.stringify({ hook_event_name: 'SessionStart', source: 'clear' }));
      assert.equal(contextOf(r), WRAPPED(SKILL_TEXT));
      // No readable source: the skill is injected, as on startup (only resume leaves it out).
      for (const input of ['{}', 'not json', '']) assert.equal(contextOf(runHook(pluginRoot, home, input)), WRAPPED(SKILL_TEXT));
    });
  });
});

test('resume injects the drift lines, never the skill, and the resume note once superpowers is disabled', () => {
  const resume = JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume' });
  withPluginCopy([SUPERSEDED], (pluginRoot) => {
    // A superseded plugin still enabled: its drift line, no note.
    withHome((home) => {
      assert.equal(sessionContext({ home, pluginRoot, source: 'resume' }), drift({ home, pluginRoot }));
      const context = contextOf(runHook(pluginRoot, home, resume));
      assert.equal(context, drift({ home, pluginRoot }));
      assert.equal(context.includes('EXTREMELY_IMPORTANT'), false);
      assert.equal(context.includes(RESUME_NOTE), false);
    }, BOTH_DRIFT);
    // Superpowers disabled: the note alone, or after the rules drift line.
    withHome((home) => {
      assert.equal(sessionContext({ home, pluginRoot, source: 'resume' }), RESUME_NOTE);
      assert.equal(contextOf(runHook(pluginRoot, home, resume)), RESUME_NOTE);
    });
    withHome((home) => {
      assert.equal(sessionContext({ home, pluginRoot, source: 'resume' }), `triqual: ${RULES_NOTICE}\n\n${RESUME_NOTE}`);
    }, { claudeMd: '# Machine\n', settings: JSON.stringify({ enabledPlugins: { [SUPERSEDED]: false } }) });
    // Settings that cannot be read say nothing about superpowers: no note.
    withHome((home) => {
      assert.equal(sessionContext({ home, pluginRoot, source: 'resume' }), null);
    }, { settings: '{ not json' });
    // Startup, clear and compact carry the skill instead, never the note.
    withHome((home) => {
      for (const source of ['startup', 'clear', 'compact']) {
        assert.equal(sessionContext({ home, pluginRoot, source }), WRAPPED(SKILL_TEXT), source);
      }
    });
  });
  // A manifest that supersedes nothing: nothing to say on resume.
  withPluginCopy([], (pluginRoot) => {
    withHome((home) => {
      assert.equal(sessionContext({ home, pluginRoot, source: 'resume' }), null);
      const r = runHook(pluginRoot, home, resume);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '');
    });
  });
});

test('total stays under 9500 characters with both drift lines present', () => {
  withPluginCopy([SUPERSEDED], (pluginRoot) => {
    withHome((home) => {
      const context = sessionContext({ home, pluginRoot, source: 'startup' });
      assert.ok(context.includes(RULES_NOTICE) && context.includes(PLUGIN_NOTICE));
      assert.ok(context.includes(SKILL_TEXT));
      assert.ok(context.length < 9500, `SessionStart context is ${context.length} characters`);
    }, BOTH_DRIFT);
  });
});

test('a missing SKILL.md still exits 0 and prints the drift lines', () => {
  const data = mkdtempSync(join(tmpdir(), 'cm-drift-data-'));
  try {
    withPluginCopy([SUPERSEDED], (pluginRoot) => {
      rmSync(join(pluginRoot, SKILL_PATH));
      withHome((home) => {
        const lines = drift({ home, pluginRoot });
        assert.equal(sessionContext({ home, pluginRoot, source: 'startup', dataDir: data }), lines);
        assert.match(readFileSync(join(data, 'log'), 'utf8').trimEnd(), LOG_LINE);
        const r = runHook(pluginRoot, home, JSON.stringify({ source: 'startup' }));
        assert.equal(contextOf(r), lines);
      }, BOTH_DRIFT);
      withHome((home) => {
        assert.equal(sessionContext({ home, pluginRoot, source: 'startup' }), null);
        const r = runHook(pluginRoot, home, JSON.stringify({ source: 'startup' }));
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, '');
      });
    });
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test('an unreadable settings.json still exits 0 and prints the skill', () => {
  withPluginCopy([SUPERSEDED], (pluginRoot) => {
    withHome((home) => {
      assert.equal(sessionContext({ home, pluginRoot, source: 'startup' }), WRAPPED(SKILL_TEXT));
      assert.equal(contextOf(runHook(pluginRoot, home, JSON.stringify({ source: 'startup' }))), WRAPPED(SKILL_TEXT));
    }, { settings: '{ not json' });
    withHome((home) => {
      mkdirSync(join(home, '.claude', 'settings.json')); // a directory: reading it fails with EISDIR
      assert.equal(contextOf(runHook(pluginRoot, home, JSON.stringify({ source: 'compact' }))), WRAPPED(SKILL_TEXT));
    }, { settings: null });
  });
});

test('using-methodology states the superpowers rule', () => {
  assert.ok(
    SKILL_TEXT.split('\n').some((line) => line.includes('never use a `superpowers:*` skill when one is listed')),
    'using-methodology lacks the line "never use a `superpowers:*` skill when one is listed"',
  );
});

// keepSuperseded (spec Addendum E.9): <home>/.config/triqual/config.json opts out of the supersede.
function writeConfig(home, config) {
  const dir = join(home, '.config', 'triqual');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
}
const OTHER_MARKET = 'superpowers@claude-plugins-official';
const TWO_MARKETS = JSON.stringify({ enabledPlugins: { [SUPERSEDED]: true, [OTHER_MARKET]: true, 'superpowers-lab@m': true } });
const KEEP_NOTE = "triqual: superpowers is active by keepSuperseded; methodology's skills stay available as methodology:*";

test('drift names every enabled superpowers@* and says nothing under keepSuperseded', () => {
  withHome((home) => {
    assert.equal(drift({ home, pluginRoot: PLUGIN_ROOT }), [
      `triqual: superseded plugin still enabled: ${SUPERSEDED} — run \`triqual sync\``,
      `triqual: superseded plugin still enabled: ${OTHER_MARKET} — run \`triqual sync\``,
    ].join('\n'));
    writeConfig(home, { keepSuperseded: true });
    assert.equal(drift({ home, pluginRoot: PLUGIN_ROOT }), null);
  }, { settings: TWO_MARKETS });
  withHome((home) => {
    writeConfig(home, { keepSuperseded: true });
    // The rules line stays: keepSuperseded only silences the superseded lines.
    assert.equal(drift({ home, pluginRoot: PLUGIN_ROOT }), `triqual: ${RULES_NOTICE}`);
  }, { claudeMd: '# Machine\n', settings: TWO_MARKETS });
});

test('under keepSuperseded the SessionStart output is the short note, not using-methodology', () => {
  withHome((home) => {
    writeConfig(home, { keepSuperseded: true });
    const lines = drift({ home, pluginRoot: PLUGIN_ROOT });
    assert.equal(lines, `triqual: ${RULES_NOTICE}`);
    for (const source of ['startup', 'clear', 'compact']) {
      assert.equal(sessionContext({ home, pluginRoot: PLUGIN_ROOT, source }), `${lines}\n\n${KEEP_NOTE}`, source);
    }
    const context = contextOf(runHook(PLUGIN_ROOT, home, JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' })));
    assert.equal(context, `${lines}\n\n${KEEP_NOTE}`);
    assert.equal(context.includes('EXTREMELY_IMPORTANT'), false);
    assert.equal(context.includes(SKILL_TEXT), false);
    // resume: the drift lines only, as without keepSuperseded.
    assert.equal(sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'resume' }), lines);
  }, { claudeMd: '# Machine\n', settings: TWO_MARKETS });
  withHome((home) => {
    writeConfig(home, { keepSuperseded: true });
    assert.equal(sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'startup' }), KEEP_NOTE);
    assert.equal(contextOf(runHook(PLUGIN_ROOT, home, '{"source":"clear"}')), KEEP_NOTE);
  }, { settings: TWO_MARKETS });
  // An invalid config.json reads as no keepSuperseded: the skill is injected.
  withHome((home) => {
    writeConfig(home, {});
    writeFileSync(join(home, '.config', 'triqual', 'config.json'), '{ "keepSuperseded": true,, }');
    assert.equal(sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'startup' }), WRAPPED(SKILL_TEXT));
  });
  // Under keepSuperseded a resume never gets the note, even with superpowers disabled.
  withHome((home) => {
    writeConfig(home, { keepSuperseded: true });
    assert.equal(sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'resume' }), null);
  });
});

// drift --harness <id> (spec Addendum F.3, F.4): the rules line checks that harness's rules target against
// expectedRules and names `triqual sync --harness <id>`.
const harnessRules = (id) => expectedRules(PLUGIN_ROOT, id);
const HARNESS_FIX = (id) => `run \`triqual sync --harness ${id}\``;

function withHarnessRules(id, text, fn) {
  withHome((home) => {
    const { rules } = harnessPaths(home, id);
    mkdirSync(dirname(rules), { recursive: true });
    if (text !== null) writeFileSync(rules, text);
    fn(home);
  }, { claudeMd: '# Machine\n' }); // Claude's own rules are out of date: that line must not appear for a harness
}

test('drift --harness codex', () => {
  const agents = (body) => `# Codex machine config\n\n${MARKERS.start}\n${body}\n${MARKERS.end}\n`;
  withHarnessRules('codex', agents('## Old rules'), (home) => {
    const context = sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'startup', harness: 'codex' });
    const lines = context.split('\n\n')[0];
    assert.ok(lines.includes(HARNESS_FIX('codex')), lines);
    assert.equal(lines.includes('run `triqual sync`'), false, lines);
    assert.ok(context.includes(WRAPPED(SKILL_TEXT)));
  });
  withHarnessRules('codex', agents(harnessRules('codex').trim()), (home) => {
    assert.equal(sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'startup', harness: 'codex' }), WRAPPED(SKILL_TEXT));
  });
  // No AGENTS.md, or one without the section: out of date.
  withHarnessRules('codex', null, (home) => {
    assert.ok(sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'startup', harness: 'codex' }).includes(HARNESS_FIX('codex')));
  });
  withHarnessRules('codex', '# Codex only\n', (home) => {
    assert.ok(sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'startup', harness: 'codex' }).includes(HARNESS_FIX('codex')));
  });
  // Without a harness, Claude's CLAUDE.md is checked as before.
  withHarnessRules('codex', agents(harnessRules('codex').trim()), (home) => {
    assert.ok(sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'startup' }).includes(`triqual: ${RULES_NOTICE}`));
  });
});

test('drift --harness grok compares the whole rules file', () => {
  withHarnessRules('grok', harnessRules('grok'), (home) => {
    assert.equal(sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: null, harness: 'grok' }), WRAPPED(SKILL_TEXT));
  });
  withHarnessRules('grok', `${harnessRules('grok')}\nedited by hand\n`, (home) => {
    const context = sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: null, harness: 'grok' });
    assert.ok(context.split('\n\n')[0].includes(HARNESS_FIX('grok')), context);
  });
});

test('drift.mjs --harness codex as a hook names triqual sync --harness codex', () => {
  withHarnessRules('codex', '# Codex only\n', (home) => {
    const { CLAUDE_PLUGIN_DATA: _, XDG_CONFIG_HOME: __, ...env } = process.env;
    const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'cli', 'drift.mjs'), '--harness', 'codex'], {
      env: { ...env, HOME: home }, input: JSON.stringify({ session_id: 's', cwd: home, source: 'startup' }), encoding: 'utf8',
    });
    const context = contextOf(r);
    assert.ok(context.includes(HARNESS_FIX('codex')), context);
    assert.ok(context.includes(WRAPPED(SKILL_TEXT)));
    // resume keeps today's rule: no skill.
    const resumed = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'cli', 'drift.mjs'), '--harness', 'codex'], {
      env: { ...env, HOME: home }, input: JSON.stringify({ source: 'resume' }), encoding: 'utf8',
    });
    assert.equal(contextOf(resumed).includes('EXTREMELY_IMPORTANT'), false);
  });
});

// Setup notice: with no triqual CLI at ~/.local/bin/triqual.mjs the session is told to offer /methodology:setup, and no
// line points at `triqual sync`, which does not exist yet.
const SETUP_NOTICE = 'triqual: setup incomplete (triqual CLI not installed): offer the user /methodology:setup';

test('setup notice when the triqual CLI is missing, on every source', () => {
  withPluginCopy([SUPERSEDED], (pluginRoot) => {
    withHome((home) => {
      for (const source of ['startup', 'resume', 'clear', 'compact']) {
        const context = sessionContext({ home, pluginRoot, source });
        assert.equal(context.split('\n')[0], SETUP_NOTICE, source);
        assert.equal(context.includes('triqual sync'), false, source);
      }
      // The skill introduction is unchanged.
      assert.equal(sessionContext({ home, pluginRoot, source: 'startup' }), `${SETUP_NOTICE}\n\n${WRAPPED(SKILL_TEXT)}`);
      assert.equal(sessionContext({ home, pluginRoot, source: 'resume' }), SETUP_NOTICE);
    }, { claudeMd: '# Machine\n', settings: TWO_MARKETS, cli: false });
  });
  // Under keepSuperseded the short note still follows the setup notice.
  withHome((home) => {
    writeConfig(home, { keepSuperseded: true });
    assert.equal(sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'startup' }), `${SETUP_NOTICE}\n\n${KEEP_NOTE}`);
  }, { cli: false });
});

test('no setup notice on a harness path', () => {
  withHarnessRules('codex', '# Codex\n', (home) => {
    const context = sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'startup', harness: 'codex' });
    assert.equal(context.includes('setup incomplete'), false);
    assert.ok(context.includes(HARNESS_FIX('codex')));
  });
  withHome((home) => {
    const context = sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'startup', harness: 'grok' });
    assert.equal(context.includes('setup incomplete'), false);
  }, { cli: false });
});

test('setup notice on a dangling triqual.mjs symlink', () => {
  withHome((home) => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    symlinkSync(join(home, 'gone.mjs'), join(home, '.local', 'bin', 'triqual.mjs'));
    const context = sessionContext({ home, pluginRoot: PLUGIN_ROOT, source: 'startup' });
    assert.equal(context, `${SETUP_NOTICE}\n\n${WRAPPED(SKILL_TEXT)}`);
  }, { cli: false });
});

test('no setup notice when the CLI is installed', () => {
  withPluginCopy([SUPERSEDED], (pluginRoot) => {
    withHome((home) => {
      const lines = drift({ home, pluginRoot });
      const context = sessionContext({ home, pluginRoot, source: 'startup' });
      assert.equal(context.includes('setup incomplete'), false);
      assert.equal(context, `${lines}\n\n${WRAPPED(SKILL_TEXT)}`);
      assert.ok(context.includes('triqual sync'));
    }, BOTH_DRIFT);
  });
});
