/**
 * Agent mode (feature parity with the official app's "agents"): Clicky carries out a task with
 * the mouse and keyboard. Each step sends fresh screenshots plus the steps so far, and the model
 * replies with exactly one JSON action. The loop is bounded, every step can be cancelled with Esc
 * (the interaction signal), and risky steps wait for the user's go-ahead.
 */

import { mapPointToDisplay } from './coordinates.js';
import { StageError } from './errors.js';
import { delay, withTimeout } from './pipeline/budget.js';
import type { CapturePort, InputAction, InputPort, OverlayPort, ScreenCapture } from './ports.js';
import type { VisionChatProvider } from './providers.js';
import type { AgentConfirmMode } from './settings.js';

export type AgentAction =
  | {
      type: 'click' | 'double_click' | 'right_click';
      x: number;
      y: number;
      screen: number | null;
      target: string;
      say: string;
      risky: boolean;
    }
  | { type: 'type'; text: string; say: string; risky: boolean }
  | { type: 'key'; keys: string[]; say: string; risky: boolean }
  | { type: 'scroll'; x: number; y: number; screen: number | null; amount: number; say: string; risky: boolean }
  | { type: 'wait'; ms: number; say: string; risky: boolean }
  | { type: 'done' | 'fail'; say: string; risky: boolean };

/** "hey clicky agent, …", "agent: …", "Agent …" → the task; anything else → null. */
export function agentGoal(question: string): string | null {
  const m = /^\s*(?:hey\s+)?(?:clicky[\s,]+)?agent\b[\s,:.!-]*(.*)$/is.exec(question);
  if (!m) return null;
  const goal = (m[1] ?? '').trim();
  return goal.length >= 3 ? goal : null;
}

