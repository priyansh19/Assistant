import { describe, expect, it } from 'vitest';
import { checkArtifacts, LIMITS, parseFinalMessage, visibleText } from './final-message.js';

const full = `I found 12 open roles and saved them to a sheet.

<SUMMARY>You have 12 open roles in **Dubai**, saved to a sheet.</SUMMARY>
<NEXT_ACTIONS>
- Draft cover letters for the top 3.
- "Track new roles every morning"
- Open the file
</NEXT_ACTIONS>
<DONE_TITLE>dubai roles sheet</DONE_TITLE>
<ARTIFACTS>
- C:\\Users\\me\\Documents\\Clicky\\Job Scout\\output\\roles.xlsx
- C:\\Users\\me\\Documents\\Clicky\\Job Scout\\tmp\\scratch.json
</ARTIFACTS>
<NOTES>
- Prefers remote roles
</NOTES>`;

describe('parseFinalMessage', () => {
  it('reads every block and strips them from the answer', () => {
    const f = parseFinalMessage(full);
    expect(f.answer).toBe('I found 12 open roles and saved them to a sheet.');
    expect(f.summary).toBe('You have 12 open roles in Dubai, saved to a sheet.');
    expect(f.nextActions).toEqual(['Draft cover letters for the top 3', 'Track new roles every morning']);
    expect(f.title).toBe('Dubai Roles Sheet');
    expect(f.artifacts).toHaveLength(2);
    expect(f.notes).toEqual(['Prefers remote roles']);
    expect(f.isQuestion).toBe(false);
    expect(f.problems).toEqual([]);
  });

  it('falls back to the first sentence when SUMMARY is missing', () => {
    const f = parseFinalMessage('Done. The folder now has 4 files in it. More detail here.');
    expect(f.summary).toBe('Done. The folder now has 4 files in it.');
    expect(f.nextActions).toEqual([]);
  });

  it('enforces the limits in code', () => {
    const long = 'word '.repeat(80);
    const f = parseFinalMessage(
      `x<SUMMARY>${long}</SUMMARY><NEXT_ACTIONS>\n- a much too long action phrase that goes on and on\n- b2b\n- c3c\n- d4d\n- e5e\n</NEXT_ACTIONS><DONE_TITLE>one two three four five six seven</DONE_TITLE>`,
    );
    expect(f.summary.length).toBeLessThanOrEqual(LIMITS.summaryChars);
    expect(f.nextActions).toHaveLength(LIMITS.nextActions);
    expect(f.nextActions[0]!.length).toBeLessThanOrEqual(LIMITS.nextActionChars);
    expect(f.title.split(' ')).toHaveLength(5);
    expect(f.problems).toContain('SUMMARY was too long');
  });

  it('a question turn offers no next actions', () => {
    const f = parseFinalMessage(
      'I need one thing.\n<SUMMARY>Which account should send it, work or personal?</SUMMARY><NEXT_ACTIONS>\n- Send it\n</NEXT_ACTIONS>',
    );
    expect(f.isQuestion).toBe(true);
    expect(f.nextActions).toEqual([]);
  });

  it('a screen request becomes the summary', () => {
    const f = parseFinalMessage(
      '<COMPUTER_USE_REQUEST>I need your screen for a minute to open Notes. Mind if I do that?</COMPUTER_USE_REQUEST>',
    );
    expect(f.computerUseRequest).toMatch(/Mind if I/);
    expect(f.summary).toMatch(/Mind if I/);
    expect(f.isQuestion).toBe(true);
  });

  it('copes with an unclosed block', () => {
    const f = parseFinalMessage('All set.\n<SUMMARY>All set, 3 files moved.');
    expect(f.answer).toBe('All set.');
    expect(f.summary).toBe('All set, 3 files moved.');
    expect(f.problems).toContain('SUMMARY was not closed');
  });

  it('keeps the ROUTINE JSON for routines.ts', () => {
    const f = parseFinalMessage('ok <ROUTINE>{"action":"create"}</ROUTINE>');
    expect(f.routine).toBe('{"action":"create"}');
    expect(f.answer).toBe('ok');
  });
});

describe('visibleText', () => {
  it('never shows tag text, even mid-stream', () => {
    expect(visibleText('Done. <SUMM')).toBe('Done.');
    expect(visibleText('Done. <SUMMARY>half a summ')).toBe('Done.');
    expect(visibleText('Done.</DONE_TITLE> ok')).toBe('Done. ok');
    expect(visibleText('a < b and c > d')).toBe('a < b and c > d');
  });
});

describe('checkArtifacts', () => {
  const real = new Set(['C:\\out\\a.xlsx', 'D:/r/b.pdf']);
  it('keeps real files and links, drops the rest with a reason', () => {
    const r = checkArtifacts(
      [
        'C:\\out\\a.xlsx',
        '"D:/r/b.pdf"',
        'https://github.com/x/y/pull/3',
        'C:\\out\\missing.docx',
        'C:\\w\\tmp\\t.json',
        'output\\rel.txt',
        '\\\\host\\share\\x',
      ],
      (p) => real.has(p),
    );
    expect(r.kept).toEqual(['C:\\out\\a.xlsx', 'D:/r/b.pdf', 'https://github.com/x/y/pull/3']);
    expect(r.dropped.map((d) => d.why)).toEqual([
      "it doesn't exist",
      'a work file in tmp',
      'not an absolute path',
      'a network path',
    ]);
  });
});
