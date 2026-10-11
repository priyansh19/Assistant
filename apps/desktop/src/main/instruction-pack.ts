import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { log } from './log';

/**
 * The instruction pack shipped with Clicky (resources/instructions): agents.md, skills/*.md and
 * lessons.json, compiled from the test suite's runs (scripts/export-instructions.mjs). Every
 * install starts from it, and a newer pack adds what's new without overwriting the user's edits:
 * new skill files are added, agents.md is replaced only if the user never changed it, and
 * lessons for tasks the user hasn't run are merged in.
 */
const packDir = (): string => join(app.getAppPath(), 'resources', 'instructions');
const hash = (s: string): string => createHash('sha1').update(s).digest('hex');

interface Shipped {
  version: string;
  agentsHash: string;
}

export function applyInstructionPack(): void {
  const dir = packDir();
  const manifestFile = join(dir, 'pack.json');
  if (!existsSync(manifestFile)) return;
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { version?: string };
    const version = String(manifest.version ?? '0');
    const user = app.getPath('userData');
    const stateFile = join(user, '.instructions.json');
    const state: Shipped | null = existsSync(stateFile)
      ? (JSON.parse(readFileSync(stateFile, 'utf8')) as Shipped)
      : null;
    if (state?.version === version) return;

    // agents.md: install it, or update it if it's still the copy we shipped last time.
    const agentsSrc = join(dir, 'agents.md');
    const agentsDst = join(user, 'agents.md');
    let agentsHash = state?.agentsHash ?? '';
    if (existsSync(agentsSrc)) {
      const shipped = readFileSync(agentsSrc, 'utf8');
      const current = existsSync(agentsDst) ? readFileSync(agentsDst, 'utf8') : null;
      if (current === null || hash(current) === state?.agentsHash) writeFileSync(agentsDst, shipped);
      agentsHash = hash(shipped);
    }

    // Skills: add the ones the user doesn't have yet.
    const skillsSrc = join(dir, 'skills');
    const skillsDst = join(user, 'skills');
    if (existsSync(skillsSrc)) {
      mkdirSync(skillsDst, { recursive: true });
      for (const f of readdirSync(skillsSrc))
        if (f.endsWith('.md') && !existsSync(join(skillsDst, f))) copyFileSync(join(skillsSrc, f), join(skillsDst, f));
    }

    // Lessons: shipped routes for tasks the user hasn't taught Clicky themselves.
    const lessonsSrc = join(dir, 'lessons.json');
    const lessonsDst = join(user, 'agent-lessons.json');
    if (existsSync(lessonsSrc)) {
      const shipped = JSON.parse(readFileSync(lessonsSrc, 'utf8')) as { goal: string }[];
      const mine = existsSync(lessonsDst) ? (JSON.parse(readFileSync(lessonsDst, 'utf8')) as { goal: string }[]) : [];
      const have = new Set(mine.map((l) => l.goal.toLowerCase()));
      const merged = [...mine, ...shipped.filter((l) => !have.has(l.goal.toLowerCase()))].slice(0, 60);
      writeFileSync(lessonsDst, JSON.stringify(merged, null, 1));
    }

    writeFileSync(stateFile, JSON.stringify({ version, agentsHash } satisfies Shipped));
    log.info(`instruction pack ${version} applied`);
  } catch (e) {
    log.warn('instruction pack could not be applied', String(e));
  }
}
