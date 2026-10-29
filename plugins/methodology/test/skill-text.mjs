// Shared reader for the tests of a skill: the text of its SKILL.md followed by the text of every
// `references/*.md` of the skill (sorted by name), so a heading or rule is found wherever it lives.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readSkillText(skillDir) {
  const parts = [readFileSync(join(skillDir, 'SKILL.md'), 'utf8')];
  const refs = join(skillDir, 'references');
  if (existsSync(refs)) {
    for (const name of readdirSync(refs).filter((n) => n.endsWith('.md')).sort()) {
      parts.push(readFileSync(join(refs, name), 'utf8'));
    }
  }
  return parts.join('\n');
}
