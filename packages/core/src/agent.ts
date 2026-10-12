/**
 * Agent mode (feature parity with the official app's "agents"): Clicky carries out a task with
 * the mouse and keyboard. Each step sends fresh screenshots plus the steps so far, and the model
 * replies with exactly one JSON action. The loop is bounded, every step can be cancelled with Esc
 * (the interaction signal), and risky steps wait for the user's go-ahead.
 */

import { fromThousandths, mapPointToDisplay, placeGlobal, type MappedPoint } from './coordinates.js';
import { splitWake } from './wake.js';
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
  /** Hold the left button down along a path: draw in Paint or a whiteboard, move a slider, drag a file. */
  | { type: 'drag'; path: { x: number; y: number }[]; screen: number | null; say: string; risky: boolean }
  | { type: 'open'; app: string; url: string; path: string; say: string; risky: boolean }
  /** Write down something seen on screen (free text and/or one table row) to use in later steps. */
  | { type: 'note'; text: string; row: string[] | null; rows?: string[][]; say: string; risky: boolean }
  /** Read a folder's contents (names, sizes, dates) instead of squinting at File Explorer. */
  | { type: 'list_files'; path: string; say: string; risky: boolean }
  /** Move or copy the files matching a pattern from one folder to another in one step. */
  | { type: 'move_files'; from: string; pattern: string; to: string; copy: boolean; say: string; risky: boolean }
  /** Save a table as an .xlsx file; rows default to every noted row. */
  | { type: 'save_sheet'; name: string; columns: string[]; rows: string[][] | null; say: string; risky: boolean }
  /** Close a window by its title (from the open-windows list); always asked unless Allow all is on. */
  | { type: 'close_window'; title: string; say: string; risky: boolean }
  /** Act on a control from the "Controls" list by its number: more exact than a click by position. */
  | {
      type: 'click_element';
      id: number;
      op: 'click' | 'double' | 'right';
      target: string;
      say: string;
      risky: boolean;
    }
  /** Put text into a field from the "Controls" list (replaces what's there). */
  | { type: 'set_value'; id: number; text: string; target: string; say: string; risky: boolean }
  | { type: 'done' | 'fail'; say: string; risky: boolean };

const cells = (v: unknown, max: number): string[] | null =>
  Array.isArray(v) && v.length
    ? v
        .slice(0, max)
        .map((c) => (typeof c === 'string' ? c : c === null || c === undefined ? '' : String(c)).slice(0, 500))
    : null;

/** The model's verdict on its previous step, judged from the new screenshot. */
export type StepCheck = 'worked' | 'failed' | null;

/** Asking how or where is a question, even if an action verb follows ("how do I open…"). */
const QUESTION_START = /^(?:how|where|what|why|when|which|who|whose|is|are|was|does|do|did|should|explain|tell me)\b/i;
/**
 * The agent-mode trigger is the assistant's name (owner's choice, 2026-10-11): "Clickey, open VS
 * Code" or "Clicky, can you open Chrome". Speech recognition spellings ("click y", "klicky") and the
 * older "Agent"/"Agents" work too. A question after the name ("Clicky, where is Save?") is still
 * answered normally.
 */
/** The task when the request starts with the name (or the older "Agent"); null otherwise (including questions). */
export function agentGoal(question: string): string | null {
  const { woke, rest } = splitWake(question);
  const m = woke ? null : /^\s*agents?\b[\s,:.!-]*(.*)$/is.exec(question);
  if (!woke && !m) return null;
  const goal = (woke ? rest : (m?.[1] ?? '')).trim().replace(/[.!]+$/, '');
  if (goal.length < 3 || QUESTION_START.test(goal)) return null;
  // "Draw a star on my screen" is drawn by Clicky itself, over the screen; "draw … in Paint" is a task.
  if (onScreenDrawing(goal)) return null;
  return goal;
}

const ACTION_START =
  /^(?:(?:hey\s+)?clicky[\s,]+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+|go\s+ahead\s+and\s+)?((?:open|launch|close|scroll|click|type|search(?:\s+for)?|go\s+to|navigate\s+to|visit|play|pause|switch\s+to|fill\s+(?:in|out)|rename|move|turn\s+(?:on|off))\b.*)$/is;

/**
 * A request to mark the screen itself ("draw a star", "put a box around the taskbar", "write hello
 * in the middle of the screen", "box the top-left corner"), not inside an app: Clicky draws it.
 */
export function onScreenDrawing(text: string): boolean {
  const t = splitWake(text).rest.replace(/^(?:can|could|would|will)\s+you\s+|^please\s+/i, '');
  if (DRAW_APP.test(t)) return false;
  return (
    /^(?:draw|sketch|circle|highlight|underline|mark|box|outline|cross out|tick|point an arrow)\b/i.test(t) ||
    /^put (?:a |an )?(?:box|circle|ring|arrow|line|tick|cross|mark)s?\b/i.test(t) ||
    /^write\b[^.?!]*\b(?:on|in the middle of|across|at the (?:top|bottom)[\w ]*of) (?:my|the|this) screen\b/i.test(t) ||
    /^(?:can you |could you )?draw on (?:my|the) screen\b/i.test(t)
  );
}

/** Drawing inside an app ("draw a house in Paint") is a task; drawing on the screen is an answer. */
/** A drawing app named in the request ("in Paint", "on the whiteboard"): drawing there is a task. */
export const DRAW_APP =
  /\b(?:in|into|on|using|with)\s+(?:the\s+)?(?:ms\s+|microsoft\s+)?(?:paint(?:\s*3d)?|whiteboard|excalidraw|tldraw|canva|figma|photoshop|krita|gimp)\b/i;

const DRAW_IN_APP =
  /^(?:(?:hey\s+)?clicky[\s,]+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+|go\s+ahead\s+and\s+)?((?:draw|sketch|paint|doodle)\b.*\b(?:in|into|on|using|with)\s+(?:the\s+)?(?:ms\s+|microsoft\s+)?(?:paint(?:\s*3d)?|whiteboard|excalidraw|tldraw|canva|figma|photoshop|krita|gimp)\b.*)$/is;

/**
 * A request to do something on the PC without the "Agent" prefix ("can you open LinkedIn and
 * scroll my feed"). The caller asks the user before handing it to agent mode; questions about how
 * to do something return null and are answered normally.
 */
