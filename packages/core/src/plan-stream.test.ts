import { describe, expect, it } from 'vitest';
import { PlanStream, type PlanStreamEvent } from './plan-stream.js';

const PLAN =
  '{"understood": "Search YouTube for \\"lo-fi\\" {beats}", "done_when": {"window": "YouTube", "shows": ["lo-fi"]},' +
  ' "steps": [{"action":"open","url":"https://www.youtube.com/","say":"Opening [YouTube]"},' +
  ' {"action":"set_control","name":"Search","text":"a } b ] c"}, {"action":"key","keys":"enter"}]}';

function feed(text: string, size: number): PlanStreamEvent[][] {
  const s = new PlanStream();
  const out: PlanStreamEvent[][] = [];
  for (let i = 0; i < text.length; i += size) out.push(s.push(text.slice(i, i + size)));
  return out;
}

describe('PlanStream', () => {
  it('hands out each step and member as soon as it closes, whatever the chunking', () => {
    for (const size of [1, 2, 3, 7, 50, PLAN.length]) {
      const events = feed(PLAN, size).flat();
      expect(events.filter((e) => e.type === 'step').map((e) => JSON.parse(e.raw) as unknown)).toEqual([
        { action: 'open', url: 'https://www.youtube.com/', say: 'Opening [YouTube]' },
        { action: 'set_control', name: 'Search', text: 'a } b ] c' },
        { action: 'key', keys: 'enter' },
      ]);
      const understood = events.find((e) => e.type === 'member' && e.key === 'understood');
      expect(understood && JSON.parse(understood.raw)).toBe('Search YouTube for "lo-fi" {beats}');
      const done = events.find((e) => e.type === 'member' && e.key === 'done_when');
      expect(done && JSON.parse(done.raw)).toEqual({ window: 'YouTube', shows: ['lo-fi'] });
    }
  });

  it('releases the first step before the rest of the plan is written', () => {
    const s = new PlanStream();
    const cut = PLAN.indexOf('{"action":"set_control"');
    const early = s.push(PLAN.slice(0, cut));
    expect(early.filter((e) => e.type === 'step')).toHaveLength(1);
    expect(s.push(PLAN.slice(cut)).filter((e) => e.type === 'step')).toHaveLength(2);
  });

  it('ignores a code fence, text after the object and non-object elements', () => {
    const events = new PlanStream().push(
      'Here is the plan:\n```json\n{"plan": ["note", 3, {"action":"wait","ms":500}], "x": 1}\n```\n{"steps":[{"action":"key","keys":"a"}]}',
    );
    expect(events.filter((e) => e.type === 'step').map((e) => e.raw)).toEqual(['{"action":"wait","ms":500}']);
  });

  it('reads only the first steps array, and nested objects stay inside their step', () => {
    const events = new PlanStream().push(
      '{"steps":[{"action":"open","meta":{"a":{"b":1}}}],"plan":[{"action":"key","keys":"x"}]}',
    );
    expect(events.filter((e) => e.type === 'step').map((e) => e.raw)).toEqual([
      '{"action":"open","meta":{"a":{"b":1}}}',
    ]);
  });

  it('gives nothing for a reply cut off inside a step', () => {
    const events = new PlanStream().push('{"steps":[{"action":"type","text":"hal');
    expect(events).toEqual([]);
  });
});
