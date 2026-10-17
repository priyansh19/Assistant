import { describe, expect, it } from 'vitest';
import {
  addNote,
  addStanding,
  clickyBriefing,
  clickyCopy,
  clickyFolderName,
  clickyNameProblem,
  clickySlug,
  findTwin,
  MAX_NOTES,
  newClicky,
  parseAgentsMd,
  renderAgentsMd,
  routeToClicky,
  type ClickyAgent,
} from './clickys.js';

const day = new Date('2026-10-16T10:00:00Z');
const pitch = newClicky({ name: 'Pitch Lab', role: 'Deck Writer', purpose: 'Drafts and polishes pitch decks.' }, [], 1);
const inbox = newClicky(
  { name: 'Inbox Desk', role: 'Email Triage', purpose: 'Sorts email and drafts replies.' },
  [pitch],
  2,
);
const roster: ClickyAgent[] = [pitch, inbox];

describe('names and slugs', () => {
  it('makes unique slugs', () => {
    expect(clickySlug('Pitch Lab', [])).toBe('clicky-pitch-lab');
    expect(clickySlug('Pitch Lab', [pitch])).toBe('clicky-pitch-lab-2');
    expect(clickySlug('!!!', [])).toBe('clicky-helper');
  });

  it('makes Windows-safe folder names', () => {
    expect(clickyFolderName({ name: 'Q&A: Desk?', slug: 's' })).toBe('Q&A Desk');
    expect(clickyFolderName({ name: 'CON', slug: 'clicky-con' })).toBe('clicky-con');
    expect(clickyFolderName({ name: 'Notes...', slug: 's' })).toBe('Notes');
  });

  it('checks names', () => {
    expect(clickyNameProblem('Launch Scout', roster)).toBeNull();
    expect(clickyNameProblem('Pitch Lab', roster)).toMatch(/already have/);
    expect(clickyNameProblem('Research Lab', roster)).toMatch(/ends in "Lab"/);
    expect(clickyNameProblem('Priya Helper', roster, 'Priya')).toMatch(/own name/);
    expect(clickyNameProblem('Clicky', roster)).toMatch(/my own name/);
    expect(clickyNameProblem('A very long name for a helper', roster)).toMatch(/two short words/);
    expect(clickyNameProblem('Bad/Name', roster)).toMatch(/letters/);
  });

  it('an archived Clicky frees its name', () => {
    expect(clickyNameProblem('Pitch Lab', [{ ...pitch, archived: true }])).toBeNull();
  });
});

describe('notes', () => {
  it('dates notes, newest first', () => {
    const r = addNote([], 'Uses the 2026 brand colours', day);
    expect(r).toEqual({ ok: true, notes: [{ date: '2026-10-16', text: 'Uses the 2026 brand colours' }] });
  });

  it('newest wins on the same subject', () => {
    let notes = [{ date: '2026-10-01', text: 'Default account: work@x.test' }];
    const r = addNote(notes, 'Default account: me@y.test', day);
    if (!r.ok) throw new Error('refused');
    notes = r.notes;
    expect(notes).toEqual([{ date: '2026-10-16', text: 'Default account: me@y.test' }]);
  });

  it('drops duplicates and keeps the list short', () => {
    let notes: { date: string; text: string }[] = [];
    for (let i = 0; i < MAX_NOTES + 5; i++) {
      const r = addNote(notes, `Fact number ${i} about item${i}`, day);
      if (r.ok) notes = r.notes;
    }
    expect(notes).toHaveLength(MAX_NOTES);
    const again = addNote(notes, notes[3]!.text, day);
    expect(again.ok && again.notes.filter((n) => n.text === notes[3]!.text)).toHaveLength(1);
  });

  it('refuses secrets', () => {
    const r = addNote([], 'the api key is sk-ant-api03-ABCDEFGHIJKLMNOPQRS', day);
    expect(r.ok).toBe(false);
    expect(!r.ok && clickyCopy.noteRefused(r.reason)).toMatch(
      /didn't save that note: I don't keep that because it looks like an API key/,
    );
    expect(addStanding([], 'my password is hunter2').ok).toBe(false);
    expect(addStanding(['Use metric'], 'use metric')).toEqual({ ok: true, standing: ['use metric'] });
  });
});

describe('AGENTS.md', () => {
  it('round-trips through the file the user can edit', () => {
    const c: ClickyAgent = {
      ...pitch,
      standing: ['Write in British English'],
      notes: [
        { date: '2026-10-15', text: 'Deck template is in output/template.pptx' },
        { date: '2026-10-10', text: 'Investor meeting on Friday' },
      ],
    };
    const md = renderAgentsMd(c);
    expect(md).toContain('You are Pitch Lab');
    expect(md).toContain('Never store passwords');
    expect(parseAgentsMd(md, day)).toEqual({ standing: c.standing, notes: c.notes });
  });

  it('dates undated lines, sorts, and drops pasted secrets', () => {
    const md = `## Standing preferences\n- Short slides\n- token=abcdef123456\n\n## Notes\n- 2026-10-01: old fact\n- a fact the user typed\n- 2026-10-12 - newer fact\n- password: hunter22\n`;
    expect(parseAgentsMd(md, day)).toEqual({
      standing: ['Short slides'],
      notes: [
        { date: '2026-10-16', text: 'a fact the user typed' },
        { date: '2026-10-12', text: 'newer fact' },
        { date: '2026-10-01', text: 'old fact' },
      ],
    });
  });

  it('frames notes as background, never permission', () => {
    const b = clickyBriefing(
      { ...pitch, notes: [{ date: '2026-10-16', text: 'x' }] },
      'C:\\Users\\u\\Documents\\Clicky\\Pitch Lab',
    );
    expect(b).toContain('never permit anything');
    expect(b).toContain('Pitch Lab\\output');
    expect(b).toContain('newer one wins');
  });
});

describe('routing', () => {
  it('finds the Clicky the user named', () => {
    expect(routeToClicky('Ask Pitch Lab to draft the Q4 deck', roster)).toEqual({
      clicky: pitch,
      task: 'draft the Q4 deck',
    });
    expect(routeToClicky("Clicky, Inbox Desk, what's waiting for me?", roster)?.clicky).toBe(inbox);
    expect(routeToClicky('inbox desk: archive the newsletters', roster)?.task).toBe('archive the newsletters');
    expect(routeToClicky('have pitch lab to fix slide 3', roster)?.clicky).toBe(pitch);
  });

  it('leaves other requests alone', () => {
    expect(routeToClicky('open the pitch deck', roster)).toBeNull();
    expect(routeToClicky('Ask Sales Bot to call', roster)).toBeNull();
  });

  it('spots a twin before making a new helper', () => {
    expect(findTwin('a helper that drafts pitch decks', roster)).toBe(pitch);
    expect(findTwin('sort my email and draft replies', roster)).toBe(inbox);
    expect(findTwin('track flight prices', roster)).toBeNull();
    expect(findTwin('weekly flight prices', roster, { [inbox.slug]: ['Weekly Flight Prices'] })).toBe(inbox);
  });

  it('never says a new helper is working', () => {
    expect(clickyCopy.made('Pitch Lab')).toMatch(/hasn't started anything/);
  });
});