export function actionGoal(question: string): string | null {
  const q = question.trim().replace(/[?.!]+$/, '');
  if (QUESTION_START.test(splitWake(q).rest)) return null;
  const rest = splitWake(q).rest;
  const goal = (ACTION_START.exec(rest)?.[1] ?? DRAW_IN_APP.exec(rest)?.[1])?.trim() ?? '';
  return goal.split(/\s+/).length >= 2 ? goal : null;
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

/** Most points in one drag: a detailed drawing is several drags, one stroke each. */
export const MAX_DRAG_POINTS = 200;

/** [[x,y],…] or [{x,y},…] → points; null unless there are 2 to MAX_DRAG_POINTS valid ones. */
function dragPath(v: unknown): { x: number; y: number }[] | null {
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_DRAG_POINTS) return null;
  const out: { x: number; y: number }[] = [];
  for (const p of v) {
    const x = num(Array.isArray(p) ? p[0] : (p as Record<string, unknown> | null)?.['x']);
    const y = num(Array.isArray(p) ? p[1] : (p as Record<string, unknown> | null)?.['y']);
    if (x === null || y === null) return null;
    out.push({ x, y });
  }
  return out;
}

/** Parse the model's reply (one JSON object, possibly wrapped in prose or a code fence). */
export function parseStepCheck(reply: string): StepCheck {
  const m = /"check"\s*:\s*"(worked|failed)"/i.exec(reply);
  return m?.[1] ? (m[1].toLowerCase() as StepCheck) : null;
}

/**
 * Some models answer in tool-call markup instead of JSON
 * (`<parameter name="action">click</parameter><parameter name="x">412</parameter>…`): read it the
 * same way, values that look like JSON (numbers, arrays) parsed as JSON. Null if there's none.
 */
function fromMarkup(reply: string): Record<string, unknown> | null {
  const o: Record<string, unknown> = {};
  for (const m of reply.matchAll(/<parameter name="([\w-]+)">([\s\S]*?)<\/parameter>/g)) {
    const raw = (m[2] ?? '').trim();
    let v: unknown = raw;
    if (/^(?:-?\d+(?:\.\d+)?|true|false|\[[\s\S]*\]|\{[\s\S]*\})$/.test(raw)) {
      try {
        v = JSON.parse(raw);
      } catch {
        // keep the text
      }
    }
    if (m[1]) o[m[1]] = v;
  }
  const invoke = /<invoke name="([\w-]+)"/.exec(reply)?.[1];
  if (invoke && o['action'] === undefined) o['action'] = invoke;
  return Object.keys(o).length ? o : null;
}