const KEY_NAMES = new Set([
  'ctrl',
  'shift',
  'alt',
  'win',
  'enter',
  'tab',
  'esc',
  'backspace',
  'delete',
  'space',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const KEY_ALIASES: Record<string, string> = {
  control: 'ctrl',
  return: 'enter',
  escape: 'esc',
  del: 'delete',
  windows: 'win',
  cmd: 'win',
  meta: 'win',
  pgup: 'pageup',
  pgdn: 'pagedown',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};

/** "Ctrl + Shift + S" → ['ctrl', 'shift', 's']; null if any part isn't a key we can press. */
export function parseKeys(combo: string): string[] | null {
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => KEY_ALIASES[k] ?? k);
  if (!parts.length || parts.length > 4) return null;
  return parts.every((k) => KEY_NAMES.has(k) || /^[a-z0-9]$/.test(k)) ? parts : null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Parse the model's reply (one JSON object, possibly wrapped in prose or a code fence). */
export function parseAgentAction(reply: string): { ok: true; action: AgentAction } | { ok: false; error: string } {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, error: 'no JSON object in the reply' };
  let o: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(reply.slice(start, end + 1));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: 'not a JSON object' };
    o = v as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `invalid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  const type = str(o['action'] ?? o['type']).toLowerCase();
  const say = str(o['say'], 160);
  const risky = o['risky'] === true;
  const screen = num(o['screen']);
  const scr = screen !== null && screen >= 1 ? Math.round(screen) : null;
  switch (type) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      const x = num(o['x']);
      const y = num(o['y']);
      if (x === null || y === null) return { ok: false, error: `${type} needs numeric x and y` };
      return { ok: true, action: { type, x, y, screen: scr, target: str(o['target'], 80), say, risky } };
    }
    case 'type': {
      const text = typeof o['text'] === 'string' ? o['text'].slice(0, 2000) : '';
      if (!text) return { ok: false, error: 'type needs text' };
      return { ok: true, action: { type, text, say, risky } };
    }
    case 'key': {
      const keys = parseKeys(str(o['keys'] ?? o['key'], 60));
      if (!keys) return { ok: false, error: `unknown key "${str(o['keys'] ?? o['key'], 60)}"` };
      return { ok: true, action: { type, keys, say, risky } };
    }
    case 'scroll': {
      const x = num(o['x']);
      const y = num(o['y']);
      const amount = num(o['amount']);
      if (x === null || y === null || amount === null || amount === 0)
        return { ok: false, error: 'scroll needs x, y and a non-zero amount' };
      return {
        ok: true,
        action: { type, x, y, screen: scr, amount: Math.max(-30, Math.min(30, Math.round(amount))), say, risky },
      };
    }
    case 'wait':
      return { ok: true, action: { type, ms: Math.max(200, Math.min(5000, num(o['ms']) ?? 1000)), say, risky } };
    case 'done':
    case 'fail':
      return { ok: true, action: { type, say: say || (type === 'done' ? 'Done.' : "I couldn't do that."), risky } };
    default:
      return { ok: false, error: `unknown action "${type}"` };
  }
}

const AGENT_PROMPT = `You are Clicky's agent. You operate the user's Windows PC with the mouse and keyboard to complete
the task they asked for. Every turn you get fresh screenshots and the list of steps taken so far.

Reply with ONLY one JSON object, no other text, describing the single next action. Examples:
{"action":"click","x":412,"y":88,"target":"Save button","say":"Clicking Save"}
{"action":"type","text":"quarterly report","say":"Typing the file name"}
{"action":"key","keys":"ctrl+s","say":"Saving"}

Actions:
- click, double_click, right_click: x,y are the centre of the element in screenshot pixels (origin
  top-left). Add "screen":N if it is not on the first screenshot. Always include "target".
- type: {"text": "..."} types into the focused field. Click the field first if it isn't focused.
- key: {"keys": "..."} one key or shortcut, e.g. "enter", "esc", "ctrl+l", "alt+tab", "win".
- scroll: {"x":..,"y":..,"amount":N} N notches, positive scrolls down, negative up.
- wait: {"ms":N} when something is still loading.
- done: {"say":"..."} when the task is complete. "say" is one short spoken sentence about what you did.
- fail: {"say":"..."} when the task is impossible or unsafe; say why in one short sentence.

Rules:
- Add "risky": true to any step that sends a message or email, posts, buys or pays, deletes,
  submits a form, installs software, or changes account, privacy or security settings. The user
  will be asked to allow it.
- Never type passwords, card numbers, one-time codes or other secrets. Use fail and ask the user to
  do that part themselves.
- Look at the new screenshot to check that the previous step worked before going on. If it didn't,
  try a different way instead of repeating it.
- Prefer reliable keyboard shortcuts and the Windows search (key "win", then type) to open apps.
- "say" is a few words for the user, like "Opening the File menu".`;

function agentSystemPrompt(screens: ScreenCapture, userContext?: string): string {
  const lines = [AGENT_PROMPT, '', 'Screenshots in this message:'];
  screens.images.forEach((img, i) =>
    lines.push(
      `- screen${i + 1}: ${img.width}x${img.height} px${i + 1 === screens.cursorScreen ? ' (the mouse is on this screen)' : ''}`,
    ),
  );
  const ctx = userContext?.trim();
  if (ctx) lines.push('', `About the user: ${ctx.slice(0, 500)}`);
  return lines.join('\n');
}

export interface AgentDeps {
  chat: VisionChatProvider;
  capture: CapturePort;
  input: InputPort;
  overlay: OverlayPort;
  /** Ask the user to allow a step; resolves false if they decline or don't answer. */
  confirm(text: string, signal: AbortSignal): Promise<boolean>;
  confirmMode: AgentConfirmMode;
  signal: AbortSignal;
  maxSteps?: number;
  userContext?: string;
  log?(message: string): void;
  /** Called with a short description as each step starts, for captions and history. */
  onStep?(say: string): void;
  /** Pause between a step and the next screenshot so the UI can settle. */
  settleMs?: number;
}

export interface AgentResult {
  outcome: 'done' | 'failed' | 'stopped';
  /** What to say to the user at the end. */
  summary: string;
  steps: string[];
}

export const AGENT_MAX_STEPS = 25;
const STEP_FIRST_TOKEN_MS = 20_000;
const STEP_TOTAL_MS = 45_000;
/** Consecutive unparseable replies before giving up. */
const MAX_BAD_REPLIES = 2;

async function ask(deps: AgentDeps, system: string, question: string, screens: ScreenCapture): Promise<string> {
  const stream = deps.chat.stream({
    system,
    history: [],
    question,
    images: screens.images,
    maxTokens: 400,
    signal: deps.signal,
  });
  const it = stream[Symbol.asyncIterator]();
  let text = '';
  const started = Date.now();
  try {
    for (let first = true; ; first = false) {
      const left = first ? STEP_FIRST_TOKEN_MS : Math.max(1, STEP_TOTAL_MS - (Date.now() - started));
      const r = await withTimeout(it.next(), left, 'answer', 'the agent step', deps.signal);
      if (r.done) break;
      text += r.value;
    }
  } finally {
    void it.return?.().catch(() => undefined);
  }
  return text;
}

function describe(a: AgentAction): string {
  switch (a.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
      return `${a.type.replace('_', ' ')} on "${a.target || 'element'}" at ${a.x},${a.y}${a.screen ? ` (screen${a.screen})` : ''}`;
    case 'type':
      return `typed "${a.text.length > 60 ? `${a.text.slice(0, 60)}…` : a.text}"`;
    case 'key':
      return `pressed ${a.keys.join('+')}`;
    case 'scroll':
      return `scrolled ${a.amount > 0 ? 'down' : 'up'} ${Math.abs(a.amount)} at ${a.x},${a.y}`;
    case 'wait':
      return `waited ${a.ms} ms`;
    default:
      return a.type;
  }
}

/** Run the task to completion, failure, cancellation or the step limit. Throws StageError on provider failure. */
export async function runAgent(goal: string, deps: AgentDeps): Promise<AgentResult> {
  const steps: string[] = [];
  const max = deps.maxSteps ?? AGENT_MAX_STEPS;
  let note = '';
  let bad = 0;
  const stopped = (): AgentResult => ({ outcome: 'stopped', summary: 'Okay, I stopped.', steps });
  for (let i = 0; i < max;) {
    if (deps.signal.aborted) return stopped();
    const screens = await deps.capture.take(deps.signal);
    if (deps.signal.aborted) return stopped();
    const question = [
      `Task: ${goal}`,
      steps.length ? `Steps so far:\n${steps.map((s, n) => `${n + 1}. ${s}`).join('\n')}` : 'No steps taken yet.',
      note,
      'What is the next action?',
    ]
      .filter(Boolean)
      .join('\n\n');
    const reply = await ask(deps, agentSystemPrompt(screens, deps.userContext), question, screens);
    if (deps.signal.aborted) return stopped();
    const parsed = parseAgentAction(reply);
    if (!parsed.ok) {
      deps.log?.(`agent reply rejected: ${parsed.error}: ${reply.slice(0, 200)}`);
      if (++bad > MAX_BAD_REPLIES)
        throw new StageError('answer', 'bad-output', `the agent replies weren't valid actions (${parsed.error})`, {
          provider: deps.chat.id,
        });
      note = `Your last reply was not a valid action (${parsed.error}). Reply with one JSON object only.`;
      continue;
    }
    bad = 0;
    note = '';
    const a = parsed.action;
    if (a.type === 'done') return { outcome: 'done', summary: a.say, steps };
    if (a.type === 'fail') return { outcome: 'failed', summary: a.say, steps };
    i++;

    const say = a.say || describe(a);
    deps.onStep?.(say);
    let input: InputAction | null = null;
    if (a.type === 'click' || a.type === 'double_click' || a.type === 'right_click' || a.type === 'scroll') {
      const mapped = mapPointToDisplay(a, screens.geometry);
      if (!mapped.ok) {
        note = `That position was off the screenshot (${mapped.detail}). Use coordinates inside the image.`;
        steps.push(`(skipped: ${describe(a)} was off screen)`);
        continue;
      }
      // The companion flies to the target first, so the user sees where Clicky is about to act.
      deps.overlay.point(mapped.point, a.type === 'scroll' ? say : a.target || say);
      input =
        a.type === 'scroll'
          ? { kind: 'scroll', at: mapped.point, amount: a.amount }
          : {
              kind: 'click',
              at: mapped.point,
              button: a.type === 'right_click' ? 'right' : 'left',
              count: a.type === 'double_click' ? 2 : 1,
            };
    } else if (a.type === 'type') {
      deps.overlay.message(say, 'info');
      input = { kind: 'type', text: a.text };
    } else if (a.type === 'key') {
      deps.overlay.message(say, 'info');
      input = { kind: 'keys', keys: a.keys };
    }

    if (a.risky || deps.confirmMode === 'always') {
      const ok = await deps.confirm(say, deps.signal);
      if (!ok || deps.signal.aborted) return stopped();
    } else if (input?.kind === 'click' || input?.kind === 'scroll') {
      await delay(450); // let the flight land so the click doesn't look like it came from nowhere
    }
    if (deps.signal.aborted) return stopped();
    if (a.type === 'wait') await delay(a.ms);
    else if (input) await deps.input.run(input, deps.signal);
    steps.push(describe(a));
    await delay(deps.settleMs ?? 700);
  }
  return {
    outcome: 'failed',
    summary: `I stopped after ${max} steps without finishing. You can ask me to continue.`,
    steps,
  };
}
