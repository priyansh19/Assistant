import { describe, expect, it } from 'vitest';
import { parsePointTag, parseTaskTag } from './point-parser.js';
import { buildSystemPrompt } from './prompt.js';

describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt({
    screens: [
      { index: 1, imageWidth: 1280, imageHeight: 800, hasCursor: true },
      { index: 2, imageWidth: 1280, imageHeight: 720, hasCursor: false },
    ],
    userContext: '  new to Excel  ',
  });

  it('asks for the tag first and describes every screen', () => {
    expect(prompt).toContain('Start EVERY reply with exactly one tag');
    expect(prompt).toContain('screen1: 1280x800 px (the cursor is on this screen)');
    expect(prompt).toContain('screen2: 1280x720 px');
    expect(prompt).toContain('About the user:\n<untrusted source="user context">\nnew to Excel');
    // Parity with the official Clicky's voice rules: long answers on request, no dead-end offers.
    expect(prompt).toContain('give the full explanation');
    expect(prompt).toContain('150 to 300');
    expect(prompt).toContain('planting a\n  seed');
  });

  it('only shows example tags our parser accepts', () => {
    const examples = prompt.match(/\[POINT:[^\]]*\]/g) ?? [];
    const concrete = examples.filter((e) => !e.includes('x,y'));
    expect(concrete.length).toBeGreaterThan(0);
    for (const e of concrete) expect(parsePointTag(e)).not.toBeNull();
  });

  it('omits empty user context', () => {
    expect(buildSystemPrompt({ screens: [], userContext: '  ' })).not.toContain('About the user');
  });
});

describe('buildSystemPrompt with agent mode', () => {
  const screens = [{ index: 1, imageWidth: 1280, imageHeight: 800, hasCursor: true }];

  it('lets the model hand tasks over with a restated goal', () => {
    const p = buildSystemPrompt({ screens, tasks: true });
    expect(p).toContain('[TASK:the goal]');
    expect(p).toContain('resolved from the earlier turns');
    expect(p).not.toContain('guide them and point instead');
    expect(parseTaskTag('[TASK:Make a folder called Receipts on the Desktop]')).toBe(
      'Make a folder called Receipts on the Desktop',
    );
  });

  it('keeps the answer-only rules without agent mode', () => {
    const p = buildSystemPrompt({ screens });
    expect(p).not.toContain('[TASK:');
    expect(p).toContain('guide them and point instead');
  });

  it('mentions the TASK tag in the audio instructions only with agent mode', () => {
    expect(buildSystemPrompt({ screens, audioQuestion: true, tasks: true })).toContain('(or the TASK tag)');
    expect(buildSystemPrompt({ screens, audioQuestion: true })).not.toContain('TASK');
  });
});
