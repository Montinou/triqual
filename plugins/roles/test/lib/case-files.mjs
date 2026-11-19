// Reads the role replay cases (plugins/roles/evals/cases) and checks their format.
// Node built-ins only.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CASES_DIR = join(ROLES_DIR, 'evals', 'cases');

export const ROLE_NAMES = readdirSync(join(ROLES_DIR, 'agents'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))
  .sort();

const NUMBER = '(\\d+(?:\\.\\d+)?)';

const toolList = (raw) => (raw === undefined ? [] : raw.split(',').map((t) => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));

const frontMatter = (raw) => {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  return m ? { head: m[1], body: m[2] } : { head: '', body: raw };
};

const weightOf = (text) => {
  const m = text.match(new RegExp(`^[ \\t]*weight:[ \\t]*${NUMBER}`, 'm'));
  return m ? Number(m[1]) : null;
};

const readPrompt = (name, dir) => {
  const { head, body } = frontMatter(readFileSync(join(dir, 'prompt.md'), 'utf8'));
  const turns = head.match(/^max_turns:[ \t]*(\d+)/m);
  const tools = head.match(/^allowed_tools:[ \t]*\[(.*)\]/m);
  const scaffold = head.match(/^scaffold_script:[ \t]*(\S+)/m);
  const gradersDir = join(dir, 'graders');
  const graders = existsSync(gradersDir)
    ? readdirSync(gradersDir).filter((f) => f.endsWith('.md')).sort().map((f) => {
      const g = frontMatter(readFileSync(join(gradersDir, f), 'utf8'));
      return { name: f.slice(0, -3), weight: weightOf(g.head), text: g.body.trim() };
    })
    : [];
  return {
    name, dir, format: 'prompt', text: body.trim(),
    maxTurns: turns ? Number(turns[1]) : null,
    allowedTools: toolList(tools?.[1]),
    scaffold: scaffold ? scaffold[1] : null,
    graders,
  };
};

const readYaml = (name, dir) => {
  const text = readFileSync(join(dir, 'case.yaml'), 'utf8');
  const turns = text.match(/^[ \t]*max_turns:[ \t]*(\d+)/m);
  const tools = text.match(/^[ \t]*allowed_tools:[ \t]*\[(.*)\]/m);
  const scaffold = text.match(/^[ \t]*scaffold_script:[ \t]*(\S+)/m);
  const starts = [...text.matchAll(/^[ \t]*- type:/gm)].map((m) => m.index);
  const graders = starts.map((start, i) => {
    const item = text.slice(start, starts[i + 1] ?? text.length).trim();
    const label = item.match(/^[ \t]*name:[ \t]*(\S+)/m);
    return { name: label ? label[1] : `grader-${i + 1}`, weight: weightOf(item), text: item };
  });
  return {
    name, dir, format: 'yaml', text,
    maxTurns: turns ? Number(turns[1]) : null,
    allowedTools: toolList(tools?.[1]),
    scaffold: scaffold ? scaffold[1] : null,
    graders,
  };
};

export const readCases = (dir = CASES_DIR) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const caseDir = join(dir, name);
    if (!statSync(caseDir).isDirectory()) return [];
    if (existsSync(join(caseDir, 'prompt.md'))) return [readPrompt(name, caseDir)];
    if (existsSync(join(caseDir, 'case.yaml'))) return [readYaml(name, caseDir)];
    return [];
  });
};

export const casesOf = (role, dir = CASES_DIR) => readCases(dir).filter((c) => c.name.startsWith(`${role}-`));

const roleOf = (name) => ROLE_NAMES
  .filter((r) => name.startsWith(`${r}-`))
  .sort((a, b) => b.length - a.length)[0] ?? null;

const SHELL_TOOLS = ['Bash', 'Write', 'Edit'];

export const problems = (c) => {
  const out = [];
  const add = (msg) => out.push(`${c.name}: ${msg}`);
  const role = roleOf(c.name);

  if (!/^[a-z0-9-]+$/.test(c.name) || c.name !== basename(c.dir) || role === null) {
    add('the name must match ^[a-z0-9-]+$, equal its directory name and start with <role>- for one of the roles');
  }
  if (role !== null && !c.text.includes(`roles:${role}`)) add(`the text must contain roles:${role}`);
  if (!Number.isInteger(c.maxTurns) || c.maxTurns < 1 || c.maxTurns > 200 || c.allowedTools.length === 0) {
    add('max_turns must be an integer from 1 to 200 and allowed_tools must not be empty');
  }
  if (c.graders.length < 2 || c.graders.some((g) => !(g.weight > 0) || !g.text)) {
    add('a case needs at least two graders, each with a weight above 0 and a text');
  }
  if (c.format === 'prompt' && c.scaffold) add('a prompt case must not have a scaffold_script (use a case.yaml)');
  if (c.format === 'yaml') {
    const nameLine = c.text.match(/^name:[ \t]*["']?([^"'\s]+)["']?[ \t]*$/m);
    if (!/^schema_version:/m.test(c.text)) add('case.yaml needs a schema_version');
    if (!nameLine || nameLine[1] !== basename(c.dir)) add('the case.yaml name line must equal its directory name');
    if (c.scaffold) {
      const file = join(c.dir, c.scaffold);
      if (!existsSync(file)) add(`the scaffold ${c.scaffold} does not exist in the case directory`);
      else if (!readFileSync(file, 'utf8').startsWith('#!')) add(`the scaffold ${c.scaffold} must start with #!`);
    }
  }
  if (c.allowedTools.some((t) => SHELL_TOOLS.includes(t)) && !(c.format === 'yaml' && c.scaffold)) {
    add('Bash, Write or Edit are allowed only in a case.yaml with a scaffold_script');
  }
  if (/TODO/.test(c.text) || c.graders.some((g) => /TODO/.test(g.text))) add('no TODO in the text or the graders');
  return out;
};