export function parseAgentAction(reply: string): { ok: true; action: AgentAction } | { ok: false; error: string } {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  const markup = fromMarkup(reply);
  let o: Record<string, unknown>;
  if (markup && (start === -1 || end <= start || reply.indexOf('<parameter') < start)) o = markup;
  else {
    if (start === -1 || end <= start) return { ok: false, error: 'no JSON object in the reply' };
    try {
      const v: unknown = JSON.parse(reply.slice(start, end + 1));
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: 'not a JSON object' };
      o = v as Record<string, unknown>;
    } catch (e) {
      return { ok: false, error: `invalid JSON (${e instanceof Error ? e.message : String(e)})` };
    }
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
      // The Start menu sits above every app window (Clicky's triangle included): never open it.
      if (keys.length === 1 && keys[0] === 'win')
        return {
          ok: false,
          error:
            'the Start menu is not allowed; click the app on the taskbar or desktop, or use win+r and type its name',
        };
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
    case 'drag': {
      const path = dragPath(o['path'] ?? (o['from'] && o['to'] ? [o['from'], o['to']] : null));
      if (!path) return { ok: false, error: `drag needs "path": 2 to ${MAX_DRAG_POINTS} [x,y] points` };
      return { ok: true, action: { type, path, screen: scr, say, risky } };
    }
    case 'open': {
      const app = str(o['app'], 120);
      const url = str(o['url'], 500);
      const path = str(o['path'], 400);
      if (!app && !url && !path) return { ok: false, error: 'open needs an app, url or path' };
      if (url && !/^https?:\/\//i.test(url)) return { ok: false, error: 'url must start with http:// or https://' };
      return { ok: true, action: { type, app, url, path, say, risky } };
    }
    case 'note': {
      const text = typeof o['text'] === 'string' ? o['text'].trim().slice(0, 1500) : '';
      const row = cells(o['row'], 20);
      // A whole screen of items at once: {"rows": [[…], […]]}.
      const many = Array.isArray(o['rows'])
        ? o['rows']
            .slice(0, 100)
            .map((r) => cells(r, 20))
            .filter((r): r is string[] => r !== null)
        : [];
      if (!text && !row && !many.length) return { ok: false, error: 'note needs text, a row or rows' };
      return { ok: true, action: { type, text, row, ...(many.length ? { rows: many } : {}), say, risky } };
    }
    case 'list_files': {
      const path = str(o['path'] ?? o['folder'], 400);
      if (!path) return { ok: false, error: 'list_files needs the folder path' };
      return { ok: true, action: { type, path, say, risky } };
    }
    case 'move_files': {
      const from = str(o['from'], 400);
      const to = str(o['to'], 400);
      const pattern = str(o['pattern'] ?? o['files'], 200) || '*';
      if (!from || !to) return { ok: false, error: 'move_files needs "from" and "to" folders' };
      return { ok: true, action: { type, from, pattern, to, copy: o['copy'] === true, say, risky } };
    }
    case 'save_sheet': {
      const columns = cells(o['columns'], 20) ?? [];
      const rows = Array.isArray(o['rows'])
        ? o['rows']
            .slice(0, 1000)
            .map((r) => cells(r, 20))
            .filter((r): r is string[] => r !== null)
        : null;
      return {
        ok: true,
        action: {
          type,
          name: str(o['name'], 80) || 'Clicky sheet',
          columns,
          rows: rows?.length ? rows : null,
          say,
          risky,
        },
      };
    }
    case 'close_window': {
      const title = str(o['title'] ?? o['window'], 200);
      if (!title) return { ok: false, error: 'close_window needs the window title' };
      return { ok: true, action: { type, title, say, risky: true } };
    }
    case 'click_element':
    case 'double_click_element':
    case 'right_click_element': {
      const id = num(o['id'] ?? o['element']);
      if (id === null || id < 1) return { ok: false, error: `${type} needs the control's number as "id"` };
      const op = type === 'double_click_element' ? 'double' : type === 'right_click_element' ? 'right' : 'click';
      return {
        ok: true,
        action: { type: 'click_element', id: Math.round(id), op, target: str(o['target'], 80), say, risky },
      };
    }
    case 'set_value': {
      const id = num(o['id'] ?? o['element']);
      const text = typeof o['text'] === 'string' ? o['text'].slice(0, 2000) : null;
      if (id === null || id < 1 || text === null)
        return { ok: false, error: 'set_value needs the field\'s number as "id" and the "text"' };
      return { ok: true, action: { type, id: Math.round(id), text, target: str(o['target'], 80), say, risky } };
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

Reply with ONLY one JSON object, no other text, describing the single next action. In your
first reply only, add "understood": the task in one short sentence as you are going to do it
(for example "Make a folder called Receipts on your Desktop"); the user sees it. Speech recognition
often drops or changes small words, so read the task for what the user most likely meant. From the second
step on, include "check": "worked" or "failed" saying whether your previous step had the effect you
wanted, judged from the new screenshot. Examples:
{"action":"click","x":412,"y":88,"target":"Save button","say":"Clicking Save"}
{"action":"type","text":"quarterly report","say":"Typing the file name","check":"worked"}
{"action":"key","keys":"ctrl+s","say":"Saving"}

Actions:
- click_element: {"id":N,"target":"…"} clicks control number N from the "Controls" list (the window
  in front, read from Windows itself). This is the most exact way to click: when what you want is in
  the list, use it instead of click. double_click_element and right_click_element work the same way.
- set_value: {"id":N,"text":"…"} puts text into field number N from the "Controls" list (it replaces
  what's there). Then press enter with key if the field needs it. Use either type or set_value for
  a piece of text, never both: once the screenshot shows the text in place, go on.
- click, double_click, right_click: x,y are the centre of the element in thousandths of the
  screenshot (0–1000 across, 0–1000 down; 0,0 is the top-left corner). Add "screen":N if it is not on the first screenshot. Always include "target".
- type: {"text": "..."} types into the focused field. Click the field first if it isn't focused.
- key: {"keys": "..."} one key or shortcut, e.g. "enter", "esc", "ctrl+l", "alt+tab", "win".
- scroll: {"x":..,"y":..,"amount":N} N notches, positive scrolls down, negative up.
- open: {"app":"Grok Bot"} launches an installed app by its exact name from the list below;
  {"url":"https://…"} opens a website in the user's default browser; {"path":"C:\\…"} opens a folder or file.
  This is the fastest, most reliable way to open things: use it instead of clicking around.
- drag: {"path":[[x1,y1],[x2,y2],…]} holds the left mouse button down, moves through the points
  (thousandths, like click) and lets go. Use it to draw in Paint, a whiteboard or any canvas, and to
  move sliders or drag things. One drag is one pen stroke (2 to 200 points): draw a shape as one
  or more strokes, closing it by ending at its first point. In drawing apps pick the tool and
  colour first, and keep strokes inside the canvas.
- wait: {"ms":N} when something is still loading.
- note: {"text":"..."} and/or {"row":["…","…"]} writes down what you see now (facts, names, links,
  counts, one table row) so you still have it after leaving the page. Your notes come back every turn.
- note can also take {"rows": [[…],[…]]}: note EVERY item you can see on screen in one step
  (a whole page of search results), not one per step.
- list_files: {"path":"C:\\…"} reads a folder's files (name, size, date modified) into your notes:
  use it to find the biggest or newest file, count files, or plan a sort, instead of reading Explorer.
- move_files: {"from":"C:\\…","pattern":"*.pdf","to":"C:\\…\\PDFs"} moves every matching file in
  one step (the "to" folder is created if needed); add "copy": true to copy instead. Use it to sort
  or tidy folders instead of dragging files one by one. It never deletes or replaces files.
- save_sheet: {"name":"LinkedIn jobs","columns":["Title","Company","Location"]} saves an Excel
  (.xlsx) file in Documents\\Clicky with every row you noted (or give "rows": [[…],[…]] yourself).
  The next step tells you where it was saved; open it with {"path": …} so the user sees it.
- close_window: {"title":"…"} closes one window by its exact title from "Open windows". This is
  the reliable way to close windows: use it once per window instead of hunting for X buttons. If
  the app asks to save changes, choose "Cancel" (never "Don't save"), note the window as having
  unsaved work and move on; tell the user about it at the end.
- done: {"say":"..."} when the task is complete. "say" is one or two short spoken sentences with
  the result: what you found (numbers, names, titles) or what you did.
- fail: {"say":"..."} when the task is impossible or unsafe; say why in one short sentence.

Rules:
- Add "risky": true to any step that sends a message or email, posts, comments, applies for a job,
  buys or pays, deletes files or other saved things (emails, files, records), merges or closes a pull
  request, submits a form, installs software, or changes account, privacy or security settings. The
  user will be asked to allow it. Clicking into a field, selecting text and editing or deleting the
  text you are writing are not risky.
- Long tasks across several apps or sites: work through them part by part. Note what you find
  before moving to the next page. Never say done until every part of the task is finished.
- Lists and feeds never end: note what is on screen after every scroll, and stop after about
  eight screens (or once you have what the task asked for) instead of scrolling forever.
- When the task asks you to tell the user something, read it from the screen (scroll if needed),
  then reply done with the answer in "say".
- Never type passwords, card numbers, one-time codes or other secrets. Use fail and ask the user to
  do that part themselves.
- Look at the new screenshot to check that the previous step worked before going on. If it didn't,
  try a different way instead of repeating it. Never click the same thing twice in a row.
- Stop as soon as the task is done: if the last step achieved it (the menu is open, the box is
  focused, the page is showing), reply done right away. Most tasks take one to three steps.
- If the task was to open or focus something the user will type into (a search box, a message
  field) and they didn't say what to type, reply done with a question as "say", e.g. "The search
  box is open. What would you like to search for?"
- Ignore Clicky's own bar at the top of the screen and its triangle; they are not part of the app.
- To open an app that's in "Apps on this PC", use the open action with its exact name. Open exactly
  the app named: Comet is not Chrome, Edge is not Chrome. Only if it isn't installed, open its
  website with {"url": …} (that uses the user's default browser, never a specific one).
- To open a folder or file from "Folders", use {"path": …}.
- Follow "Things the user told you" and "What worked before" when they apply; they come from the
  user's own corrections and earlier runs.
- "say" is a few words for the user, like "Opening the File menu".`;

function agentSystemPrompt(
  screens: ScreenCapture,
  userContext?: string,
  inventory?: { apps: string[]; folders: string[] },
  briefing?: string,
): string {
  const lines = [AGENT_PROMPT];
  if (briefing?.trim()) lines.push('', briefing.trim().slice(0, 6000));
  lines.push('', 'Screenshots in this message:');
  screens.images.forEach((img, i) =>
    lines.push(
      `- screen${i + 1}: ${img.width}x${img.height} px${i + 1 === screens.cursorScreen ? ' (the mouse is on this screen)' : ''}`,
    ),
  );
  if (inventory?.apps.length) lines.push('', `Apps on this PC: ${inventory.apps.slice(0, 250).join('; ')}`);
  if (inventory?.folders.length) lines.push('', `Folders: ${inventory.folders.slice(0, 60).join('; ')}`);
  const ctx = userContext?.trim();
  if (ctx) lines.push('', `About the user: ${ctx.slice(0, 4000)}`);
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
  /** Move the companion to the text caret before typing (the user sees where it types). */
  atCaret?(): void;
  /** How long the companion takes to fly to a target before the click (default 950 ms). */
  flightMs?: number;
  /** The app in front, if it's on the user's never-touch list (checked before every step). */
  blockedApp?(): Promise<string | null>;
  /** Resolves when the user isn't holding the run paused (Pause button). */
  whilePaused?(signal: AbortSignal): Promise<void>;
  /** True if the user used the mouse or keyboard themselves since the last step. */
  userInterrupted?(): boolean;
  /** The user took over: wait (shown on the task bar) until they stop or press Resume. */
  waitForUser?(signal: AbortSignal): Promise<void>;
  /** What's on this PC: installed app names and common folders. */
  inventory?: { apps: string[]; folders: string[] };
  /** Lessons from earlier successful runs of similar tasks, shown to the model as hints. */
  hints?: string;
  /** agents.md: Clicky's standing briefing (role, this PC, how to read screenshots). */
  briefing?: string;
  /** Skills (task playbooks) that match this task. */
  skills?: string;
  /** The files in a folder ("name — size — modified"), or throws if it can't be read. */
  listFiles?(path: string): Promise<string[]>;
  /** Move or copy files matching a pattern; resolves to how many were moved. */
  moveFiles?(from: string, pattern: string, to: string, copy: boolean): Promise<number>;
  /** Save a table as an .xlsx file; resolves to where it was saved. */
  saveSheet?(name: string, columns: string[], rows: string[][]): Promise<string>;
  /** Tokens each step may spend thinking (default 1024). */
  thinkingTokens?: number;
  /** The open windows, front first ("Title — app"), so the agent knows what's on screen. */
  openWindows?(): Promise<string[]>;
  /** What was said and done earlier in this conversation (recent questions, answers and tasks). */
  conversation?: string;
  /** The controls of the window in front, numbered, in global DIP (UI Automation). */
  elements?(): Promise<UiElement[]>;
  /** What another agent driving this PC shows ("Claude started debugging this browser"), or null. */
  otherAgent?(): Promise<string | null>;
  /** How often to look for another agent while waiting for it to finish (default 3 s). */
  otherAgentPollMs?: number;
  /** Check the screen before accepting "done" (default true). */
  verifyDone?: boolean;
  /** Progress for the step strip. */
  onProgress?(p: { goal: string; step: number; max: number; say: string }): void;
}

/** One control of the window in front: what it is, its name and its box (global DIP). */
export interface UiElement {
  id: number;
  kind: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Controls listed for the model, so a long page doesn't crowd out the task. */
const MAX_ELEMENTS = 120;

/** The "Controls" block: number, kind, name and where it is on the screenshots. */
export function elementsText(list: readonly UiElement[], screens: ScreenCapture): string {
  const lines: string[] = [];
  for (const e of list.slice(0, MAX_ELEMENTS)) {
    const at = placeGlobal({ x: e.x + e.w / 2, y: e.y + e.h / 2 }, screens.geometry);
    if (!at) continue;
    const name = e.name ? `"${e.name.replace(/"/g, "'")}"` : '(no name)';
    lines.push(`${e.id} ${e.kind} ${name} at ${at.x},${at.y}${at.screen > 1 ? ` screen${at.screen}` : ''}`);
  }
  return lines.join('\n');
}

export interface AgentResult {
  outcome: 'done' | 'failed' | 'stopped';
  /** What to say to the user at the end. */
  summary: string;
  steps: string[];
  /** Each step with the model's check of whether it worked (for the run log and learning). */
  checked?: { step: string; ok: boolean | null }[];
}

/**
 * Only a safety ceiling for runaway loops, never shown: real tasks can take many steps. The guardrails
 * that matter are the per-step check, the repeat and stall guards, risky-step approval and Esc.
 */
export const AGENT_MAX_STEPS = 200;
/** Steps in a row that the model reports didn't work before Clicky gives up. */
const MAX_FAILED_CHECKS = 4;
/** The first word can come after up to a thousand tokens of thinking. */
const STEP_FIRST_TOKEN_MS = 30_000;
const STEP_TOTAL_MS = 60_000;
/** A step whose model call failed (busy, timed out, cut off) is retried this many times. */
const STEP_RETRIES = 2;
/** Times a run may stop, review what went wrong and try a new approach before giving up. */
export const MAX_RECOVERIES = 3;
/** Notes and rows kept for the prompt (the newest win). */
const MAX_NOTES = 60;
const MAX_ROWS = 500;
/** Scrolls in a row with nothing noted before the agent is told to wrap up with what it has. */
const SCROLLS_WITHOUT_NOTES = 10;
/** Consecutive unparseable replies before giving up. */
const MAX_BAD_REPLIES = 2;

async function ask(deps: AgentDeps, system: string, question: string, screens: ScreenCapture): Promise<string> {
  const stream = deps.chat.stream({
    system,
    history: [],
    question,
    images: screens.images,
    // Room for a save_sheet with many rows.
    maxTokens: 2000,
    thinkingTokens: deps.thinkingTokens ?? 1024,
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

/** Same kind of step on the same target (clicks within ~40 px count as the same spot). */
function actionSignature(a: AgentAction): string | null {
  switch (a.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
      return `${a.type}:${a.target.toLowerCase() || `${Math.round(a.x / 40)},${Math.round(a.y / 40)}`}`;
    case 'key':
      return `key:${a.keys.join('+')}`;
    case 'type':
      return `type:${a.text}`;
    case 'click_element':
      return `${a.op}:${a.target.toLowerCase() || a.id}`;
    case 'set_value':
      return `set:${a.id}:${a.text}`;
    case 'note':
      return `note:${a.text}|${a.row?.join('|') ?? ''}`;
    default:
      return null;
  }
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
    case 'drag': {
      const [first, last] = [a.path[0], a.path[a.path.length - 1]];
      return `dragged through ${a.path.length} points from ${first?.x},${first?.y} to ${last?.x},${last?.y}${a.screen ? ` (screen${a.screen})` : ''}`;
    }
    case 'open':
      return `opened ${a.app || a.url || a.path}`;
    case 'list_files':
      return `listed the files in ${a.path}`;
    case 'move_files':
      return `${a.copy ? 'copied' : 'moved'} ${a.pattern} from ${a.from} to ${a.to}`;
    case 'note':
      return `noted${a.rows ? ` ${a.rows.length} rows` : ''} ${a.row ? `row [${a.row.join(' | ')}]` : ''}${a.row && a.text ? ' and ' : ''}${a.text ? `"${a.text.slice(0, 80)}"` : ''}`;
    case 'save_sheet':
      return `saved the sheet "${a.name}"`;
    case 'close_window':
      return `closed the window "${a.title.slice(0, 80)}"`;
    case 'click_element':
      return `${a.op === 'click' ? 'clicked' : a.op === 'double' ? 'double-clicked' : 'right-clicked'} control ${a.id}${a.target ? ` "${a.target}"` : ''}`;
    case 'set_value':
      return `set control ${a.id}${a.target ? ` "${a.target}"` : ''} to "${a.text.length > 60 ? `${a.text.slice(0, 60)}…` : a.text}"`;
    default:
      return a.type;
  }
}

const REFLECT_PROMPT = `You review an assistant that operates a Windows PC with the mouse and keyboard.
Its run hit a problem. Using the task, its steps (with the ones that did not work marked) and the
current screenshot, say in at most three short sentences: what went wrong, and exactly what it
should do differently now (a different element, a keyboard shortcut, the open action, waiting for
a page, closing a popup, going back a step). Plain text, no JSON.`;

const VERIFY_PROMPT = `You check whether an assistant really finished a task on a Windows PC. Look at the
screenshots, the steps it took and its notes. Reply with ONLY one JSON object:
{"complete": true} if the task is fully done as asked, or
{"complete": false, "missing": "what is not done yet, in one short sentence"}.
Be strict about every part of the task, but don't ask for things the task didn't ask for. The task
came from speech recognition: names may be spelled differently ("Clicky Test Folders" is the folder
"ClickyTest/folders"); judge whether what the user meant is done.`;

/** Reasons to give up that only the user can fix; the run doesn't retry these. */
const NEEDS_USER =
  /sign ?in|log ?in|password|passcode|captcha|two-factor|2fa|not allowed|unsafe|never-touch|passkey|windows security|security key|user account control|\buac\b/i;

/** Typing, or a key that edits the text in the focused box (not shortcuts like esc or alt+tab). */
function typesIntoFocus(input: InputAction): boolean {
  if (input.kind === 'type') return true;
  if (input.kind !== 'keys') return false;
  const k = input.keys.join('+');
  return /^(?:enter|shift\+enter|backspace|delete|ctrl\+[avxz]|ctrl\+backspace)$/.test(k);
}

/** Another agent finishing up is given this long before Clicky gives up waiting. */
const OTHER_AGENT_MAX_WAIT_MS = 30 * 60_000;

/**
 * Another agent is driving this PC (a browser shows "Claude started debugging this browser"): say
 * so, and wait until it's gone before taking the next step, so the two don't fight over the mouse.
 * True if the run was stopped meanwhile.
 */
async function waitForOtherAgent(deps: AgentDeps): Promise<boolean> {
  const first = await deps.otherAgent?.().catch(() => null);
  if (!first) return false;
  deps.log?.(`agent waiting: another agent is driving the PC (${first})`);
  const say = 'Another agent is using this PC right now. I will wait until it finishes.';
  deps.onStep?.(say);
  deps.overlay.message(say, 'info');
  const started = Date.now();
  while (!deps.signal.aborted && Date.now() - started < OTHER_AGENT_MAX_WAIT_MS) {
    await delay(deps.otherAgentPollMs ?? 3000);
    if (deps.signal.aborted) break;
    const still = await deps.otherAgent?.().catch(() => null);
    if (!still) {
      deps.log?.(`agent resuming: the other agent finished after ${Math.round((Date.now() - started) / 1000)} s`);
      deps.overlay.message('The other agent is done. Carrying on.', 'info');
      // Give its last page a moment to settle.
      await delay(1000);
      return deps.signal.aborted;
    }
  }
  return deps.signal.aborted;
}

/** The final check before "done": what's still missing, or null if the task looks finished (or the check failed). */
async function verify(
  deps: AgentDeps,
  goal: string,
  steps: readonly string[],
  notes: readonly string[],
  claim: string,
): Promise<string | null> {
  try {
    const screens = await deps.capture.take(deps.signal);
    const reply = await ask(
      deps,
      VERIFY_PROMPT,
      [
        `Task: ${goal}`,
        `Steps taken:\n${steps.map((s, n) => `${n + 1}. ${s}`).join('\n')}`,
        notes.length ? `Notes:\n${notes.join('\n')}` : '',
        `The assistant says: ${claim}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      screens,
    );
    if (!/"complete"\s*:\s*false/i.test(reply)) return null;
    return /"missing"\s*:\s*"([^"]{1,300})"/.exec(reply)?.[1] ?? 'part of the task is not done';
  } catch (e) {
    if (!deps.signal.aborted) deps.log?.(`agent final check failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Clicking an installed app on the taskbar or in the Start menu is slow and often misses (icons
 * shift): launch it directly instead. Found by the live suite (D01: 28 steps of taskbar clicks).
 */
function viaOpen(a: AgentAction, apps: readonly string[] | undefined): AgentAction {
  if ((a.type !== 'click' && a.type !== 'double_click') || !apps?.length) return a;
  const t = a.target.toLowerCase();
  if (!/taskbar|start menu|desktop icon|shortcut/.test(t)) return a;
  const app = [...apps]
    .sort((x, y) => y.length - x.length)
    .find((n) => {
      const name = n.toLowerCase();
      if (name.length < 3) return false;
      const at = t.indexOf(name);
      if (at === -1) return false;
      const before = t.charAt(at - 1);
      const after = t.charAt(at + name.length);
      return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
    });
  return app ? { type: 'open', app, url: '', path: '', say: a.say || `Opening ${app}`, risky: a.risky } : a;
}

/** Run the task to completion, failure, cancellation or the step limit. Throws StageError on provider failure. */
export async function runAgent(goal: string, deps: AgentDeps): Promise<AgentResult> {
  const steps: string[] = [];
  const max = deps.maxSteps ?? AGENT_MAX_STEPS;
  let note = '';
  let bad = 0;
  let lastSig: string | null = null;
  let repeats = 0;
  let failedChecks = 0;
  let retries = 0;
  let scrolls = 0;
  const notes: string[] = [];
  const rows: string[][] = [];
  const checked: { step: string; ok: boolean | null }[] = [];
  const stopped = (): AgentResult => ({ outcome: 'stopped', summary: 'Okay, I stopped.', steps });
  let recoveries = 0;
  /** The task as shown to the user: what Clicky understood, once it said. */
  let shown = goal;
  const reflections: string[] = [];
  /**
   * Where Clicky last put the keyboard focus (its last click into something), and whether the user
   * has used the mouse or keyboard since. Typing after the user took over first clicks back there,
   * so the text never lands in whatever the user clicked into meanwhile.
   */
  let focusClick: InputAction | null = null;
  let focusLabel = '';
  let tookOver = false;
  /**
   * The run hit a problem: instead of giving up, look back at what was done and what's on screen,
   * work out the mistake and continue with a different approach. False once out of attempts.
   */
  const recover = async (problem: string): Promise<boolean> => {
    if (recoveries >= MAX_RECOVERIES || deps.signal.aborted) return false;
    recoveries++;
    deps.log?.(`agent recovering (${recoveries}/${MAX_RECOVERIES}): ${problem}`);
    deps.onStep?.('Rethinking my approach');
    let review = '';
    try {
      const screens = await deps.capture.take(deps.signal);
      review = (
        await ask(
          deps,
          REFLECT_PROMPT,
          [
            `Task: ${goal}`,
            `What went wrong: ${problem}`,
            reflections.length ? `Earlier reviews:\n${reflections.join('\n')}` : '',
            `Steps so far, with checks:\n${checked
              .map((c, n) => `${n + 1}. ${c.step}${c.ok === false ? ' (did not work)' : ''}`)
              .join('\n')}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
          screens,
        )
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600);
    } catch (e) {
      if (deps.signal.aborted) return false;
      deps.log?.(`agent review failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    deps.log?.(`agent review: ${review || '(none)'}`);
    reflections.push(`Attempt ${recoveries} hit a problem (${problem}).${review ? ` Review: ${review}` : ''}`);
    failedChecks = 0;
    repeats = 0;
    lastSig = null;
    scrolls = 0;
    note = 'Start the new approach from your review now.';
    return true;
  };
  for (let i = 0; i < max;) {
    if (deps.signal.aborted) return stopped();
    await deps.whilePaused?.(deps.signal);
    if (deps.signal.aborted) return stopped();
    // The user took over the mouse or keyboard: wait for them before doing anything else.
    if (deps.userInterrupted?.()) {
      tookOver = true;
      deps.log?.('agent paused: the user is using the mouse or keyboard');
      await deps.waitForUser?.(deps.signal);
      if (deps.signal.aborted) return stopped();
    }
    if (await waitForOtherAgent(deps)) return stopped();
    const blocked = await deps.blockedApp?.();
    if (blocked) {
      deps.log?.(`agent refused: ${blocked} is on the never-touch list`);
      return { outcome: 'failed', summary: `I stopped: ${blocked} is on your list of apps I never touch.`, steps };
    }
    // A screenshot can time out while the PC is busy (an app starting): try again before giving up.
    let screens: ScreenCapture;
    try {
      screens = await deps.capture.take(deps.signal);
    } catch (e) {
      if (deps.signal.aborted) return stopped();
      deps.log?.(`agent screenshot failed, retrying: ${e instanceof Error ? e.message : String(e)}`);
      await delay(1500);
      screens = await deps.capture.take(deps.signal);
    }
    if (deps.signal.aborted) return stopped();
    const [windows, controls] = await Promise.all([
      deps.openWindows?.().catch(() => []),
      deps.elements?.().catch(() => [] as UiElement[]),
    ]);
    const controlsText = controls?.length ? elementsText(controls, screens) : '';
    const byId = new Map((controls ?? []).map((e) => [e.id, e]));
    const question = [
      `Task: ${goal}`,
      deps.conversation
        ? `Earlier in this conversation (use it for "it", "that", "again", "the same"):\n${deps.conversation}`
        : '',
      reflections.length
        ? `Earlier attempts in this run went wrong. Do it differently this time:\n${reflections.join('\n')}`
        : '',
      windows?.length ? `Open windows (front first):\n${windows.map((w) => `- ${w}`).join('\n')}` : '',
      controlsText
        ? `Controls in the window in front (number, kind, name, position in thousandths; use click_element or set_value with the number):\n${controlsText}`
        : '',
      deps.skills ?? '',
      deps.hints ? `What worked before for similar tasks (use it if it fits):\n${deps.hints}` : '',
      notes.length ? `Your notes so far:\n${notes.map((n) => `- ${n}`).join('\n')}` : '',
      rows.length ? `Rows noted so far (${rows.length}):\n${rows.map((r) => r.join(' | ')).join('\n')}` : '',
      steps.length ? `Steps so far:\n${steps.map((s, n) => `${n + 1}. ${s}`).join('\n')}` : 'No steps taken yet.',
      note,
      scrolls >= SCROLLS_WITHOUT_NOTES
        ? `You have scrolled ${scrolls} times without noting anything. Note what you have found so far, then finish the task with it.`
        : '',
      'What is the next action?',
    ]
      .filter(Boolean)
      .join('\n\n');
    let reply: string;
    try {
      reply = await ask(
        deps,
        agentSystemPrompt(screens, deps.userContext, deps.inventory, deps.briefing),
        question,
        screens,
      );
    } catch (e) {
      if (deps.signal.aborted) return stopped();
      // A busy model, a slow first word or a cut-off reply: try the step again before giving up.
      if (++retries > STEP_RETRIES) throw e;
      deps.log?.(`agent step retry ${retries}: ${e instanceof Error ? e.message : String(e)}`);
      await delay(1500 * retries);
      continue;
    }
    retries = 0;
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
    const a = viaOpen(parsed.action, deps.inventory?.apps);
    // What Clicky understood, shown before it acts, so a misheard request can be stopped at once.
    const understood = steps.length === 0 ? /"understood"\s*:\s*"([^"]{3,200})"/.exec(reply)?.[1] : undefined;
    if (understood) {
      deps.log?.(`agent understood: ${understood}`);
      shown = understood;
    }
    // The per-step check: did the previous step do what it should have?
    const check = parseStepCheck(reply);
    const prev = checked[checked.length - 1];
    if (prev && prev.ok === null && check) {
      prev.ok = check === 'worked';
      deps.log?.(`agent check: "${prev.step}" ${check}`);
      failedChecks = check === 'failed' ? failedChecks + 1 : 0;
      if (failedChecks >= MAX_FAILED_CHECKS && (await recover(`${failedChecks} steps in a row did not work`))) continue;
      if (failedChecks >= MAX_FAILED_CHECKS) {
        deps.log?.('agent stopped: several steps in a row did not work');
        return {
          outcome: 'failed',
          summary:
            "Several steps in a row didn't work, so I stopped. Tell me what to do differently and I'll try again.",
          steps,
          checked,
        };
      }
    }
    const sig = actionSignature(a);
    // A step that worked resets the count: pressing the same key to close twenty windows is fine.
    repeats = sig !== null && sig === lastSig && check !== 'worked' ? repeats + 1 : 0;
    lastSig = sig;
    if (repeats >= 2 && (await recover(`the same step three times without effect: ${describe(a)}`))) continue;
    if (repeats >= 2) {
      deps.log?.(`agent stopped: the same step three times (${describe(a)})`);
      return {
        outcome: 'failed',
        summary: 'I kept trying the same step without it working, so I stopped. Try telling me exactly what to click.',
        steps,
      };
    }
    if (repeats === 1)
      note =
        'You just did this same step and it did not change anything. If the task is done, reply done; otherwise try a different way, such as a keyboard shortcut.';
    if (a.type === 'done') {
      // The final eval: look at the screen once more before telling the user it's done.
      if ((deps.verifyDone ?? true) && steps.length >= 1) {
        const missing = await verify(deps, goal, steps, notes, a.say);
        if (missing && (await recover(`you said done, but the check found: ${missing}`))) continue;
        if (missing) {
          deps.log?.(`agent unfinished after ${steps.length} steps: ${missing}`);
          return { outcome: 'failed', summary: `I couldn't finish: ${missing}`, steps, checked };
        }
      }
      deps.log?.(`agent done after ${steps.length} steps: ${a.say}`);
      return { outcome: 'done', summary: a.say, steps, checked };
    }
    if (a.type === 'fail') {
      // Giving up is a last resort: unless the task needs the user (a sign-in, a password), think again first.
      if (!NEEDS_USER.test(a.say) && (await recover(`you wanted to give up: ${a.say}`))) continue;
      deps.log?.(`agent gave up after ${steps.length} steps: ${a.say}`);
      return { outcome: 'failed', summary: a.say, steps, checked };
    }
    i++;

    const say = a.say || describe(a);
    deps.log?.(`agent step ${i}: ${describe(a)}${a.say ? ` — "${a.say}"` : ''}${a.risky ? ' (risky)' : ''}`);
    deps.onStep?.(say);
    deps.onProgress?.({ goal: shown, step: i, max, say });
    // Notes and sheets don't touch the screen.
    if (a.type === 'note') {
      scrolls = 0;
      if (a.text) notes.push(a.text);
      if (a.row) rows.push(a.row);
      if (a.rows) rows.push(...a.rows);
      notes.splice(0, Math.max(0, notes.length - MAX_NOTES));
      rows.splice(0, Math.max(0, rows.length - MAX_ROWS));
      steps.push(describe(a));
      checked.push({ step: describe(a), ok: true });
      continue;
    }
    if (a.type === 'list_files' || a.type === 'move_files') {
      deps.overlay.message(say, 'info');
      try {
        if (a.type === 'list_files') {
          if (!deps.listFiles) throw new Error('reading folders is not available here');
          const files = await deps.listFiles(a.path);
          notes.push(`Files in ${a.path} (${files.length}): ${files.slice(0, 120).join('; ')}`);
          notes.splice(0, Math.max(0, notes.length - MAX_NOTES));
          steps.push(`listed ${files.length} files in ${a.path}`);
        } else {
          if (!deps.moveFiles) throw new Error('moving files is not available here');
          const n = await deps.moveFiles(a.from, a.pattern, a.to, a.copy);
          steps.push(`${a.copy ? 'copied' : 'moved'} ${n} files (${a.pattern}) from ${a.from} to ${a.to}`);
        }
        checked.push({ step: describe(a), ok: true });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        note = `That failed: ${why}.`;
        steps.push(`(failed: ${describe(a)}: ${why.slice(0, 120)})`);
        checked.push({ step: describe(a), ok: false });
      }
      continue;
    }
    if (a.type === 'save_sheet') {
      const table = a.rows ?? rows;
      if (!deps.saveSheet) {
        note = 'Saving files is not available here. Tell the user what you found in "say" instead.';
        steps.push('(save_sheet is not available)');
        continue;
      }
      if (!table.length) {
        note = 'There are no rows to save yet. Note each item with {"action":"note","row":[…]} first.';
        steps.push('(nothing to save yet)');
        continue;
      }
      deps.overlay.message(say, 'info');
      try {
        const saved = await deps.saveSheet(a.name, a.columns, table);
        deps.log?.(`agent saved a sheet: ${saved} (${table.length} rows)`);
        steps.push(`saved ${table.length} rows to ${saved}`);
        checked.push({ step: `saved the sheet "${a.name}"`, ok: true });
      } catch (e) {
        note = `Saving the sheet failed (${e instanceof Error ? e.message : String(e)}).`;
        steps.push('(saving the sheet failed)');
      }
      continue;
    }
    let input: InputAction | null = null;
    if (a.type === 'click' || a.type === 'double_click' || a.type === 'right_click' || a.type === 'scroll') {
      const mapped = mapPointToDisplay(fromThousandths(a, screens.geometry), screens.geometry);
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
              ...(a.target ? { target: a.target } : {}),
            };
    } else if (a.type === 'drag') {
      const path: MappedPoint[] = [];
      for (const p of a.path) {
        const m = mapPointToDisplay(fromThousandths({ ...p, screen: a.screen }, screens.geometry), screens.geometry);
        if (m.ok) path.push(m.point);
      }
      const start = path[0];
      if (!start || path.length !== a.path.length) {
        note = 'Part of that drag was off the screenshot. Use coordinates inside the image.';
        steps.push(`(skipped: ${describe(a)} was off screen)`);
        continue;
      }
      // The companion flies to where the stroke starts, so the user sees where Clicky will draw.
      deps.overlay.point(start, say);
      input = { kind: 'drag', path };
    } else if (a.type === 'open') {
      deps.overlay.message(say, 'info');
      input = {
        kind: 'open',
        ...(a.app ? { app: a.app } : {}),
        ...(a.url ? { url: a.url } : {}),
        ...(a.path ? { path: a.path } : {}),
      };
    } else if (a.type === 'close_window') {
      deps.overlay.message(say, 'info');
      input = { kind: 'close', title: a.title };
    } else if (a.type === 'click_element' || a.type === 'set_value') {
      const el = byId.get(a.id);
      if (!el) {
        note = `There is no control number ${a.id} in the list. Use a number from "Controls", or click by position.`;
        steps.push(`(skipped: no control ${a.id})`);
        continue;
      }
      // The companion flies to the control first, like a click.
      const at = placeGlobal({ x: el.x + el.w / 2, y: el.y + el.h / 2 }, screens.geometry);
      if (at) deps.overlay.point(at.point, a.target || el.name || say);
      else deps.overlay.message(say, 'info');
      input =
        a.type === 'set_value'
          ? { kind: 'element', id: a.id, op: 'set', text: a.text }
          : { kind: 'element', id: a.id, op: a.op };
    } else if (a.type === 'type') {
      deps.atCaret?.();
      deps.overlay.message(say, 'info');
      input = { kind: 'type', text: a.text };
    } else if (a.type === 'key') {
      deps.atCaret?.();
      deps.overlay.message(say, 'info');
      input = { kind: 'keys', keys: a.keys };
    }

    if (a.risky || deps.confirmMode === 'always') {
      const ok = await deps.confirm(say, deps.signal);
      if (!ok || deps.signal.aborted) return stopped();
    } else if (
      input?.kind === 'click' ||
      input?.kind === 'scroll' ||
      input?.kind === 'drag' ||
      input?.kind === 'element'
    ) {
      // Let the companion land on the target and rest there a moment, so the user sees where it acts.
      await delay(deps.flightMs ?? 950);
    } else if (input) {
      await delay(deps.flightMs === undefined ? 300 : 0); // it slides over to the caret first
    }
    if (deps.signal.aborted) return stopped();
    scrolls = a.type === 'scroll' ? scrolls + 1 : scrolls;
    if (a.type === 'wait') await delay(a.ms);
    else if (input) {
      try {
        if (tookOver && focusClick && typesIntoFocus(input)) {
          deps.log?.(`agent refocusing "${focusLabel}" before typing: the user used the mouse or keyboard`);
          await deps.input.run(focusClick, deps.signal);
          await delay(250);
        }
        await deps.input.run(input, deps.signal);
        if (input.kind === 'click' && input.button === 'left' && input.count === 1) {
          focusClick = input;
          focusLabel = input.target ?? '';
        } else if (input.kind === 'element' && (input.op === 'click' || input.op === 'set')) {
          const el = byId.get(input.id);
          const at = el ? placeGlobal({ x: el.x + el.w / 2, y: el.y + el.h / 2 }, screens.geometry) : null;
          if (at && el) {
            // The numbers change with every list, so it's kept as a click on the control by name.
            focusClick = {
              kind: 'click',
              at: at.point,
              button: 'left',
              count: 1,
              ...(el.name ? { target: el.name } : {}),
            };
            focusLabel = el.name;
          }
        } else if (input.kind === 'open') focusClick = null;
        if (input.kind !== 'type' && input.kind !== 'keys') tookOver = false;
      } catch (e) {
        if (deps.signal.aborted) return stopped();
        // Tell the model what went wrong and let it try another way.
        const why = e instanceof Error ? e.message : String(e);
        deps.log?.(`agent step failed: ${describe(a)}: ${why}`);
        if (why.includes('FOCUS_MOVED')) {
          // The user clicked somewhere else mid-typing: part of the text went in. Look again before going on.
          tookOver = true;
          note = `${why.replace(/^.*FOCUS_MOVED:\s*/, '')}. The user clicked somewhere else. Look at the screenshot: finish the text in the box you were typing in (click it first), and never type into the box the user moved to.`;
          steps.push(`(stopped typing: the focus moved: ${describe(a)})`);
          checked.push({ step: describe(a), ok: false });
          continue;
        }
        note = `That step failed: ${why}. Try a different way (check the exact name or path in the lists above).`;
        steps.push(`(failed: ${describe(a)}: ${why.slice(0, 120)})`);
        checked.push({ step: describe(a), ok: false });
        failedChecks++;
        if (failedChecks >= MAX_FAILED_CHECKS && !(await recover(`${failedChecks} steps in a row failed`)))
          return { outcome: 'failed', summary: `I couldn't do that: ${why}`, steps, checked };
        continue;
      }
    }
    steps.push(describe(a));
    checked.push({ step: describe(a), ok: null });
    await delay(deps.settleMs ?? 700);
  }
  return {
    outcome: 'failed',
    summary: `That took more than ${max} steps, so I stopped to be safe. You can ask me to continue.`,
    steps,
  };
}

/** A finished run that worked, kept so similar tasks go faster next time (text only, on this PC). */
export interface AgentLesson {
  goal: string;
  /** The steps that worked, in order. */
  steps: string[];
  at: number;
}

const words = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !['the', 'and', 'can', 'you', 'please', 'open', 'for', 'with'].includes(w)),
  );

/** Up to two earlier runs whose goal shares most of its words with this one, as prompt hints. */
export function lessonHints(goal: string, lessons: readonly AgentLesson[]): string | undefined {
  const g = words(goal);
  if (!g.size) return undefined;
  const scored = lessons
    .map((l) => {
      const w = words(l.goal);
      const shared = [...g].filter((x) => w.has(x)).length;
      return { l, score: shared / Math.max(g.size, w.size) };
    })
    .filter((x) => x.score >= 0.5 && x.l.steps.length)
    .sort((a, b) => b.score - a.score || b.l.at - a.l.at)
    .slice(0, 2);
  if (!scored.length) return undefined;
  return scored
    .map(
      ({ l }) =>
        `Task "${l.goal}": ${l.steps
          .slice(0, 12)
          .map((s, i) => `${i + 1}. ${s}`)
          .join('; ')}`,
    )
    .join('\n');
}

/** The lesson to keep from a run, or null if it didn't finish. Steps the model said failed are left out. */
export function lessonFrom(goal: string, result: AgentResult, now: number): AgentLesson | null {
  if (result.outcome !== 'done') return null;
  const steps = (result.checked ?? result.steps.map((s) => ({ step: s, ok: null })))
    .filter((c) => c.ok !== false)
    .map((c) => c.step);
  return steps.length ? { goal: goal.slice(0, 200), steps: steps.slice(0, 30), at: now } : null;
}

const ROUTE_PROMPT = `You review how an assistant did a task on a Windows PC, to make the next run shorter.
You get the task and every step it took (with the ones that did not work marked). Write the
shortest sequence of steps that would have done the same task, in the same words the steps use
(for example: opened https://…, pressed ctrl+l, typed "…", closed the window "…", noted …).
Prefer direct URLs, the open action, keyboard shortcuts and close_window over clicking around.
Reply with ONLY one JSON object: {"steps": ["…", "…"], "why": "one short sentence"}.`;

/**
 * After every run: trace back the steps and work out the shortest route that would have done the
 * task, so the next similar task can follow it. Null if the review failed or found nothing shorter.
 */
export async function shortestRoute(
  chat: VisionChatProvider,
  goal: string,
  result: AgentResult,
  signal: AbortSignal,
): Promise<{ steps: string[]; why: string } | null> {
  const taken = result.checked ?? result.steps.map((s) => ({ step: s, ok: null }));
  if (taken.length < 2) return null;
  let text = '';
  for await (const t of chat.stream({
    system: ROUTE_PROMPT,
    history: [],
    question: [
      `Task: ${goal}`,
      `How it ended: ${result.outcome}: ${result.summary}`,
      `Steps taken (${taken.length}):\n${taken
        .map((c, n) => `${n + 1}. ${c.step}${c.ok === false ? ' (did not work)' : ''}`)
        .join('\n')}`,
    ].join('\n\n'),
    images: [],
    maxTokens: 600,
    signal,
  }))
    text += t;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as { steps?: unknown; why?: unknown };
    const steps = Array.isArray(o.steps)
      ? o.steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.slice(0, 200))
      : [];
    if (!steps.length || steps.length >= taken.length) return null;
    return { steps: steps.slice(0, 30), why: typeof o.why === 'string' ? o.why.slice(0, 200) : '' };
  } catch {
    return null;
  }
}
