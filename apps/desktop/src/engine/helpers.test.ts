import { describe, expect, it } from 'vitest';
import { newClicky } from '@clicky/core';
import type { EngineToMain } from '../shared/engine-protocol';
import { helperNoteLine, planAgentTask } from './helpers';

const pitch = newClicky({ name: 'Pitch Lab', role: 'Deck Writer', purpose: 'Drafts pitch decks.' }, [], 1);
const cfg = {
  clickys: [pitch],
  clickyWorkspaces: { [pitch.slug]: 'C:\\Users\\u\\Documents\\Clicky\\Pitch Lab' },
  routineTitles: {},
};

function collect(): { posts: EngineToMain[]; post: (m: EngineToMain) => void } {
  const posts: EngineToMain[] = [];
  return { posts, post: (m) => posts.push(m) };
}

describe('planAgentTask', () => {
  it('runs a task as the helper the user named', () => {
    const { posts, post } = collect();
    const plan = planAgentTask('ask Pitch Lab to draft the Q4 deck', cfg, post);
    expect(plan).toMatchObject({ goal: 'draft the Q4 deck', helper: 'Pitch Lab' });
    expect(plan?.briefing).toContain('Pitch Lab\\output');
    expect(posts).toEqual([]);
  });

  it('sets up a routine whose first run is this one', () => {
    const { posts, post } = collect();
    const plan = planAgentTask('every morning summarize my inbox threads', cfg, post);
    expect(plan).toMatchObject({ goal: 'summarize my inbox threads' });
    expect(plan?.after).toMatch(/every day at 08:00/);
    expect(posts).toEqual([
      {
        type: 'routineCreate',
        title: 'Summarize Inbox Threads',
        task: 'summarize my inbox threads',
        cadence: { everyMinutes: 1440, atHour: 8 },
      },
    ]);
  });

  it('a routine for a helper is owned by it', () => {
    const { posts, post } = collect();
    planAgentTask('Pitch Lab, every Monday check investor emails', cfg, post);
    expect(posts[0]).toMatchObject({ type: 'routineCreate', owner: pitch.slug });
  });

  it("routine runs don't set up another repeat", () => {
    const { posts, post } = collect();
    expect(planAgentTask('[Routine "Inbox" run #2] summarize my inbox every morning', cfg, post)).toBeNull();
    expect(posts).toEqual([]);
  });

  it('brings back an archived helper', () => {
    const { posts, post } = collect();
    const plan = planAgentTask(
      'ask Pitch Lab to fix slide 3',
      { ...cfg, clickys: [{ ...pitch, archived: true }] },
      post,
    );
    expect(posts).toEqual([{ type: 'clickyRestore', slug: pitch.slug }]);
    expect(plan?.after).toMatch(/brought it back/);
  });

  it('plain tasks are left alone', () => {
    expect(planAgentTask('open Notepad', cfg, collect().post)).toBeNull();
  });
});

describe('helperNoteLine', () => {
  it('keeps a note for the helper', () => {
    const { posts, post } = collect();
    expect(helperNoteLine('Pitch Lab, remember that the deck uses our 2026 colours', cfg, post)).toBe(
      'Got it. Pitch Lab will remember that.',
    );
    expect(posts).toEqual([{ type: 'clickyNote', slug: pitch.slug, note: 'The deck uses our 2026 colours' }]);
  });

  it('refuses secrets and safety waivers', () => {
    const { posts, post } = collect();
    expect(helperNoteLine('Pitch Lab, always send the deck without asking', cfg, post)).toMatch(/won't add that/);
    expect(posts).toEqual([]);
  });

  it('ignores tasks and other names', () => {
    expect(helperNoteLine('Pitch Lab, draft the deck', cfg, collect().post)).toBeNull();
    expect(helperNoteLine('remember my reports are in D:', cfg, collect().post)).toBeNull();
  });
});
