import { describe, expect, it } from 'vitest';
import { STARTER_SKILLS, learnIntoSkill, matchSkills, parseSkill, serializeSkill, skillsText } from './skills.js';

describe('skills', () => {
  it('round-trips through the file format', () => {
    for (const s of STARTER_SKILLS) expect(parseSkill(s.id, serializeSkill(s))).toEqual(s);
  });

  it('matches by whole words and phrases', () => {
    const ids = (goal: string) => matchSkills(goal, STARTER_SKILLS).map((s) => s.id);
    expect(ids('open GitHub and merge the pending PRs')).toContain('github-pull-requests');
    expect(ids('scroll my LinkedIn feed and put jobs in an Excel sheet')).toEqual(
      expect.arrayContaining(['linkedin-jobs', 'spreadsheets']),
    );
    expect(ids('open example.com')).toContain('comet-browser');
    // "pr" is not "print", "file" is not "profile".
    expect(ids('print my profile')).toEqual([]);
  });

  it('caps the prompt block', () => {
    const big = { id: 'big', name: 'Big', triggers: ['x'], body: 'a'.repeat(10_000) };
    expect(skillsText([big], 500).length).toBeLessThan(600);
  });

  it('keeps the last eight learned runs', () => {
    let s = STARTER_SKILLS[0]!;
    for (let i = 0; i < 10; i++)
      s = learnIntoSkill(s, `merge PR ${i}`, ['opened github', 'clicked merge'], new Date(0));
    const learned = s.body.split('## Learned from runs that worked')[1]!.trim().split('\n');
    expect(learned).toHaveLength(8);
    expect(learned.at(-1)).toContain('merge PR 9');
    expect(s.body.startsWith(STARTER_SKILLS[0]!.body)).toBe(true);
  });
});
