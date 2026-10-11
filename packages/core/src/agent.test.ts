import { describe, expect, it } from 'vitest';
import { agentGoal, parseAgentAction, parseKeys, runAgent, type AgentDeps } from './agent.js';
import type { CapturePort, InputAction, OverlayPort, ScreenCapture } from './ports.js';
import type { VisionChatProvider } from './providers.js';

describe('agentGoal', () => {
  it('recognises the ways people ask for the agent', () => {
    expect(agentGoal('Agent, open Notepad and type hello')).toBe('open Notepad and type hello');
    expect(agentGoal('hey clicky agent: rename this file')).toBe('rename this file');
    expect(agentGoal('agent open settings')).toBe('open settings');
    expect(agentGoal('Where is the agent setting?')).toBeNull();
    expect(agentGoal('agents are cool')).toBeNull();
    expect(agentGoal('agent')).toBeNull();
  });
});

describe('parseKeys', () => {
  it('normalises shortcuts and rejects unknown keys', () => {
    expect(parseKeys('Ctrl + Shift + S')).toEqual(['ctrl', 'shift', 's']);
    expect(parseKeys('Return')).toEqual(['enter']);
    expect(parseKeys('win')).toEqual(['win']);
    expect(parseKeys('ctrl+banana')).toBeNull();
  });
});

describe('parseAgentAction', () => {
  it('reads one JSON object even inside a code fence', () => {
    const r = parseAgentAction('```json\n{"action":"click","x":10,"y":20,"target":"OK","say":"Clicking OK"}\n```');
    expect(r).toEqual({
      ok: true,
      action: { type: 'click', x: 10, y: 20, screen: null, target: 'OK', say: 'Clicking OK', risky: false },
    });
  });

  it('rejects malformed actions with a reason the model can act on', () => {
    expect(parseAgentAction('sure!')).toEqual({ ok: false, error: 'no JSON object in the reply' });
    expect(parseAgentAction('{"action":"click","x":"a"}')).toMatchObject({ ok: false });
    expect(parseAgentAction('{"action":"fly"}')).toEqual({ ok: false, error: 'unknown action "fly"' });
    expect(parseAgentAction('{"action":"key","keys":"ctrl+banana"}')).toMatchObject({ ok: false });
  });

  it('clamps waits and scrolls', () => {
    expect(parseAgentAction('{"action":"wait","ms":99999}')).toMatchObject({ ok: true, action: { ms: 5000 } });
    expect(parseAgentAction('{"action":"scroll","x":1,"y":1,"amount":100}')).toMatchObject({
      ok: true,
      action: { amount: 30 },
    });
  });
});

const screen: ScreenCapture = {
  images: [{ data: new Uint8Array(1), mediaType: 'image/jpeg', width: 1000, height: 500 }],
  geometry: [
    {
      display: { id: 1, bounds: { x: 0, y: 0, width: 2000, height: 1000 }, scaleFactor: 1 },
      imageWidth: 1000,
      imageHeight: 500,
    },
  ],
  cursorScreen: 1,
};

function fakes(replies: string[], opts: { confirm?: boolean; confirmMode?: 'risky' | 'always' } = {}) {
  const inputs: InputAction[] = [];
  const confirms: string[] = [];
  const questions: string[] = [];
  const ac = new AbortController();
  const chat: VisionChatProvider = {
    id: 'fake',
    async *stream(req) {
      questions.push(req.question);
      yield replies.shift() ?? '{"action":"done","say":"Done."}';
    },
  };
  const capture: CapturePort = { begin: () => undefined, take: async () => screen };
  const overlay: OverlayPort = { state: () => undefined, point: () => undefined, message: () => undefined };
  const deps: AgentDeps = {
    chat,
    capture,
    overlay,
    input: { run: async (a) => void inputs.push(a) },
    confirm: async (text) => {
      confirms.push(text);
      return opts.confirm ?? true;
    },
    confirmMode: opts.confirmMode ?? 'risky',
    signal: ac.signal,
    settleMs: 0,
  };
  return { deps, inputs, confirms, questions, ac };
}

describe('runAgent', () => {
  it('runs steps in order, mapping clicks to the display, then reports done', async () => {
    const f = fakes([
      '{"action":"click","x":500,"y":250,"target":"Search","say":"Clicking search"}',
      '{"action":"type","text":"notepad"}',
      '{"action":"key","keys":"enter"}',
      '{"action":"done","say":"Notepad is open."}',
    ]);
    const r = await runAgent('open notepad', f.deps);
    expect(r.outcome).toBe('done');
    expect(r.summary).toBe('Notepad is open.');
    expect(f.inputs.map((i) => i.kind)).toEqual(['click', 'type', 'keys']);
    const click = f.inputs[0];
    expect(click?.kind === 'click' && click.at.global).toEqual({ x: 1000, y: 500 });
    // Later steps see what was already done.
    expect(f.questions[3]).toContain('3. pressed enter');
  });

  it('asks before risky steps and stops when the user declines', async () => {
    const f = fakes(['{"action":"click","x":5,"y":5,"target":"Send","say":"Sending the email","risky":true}'], {
      confirm: false,
    });
    const r = await runAgent('send it', f.deps);
    expect(f.confirms).toEqual(['Sending the email']);
    expect(f.inputs).toEqual([]);
    expect(r.outcome).toBe('stopped');
  });

  it('retries a bad reply, then gives up with an error', async () => {
    const f = fakes(['not json', '{"action":"done","say":"ok"}']);
    expect((await runAgent('x', f.deps)).outcome).toBe('done');
    expect(f.questions[1]).toContain('not a valid action');
    const g = fakes(['a', 'b', 'c']);
    await expect(runAgent('x', g.deps)).rejects.toThrow(/valid actions/);
  });

  it('stops at the step limit and when cancelled', async () => {
    const f = fakes(Array.from({ length: 10 }, () => '{"action":"wait","ms":200}'));
    const r = await runAgent('x', { ...f.deps, maxSteps: 3 });
    expect(r.outcome).toBe('failed');
    expect(r.steps).toHaveLength(3);
    const g = fakes(['{"action":"key","keys":"enter"}']);
    g.ac.abort();
    expect((await runAgent('x', g.deps)).outcome).toBe('stopped');
  });
});
