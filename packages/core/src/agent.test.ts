import { describe, expect, it } from 'vitest';
import {
  actionGoal,
  agentGoal,
  lessonFrom,
  lessonHints,
  parseAgentAction,
  parseStepCheck,
  parseKeys,
  runAgent,
  type AgentDeps,
} from './agent.js';
import type { CapturePort, InputAction, OverlayPort, ScreenCapture } from './ports.js';
import type { VisionChatProvider } from './providers.js';

describe('agentGoal with the "Clickey" trigger', () => {
  it('runs tasks addressed to Clickey or Clicky, and keeps Agent working', () => {
    expect(agentGoal('Clickey, can you open the vscode application')).toBe('can you open the vscode application');
    expect(agentGoal('clicky open chrome')).toBe('open chrome');
    expect(agentGoal('Click y, open notepad')).toBe('open notepad');
    expect(agentGoal('agents, open the vscode app')).toBe('open the vscode app');
  });

  it('answers questions addressed to Clicky normally', () => {
    expect(agentGoal('Clicky, where is the save button?')).toBeNull();
    expect(agentGoal('Clickey how do I export this')).toBeNull();
    expect(agentGoal('Clickey')).toBeNull();
    expect(agentGoal('Click the save button')).toBeNull();
  });
});

describe('agentGoal', () => {
  it('recognises the ways people ask for the agent', () => {
    expect(agentGoal('Agent, open Notepad and type hello')).toBe('open Notepad and type hello');
    expect(agentGoal('agent open settings')).toBe('open settings');
    expect(agentGoal('Where is the agent setting?')).toBeNull();
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
    expect(parseAgentAction('{"action":"key","keys":"win"}')).toMatchObject({ ok: false });
    expect(parseAgentAction('{"action":"key","keys":"win+r"}')).toMatchObject({ ok: true });
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
      '{"action":"click","x":500,"y":500,"target":"Search","say":"Clicking search"}',
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

describe('actionGoal (asked first, no "Agent" prefix needed)', () => {
  it('recognises requests to do something', () => {
    expect(actionGoal('can you open linkedin and scroll through my feed')).toBe(
      'open linkedin and scroll through my feed',
    );
    expect(actionGoal('Hey Clicky, please search for flights to Dubai')).toBe('search for flights to Dubai');
    expect(actionGoal('Open Notepad and type hello')).toBe('Open Notepad and type hello');
    expect(actionGoal('turn on dark mode')).toBe('turn on dark mode');
  });

  it('keeps questions as questions', () => {
    expect(actionGoal('how do I open settings?')).toBeNull();
    expect(actionGoal('where is the save button')).toBeNull();
    expect(actionGoal('what type of chart is this')).toBeNull();
    expect(actionGoal('open')).toBeNull();
    expect(agentGoal('can you open linkedin')).toBeNull();
    expect(actionGoal('Click the save button')).toBe('Click the save button');
  });
});

describe('learning from runs', () => {
  it('keeps what worked and offers it for similar tasks', () => {
    const lesson = lessonFrom(
      'open the search menu in Claude',
      {
        outcome: 'done',
        summary: 'ok',
        steps: ['click on "Search" at 30,20', 'pressed esc'],
        checked: [
          { step: 'click on "Search" at 30,20', ok: true },
          { step: 'pressed esc', ok: false },
        ],
      },
      1,
    );
    expect(lesson?.steps).toEqual(['click on "Search" at 30,20']);
    expect(lessonHints('open search menu in claude', lesson ? [lesson] : [])).toContain('1. click on "Search"');
    expect(lessonHints('play music on spotify', lesson ? [lesson] : [])).toBeUndefined();
    expect(lessonFrom('x', { outcome: 'stopped', summary: '', steps: [] }, 1)).toBeNull();
  });

  it('reads the per-step check', () => {
    expect(parseStepCheck('{"action":"key","keys":"enter","check":"failed"}')).toBe('failed');
    expect(parseStepCheck('{"action":"done","say":"ok"}')).toBeNull();
  });
});

describe('Start menu guard', () => {
  it('rejects the bare Windows key but allows Win+R', () => {
    expect(parseAgentAction('{"action":"key","keys":"win"}')).toMatchObject({ ok: false });
    expect(parseAgentAction('{"action":"key","keys":"win+r"}')).toMatchObject({ ok: true });
  });
});

describe('"click here" is how speech recognition often hears the name', () => {
  it('starts a task', () => {
    expect(agentGoal('Click here, open Grokbot.')).toBe('open Grokbot');
  });
});

describe('long tasks: notes and sheets', () => {
  it('keeps notes across steps and saves the noted rows as a sheet', async () => {
    const f = fakes([
      '{"action":"note","row":["AI Lead","Acme","Dubai"],"say":"Noting a job"}',
      '{"action":"note","row":["ML Engineer","Beta","Abu Dhabi"],"text":"Feed has 2 job posts"}',
      '{"action":"save_sheet","name":"LinkedIn jobs","columns":["Title","Company","Location"]}',
      '{"action":"done","say":"Saved 2 jobs."}',
    ]);
    const saved: { name: string; columns: string[]; rows: string[][] }[] = [];
    const r = await runAgent('jobs to excel', {
      ...f.deps,
      saveSheet: async (name, columns, rows) => {
        saved.push({ name, columns, rows });
        return 'C:/Docs/Clicky/LinkedIn jobs.xlsx';
      },
    });
    expect(r.outcome).toBe('done');
    expect(saved).toEqual([
      {
        name: 'LinkedIn jobs',
        columns: ['Title', 'Company', 'Location'],
        rows: [
          ['AI Lead', 'Acme', 'Dubai'],
          ['ML Engineer', 'Beta', 'Abu Dhabi'],
        ],
      },
    ]);
    expect(f.inputs).toEqual([]); // notes and sheets never touch the screen
    expect(f.questions[2]).toContain('Rows noted so far (2)');
    expect(f.questions[2]).toContain('Feed has 2 job posts');
    expect(f.questions[3]).toContain('saved 2 rows to C:/Docs/Clicky/LinkedIn jobs.xlsx');
  });

  it('asks for rows before saving an empty sheet', async () => {
    const f = fakes(['{"action":"save_sheet","name":"x","columns":["a"]}', '{"action":"done"}']);
    await runAgent('x', { ...f.deps, saveSheet: async () => 'never' });
    expect(f.questions[1]).toContain('no rows to save yet');
  });

  it('retries a step whose model call failed', async () => {
    const f = fakes(['{"action":"done","say":"ok"}']);
    let calls = 0;
    const flaky: VisionChatProvider = {
      id: 'flaky',
      async *stream(req) {
        if (calls++ === 0) throw new Error('busy');
        yield* f.deps.chat.stream(req);
      },
    };
    const r = await runAgent('x', { ...f.deps, chat: flaky });
    expect(r.outcome).toBe('done');
    expect(calls).toBe(2);
  });

  it('puts skills and the briefing in front of the model', async () => {
    let system = '';
    const f = fakes([]);
    const spy: VisionChatProvider = {
      id: 'spy',
      async *stream(req) {
        system = req.system;
        yield* f.deps.chat.stream(req);
      },
    };
    await runAgent('merge PRs', {
      ...f.deps,
      chat: spy,
      skills: 'Skill "GitHub": open /pulls',
      briefing: '# Clicky briefing',
    });
    expect(system).toContain('# Clicky briefing');
    expect(f.questions[0]).toContain('Skill "GitHub"');
  });
});

describe('recovering within the run', () => {
  it('reviews and keeps going instead of stopping after failed steps', async () => {
    const fail = (n: number) => `{"action":"key","keys":"f${n}","check":"failed"}`;
    const f = fakes([
      '{"action":"key","keys":"f1"}',
      fail(2),
      fail(3),
      fail(4),
      fail(5), // fourth failed check: the run reviews itself instead of stopping
      'Clicked the wrong thing. Use the open action instead.', // the review
      '{"action":"open","url":"https://example.com","check":"failed"}',
      '{"action":"done","say":"Opened it.","check":"worked"}',
      '{"complete": true}',
    ]);
    const r = await runAgent('open example', f.deps);
    expect(r.outcome).toBe('done');
    expect(f.questions.some((q) => q.includes('Use the open action instead'))).toBe(true);
  });

  it('does not accept done until the final check agrees', async () => {
    const f = fakes([
      '{"action":"key","keys":"ctrl+s"}',
      '{"action":"key","keys":"enter","check":"worked"}',
      '{"action":"done","say":"Saved.","check":"worked"}',
      '{"complete": false, "missing": "the file name was never typed"}',
      'Type the file name before pressing enter.',
      '{"action":"type","text":"notes.txt"}',
      '{"action":"done","say":"Saved as notes.txt.","check":"worked"}',
      '{"complete": true}',
    ]);
    const r = await runAgent('save as notes.txt', f.deps);
    expect(r.outcome).toBe('done');
    expect(r.summary).toBe('Saved as notes.txt.');
    expect(f.inputs.some((i) => i.kind === 'type')).toBe(true);
  });

  it('repeats a step freely while it keeps working (closing many windows)', async () => {
    const f = fakes([
      ...Array.from({ length: 5 }, () => '{"action":"key","keys":"alt+f4","check":"worked"}'),
      '{"action":"done","say":"All closed.","check":"worked"}',
      '{"complete": true}',
    ]);
    const r = await runAgent('close all windows', f.deps);
    expect(r.outcome).toBe('done');
    expect(f.inputs.filter((i) => i.kind === 'keys')).toHaveLength(5);
  });

  it('closes windows by title and always asks first', async () => {
    const f = fakes(['{"action":"close_window","title":"Untitled - Notepad","say":"Closing Notepad"}']);
    await runAgent('close notepad', { ...f.deps, openWindows: async () => ['Untitled - Notepad — notepad'] });
    expect(f.confirms).toEqual(['Closing Notepad']);
    expect(f.inputs).toEqual([{ kind: 'close', title: 'Untitled - Notepad' }]);
    expect(f.questions[0]).toContain('Open windows (front first):\n- Untitled - Notepad — notepad');
  });
});

describe('apps are launched, not hunted for on the taskbar', () => {
  it('turns a taskbar click on an installed app into an open', async () => {
    const f = fakes(['{"action":"click","x":300,"y":980,"target":"Notepad icon on the taskbar"}']);
    await runAgent('open notepad', { ...f.deps, inventory: { apps: ['Notepad', 'Note'], folders: [] } });
    expect(f.inputs[0]).toEqual({ kind: 'open', app: 'Notepad' });
  });
});

describe('showing what Clicky understood', () => {
  it('puts the restated task on the notch from the first step', async () => {
    const f = fakes([
      '{"action":"open","app":"Notepad","understood":"Open Notepad and write a shopping list"}',
      '{"action":"done","say":"Done.","check":"worked"}',
    ]);
    const progress: string[] = [];
    await runAgent('an notepad and right a shopping list', { ...f.deps, onProgress: (p) => progress.push(p.goal) });
    expect(progress[0]).toBe('Open Notepad and write a shopping list');
  });
});

describe('drawing on the screen is not an agent task', () => {
  it('leaves "draw … on my screen" to the answer, keeps "draw … in Paint" a task', () => {
    expect(agentGoal('Clicky, draw a star on my screen.')).toBeNull();
    expect(agentGoal('Clicky, circle the save button')).toBeNull();
    expect(agentGoal('Clicky, draw a house in Paint')).toBe('draw a house in Paint');
  });
});
