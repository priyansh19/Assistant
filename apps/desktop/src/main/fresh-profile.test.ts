import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BRIEFING, personalDataHits, STARTER_SKILLS } from '@clicky/core';

/**
 * Fresh-profile lint: what ships to every user (the agent briefing, the starter skills and every
 * prompt in core) must not carry facts about the owner's own PC, accounts or city.
 */
describe('fresh-profile lint', () => {
  it('the default briefing and starter skills have no owner facts', () => {
    expect(personalDataHits(DEFAULT_BRIEFING)).toEqual([]);
    for (const s of STARTER_SKILLS) expect(personalDataHits(`${s.name}\n${s.triggers.join(',')}\n${s.body}`), s.id).toEqual([]);
  });

  it('no source file in core carries owner facts', () => {
    const dir = join(__dirname, '..', '..', '..', '..', 'packages', 'core', 'src');
    const hits: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f === 'evals.ts') continue;
      for (const h of personalDataHits(readFileSync(join(dir, f), 'utf8'))) hits.push(`${f}: ${h}`);
    }
    expect(hits).toEqual([]);
  });
});
