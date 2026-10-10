import { describe, expect, it } from 'vitest';
import { parsePointTag } from './point-parser.js';
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
    expect(prompt).toContain('About the user: new to Excel');
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
