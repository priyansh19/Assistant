/**
 * Write mode (dictation key): what the user says is turned into text at their text cursor.
 *
 *   plain speech            → tidied (punctuation, lists) and typed as they said it
 *   an instruction          → "reply to this email and thank him" → Clicky reads the screen and
 *                             writes the text in the user's voice, streaming it in as it arrives
 *   with text selected      → the instruction applies to the selection, which is replaced
 *   "shorter", "more formal" right after an insert → that insert is rewritten in place
 *
 * Nothing is ever sent or submitted: Clicky only types. The model's reply is the text to insert,
 * optionally followed by [SAY:one short sentence] that is spoken afterwards, never typed.
 */

import type { ChatTurn } from './providers.js';

export interface AppInfo {
  /** Process name without .exe, lower case, e.g. 'chrome', 'outlook', 'windowsterminal'. */
  process: string;
  /** Window title, e.g. "Re: Pricing - pgupta@… - Gmail". */
  title: string;
}

export interface WriteContext {
  app: AppInfo | null;
  /** Text the user had selected when they let go of the key, if any. */
  selection: string | null;
}

/** The last thing write mode typed, so it can be undone or rewritten. */
export interface LastInsert {
  text: string;
  /** What it replaced (a selection), to put back on undo. */
  replaced: string | null;
  instruction: string;
  at: number;
  app: AppInfo | null;
}

/** A rewrite request must come this soon after the insert it refers to. */
export const REVISE_WINDOW_MS = 120_000;
/** A tap of the dictation key undoes the last insert if it was this recent. */
export const UNDO_WINDOW_MS = 30_000;

export type DictationPlan =
  { kind: 'plain'; text: string } | { kind: 'write'; instruction: string } | { kind: 'revise'; instruction: string };

const WAKE = /^\s*(?:hey|hi|okay|ok)?[\s,]*clicky\b[\s,:.!-]*/i;
const REVISE =
  /^\s*(?:(?:please|can you|could you)\s+)?(?:make\s+(?:it|this|that)\s+)?(?:a\s+(?:bit|little)\s+)?(shorter|longer|more\s+\w+|less\s+\w+|simpler|friendlier|warmer|punchier|clearer|rewrite(?:\s+(?:it|this|that))?|try\s+again|redo(?:\s+(?:it|this|that))?|another\s+version|different(?:ly)?)\b/i;
const VERBS =
  /^\s*(?:(?:please|can you|could you|now)\s+)?(?:write|reply|respond|draft|type|compose|rewrite|rephrase|translate|summari[sz]e|fix|improve|correct|proofread|shorten|expand|answer|explain|continue|finish|turn|make|create|generate|give|suggest|polish|format|convert|tell)\b/i;

/** Decide what the user meant by what they said, before anything is typed. */
export function planDictation(
  transcript: string,
  opts: { hasSelection: boolean; last: LastInsert | null; now: number },
): DictationPlan {
  const text = transcript.trim();
  const woke = WAKE.test(text);
  const body = text.replace(WAKE, '').trim();
  if (opts.last && opts.now - opts.last.at <= REVISE_WINDOW_MS && REVISE.test(body) && body.split(/\s+/).length <= 12)
    return { kind: 'revise', instruction: body };
  if (woke || opts.hasSelection || VERBS.test(body)) return { kind: 'write', instruction: body || text };
  return { kind: 'plain', text };
}

const WRITE_PROMPT = `You are Clicky, writing on the user's behalf at their text cursor. Your reply is typed straight
into the text box they are in, exactly as you write it.

Rules:
- Reply with ONLY the text to insert: no preamble, no quotes around it, no markdown code fences,
  no "Here is…". Plain text; use line breaks and simple numbered or dashed lists where natural.
- Use the screenshot for context: the email or message being replied to, the document, the
  conversation, the code. Match the language and the register of where it's going.
- Write in the user's own voice (see "About the user"). Sign emails with their sign-off when an
  email reply is clearly expected; never sign chat messages.
- Never invent facts, numbers, links or commitments the user didn't give. Keep it as short as the
  task allows.
- Never write passwords, card numbers or other secrets.
- After the text, you may add one line "[SAY:…]" with a short sentence to say out loud, e.g.
  "[SAY:I wrote a short thank-you reply.]" or, if they asked you to explain something, a one or two
  sentence spoken explanation. It is spoken, never typed. Skip it if there's nothing worth saying.`;

const TIDY_PROMPT = `You clean up dictated text before it is typed into the user's text box. Return ONLY the cleaned
text. Fix punctuation, capitalisation and obvious speech-recognition slips; drop filler words
("um", "uh", "like" used as filler); turn spoken enumerations ("first… second… third…") into a
numbered list. Keep the user's words, meaning and language. Do not answer, add or summarise.`;

export interface WritePromptOptions {
  plan: DictationPlan;
  context: WriteContext;
  /** Profile, playbooks and other context about the user. */
  userContext?: string;
  /** For a rewrite: the text being rewritten. */
  previous?: LastInsert | null;
  /** Screens sent with the request (for the image list). */
  screens?: { width: number; height: number; hasCursor: boolean }[];
}

export function writeSystemPrompt(o: WritePromptOptions): string {
  if (o.plan.kind === 'plain') {
    const ctx = o.userContext?.trim();
    return ctx ? `${TIDY_PROMPT}\n\nAbout the user (for names and spelling only):\n${ctx.slice(0, 1500)}` : TIDY_PROMPT;
  }
  const lines = [WRITE_PROMPT];
  if (o.screens?.length) {
    lines.push('', 'Screenshots in this message:');
    o.screens.forEach((s, i) =>
      lines.push(`- screen${i + 1}: ${s.width}x${s.height} px${s.hasCursor ? ' (the user is working here)' : ''}`),
    );
  }
  const app = o.context.app;
  if (app) lines.push('', `They are typing in: ${app.process}${app.title ? ` — "${app.title.slice(0, 160)}"` : ''}`);
  if (isTerminal(app)) lines.push('This is a terminal: write a single line, no line breaks.');
  const ctx = o.userContext?.trim();
  if (ctx) lines.push('', `About the user:\n${ctx.slice(0, 6000)}`);
  return lines.join('\n');
}

/** The user message for a write request. */
export function writeQuestion(o: WritePromptOptions): string {
  if (o.plan.kind === 'plain')
    return `Clean up this dictated text and return only the cleaned text. Do not reply to it:\n"""\n${o.plan.text}\n"""`;
  if (o.plan.kind === 'revise' && o.previous) {
    return [
      `Rewrite the text you just wrote. Change requested: "${o.plan.instruction}".`,
      `Original request: "${o.previous.instruction}"`,
      `Text to rewrite:\n${o.previous.text}`,
    ].join('\n\n');
  }
  const sel = o.context.selection;
  if (sel)
    return `Selected text (your reply replaces it):\n"""\n${sel.slice(0, 8000)}\n"""\n\nInstruction: ${o.plan.instruction}`;
  return `Instruction: ${o.plan.instruction}`;
}

/** No conversation history for writing: each insert stands alone apart from a rewrite. */
export const WRITE_HISTORY: readonly ChatTurn[] = [];

const TERMINALS = new Set([
  'windowsterminal',
  'cmd',
  'powershell',
  'pwsh',
  'conhost',
  'wt',
  'mintty',
  'alacritty',
  'wezterm-gui',
]);

/** In a terminal, Enter runs the line, so write mode never types a line break there. */
export function isTerminal(app: AppInfo | null): boolean {
  return !!app && TERMINALS.has(app.process);
}

/**
 * Splits the model's streamed reply into text to type and the trailing [SAY:…] sentence.
 * Text that might be the start of "[SAY:" is held back until it's clear, so the tag is never typed.
 */
export class SayTagSplitter {
  private buf = '';
  private inSay = false;
  private sayText = '';
  /** Leading text held while we check for an opening code fence or quote. */
  private head = '';
  private started = false;
  /** The reply opened with a code fence or quote; its closing mark is dropped at the end. */
  private wrapped = false;
  /** Trailing whitespace, backticks and quotes held back: they may be closing marks. */
  private tail = '';

  /** Feed a chunk; returns text safe to type now. */
  push(chunk: string): string {
    if (this.inSay) {
      this.sayText += chunk;
      return '';
    }
    this.buf += chunk;
    const i = this.buf.search(/\[SAY:/i);
    if (i !== -1) {
      const out = this.buf.slice(0, i);
      this.sayText = this.buf.slice(i + 5);
      this.inSay = true;
      this.buf = '';
      return this.emit(out);
    }
    const keep = partialSuffix(this.buf, '[SAY:');
    const out = this.buf.slice(0, this.buf.length - keep);
    this.buf = this.buf.slice(this.buf.length - keep);
    return this.emit(out);
  }

  /** The stream ended: the rest of the text, and the sentence to say (if any). */
  end(): { text: string; say: string | null } {
    let rest = this.inSay ? '' : this.buf;
    this.buf = '';
    if (!this.started) {
      rest = cleanInsert(this.head + rest);
      this.head = '';
    } else {
      rest = this.tail + rest;
      if (this.wrapped) rest = rest.replace(/\s*(```|["”])\s*$/, '');
      rest = rest.replace(/\s+$/, '');
    }
    this.tail = '';
    const say = this.sayText.replace(/\].*$/s, '').trim();
    return { text: rest, say: say || null };
  }

  private emit(chunk: string): string {
    let s = chunk;
    if (!this.started) {
      this.head += s;
      let t = this.head.replace(/^\s+/, '');
      if (t.length < 4 && !t.includes('\n')) return '';
      if (t.startsWith('```')) {
        const nl = t.indexOf('\n');
        if (nl === -1) return '';
        t = t.slice(nl + 1);
        this.wrapped = true;
      } else if (t.startsWith('"') || t.startsWith('“')) {
        t = t.slice(1);
        this.wrapped = true;
      }
      this.started = true;
      this.head = '';
      s = t;
    }
    const all = this.tail + s;
    const cut = all.search(/[\s`"”]*$/);
    this.tail = all.slice(cut);
    return all.slice(0, cut);
  }
}

function partialSuffix(s: string, tag: string): number {
  for (let n = Math.min(s.length, tag.length - 1); n > 0; n--)
    if (s.slice(s.length - n).toUpperCase() === tag.slice(0, n).toUpperCase()) return n;
  return 0;
}

/** Strip wrapping the model may add despite the prompt: code fences and surrounding quotes. */
export function cleanInsert(text: string): string {
  let t = text.trim();
  t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
  if (/^"[^"]*"$/s.test(t) || /^“[^”]*”$/s.test(t)) t = t.slice(1, -1);
  return t.trim();
}

/** Characters as the editor counts them for Backspace (one per code point; CRLF never typed). */
export function backspaceCount(text: string): number {
  return Array.from(text.replace(/\r/g, '')).length;
}

/**
 * Types streamed text in order with one request in flight at a time; text that arrives while a
 * request is running is sent together next, so typing keeps up with any stream speed.
 */
export class TypingQueue {
  private pending = '';
  private running: Promise<void> | null = null;
  private failure: unknown = null;
  /** Everything handed to the OS so far. */
  typed = '';

  constructor(private readonly send: (text: string) => Promise<void>) {}

  push(text: string): void {
    if (!text || this.failure) return;
    this.pending += text;
    this.running ??= this.loop();
  }

  private async loop(): Promise<void> {
    try {
      while (this.pending && !this.failure) {
        const t = this.pending;
        this.pending = '';
        await this.send(t);
        this.typed += t;
      }
    } catch (e) {
      this.failure = e;
    } finally {
      this.running = null;
    }
  }

  /** Wait for everything pushed so far; throws if typing failed. */
  async flush(): Promise<void> {
    while (this.running) await this.running;
    if (this.failure) throw this.failure;
  }
}

/**
 * Plain dictation is typed exactly as heard. The AI only tidies it when the user clearly dictated
 * structure (a spoken list, "new line", spoken punctuation), because a model asked to tidy "how are
 * you" may answer it instead.
 */
export function needsTidy(text: string): boolean {
  return (
    text.split(/\s+/).length >= 8 &&
    /\b(first(ly)?|second(ly)?|third(ly)?|number (one|two|three)|bullet( point)?|new (line|paragraph)|next line|full stop|comma|question mark)\b/i.test(
      text,
    )
  );
}

/** True if the tidied text is still the user's words (not an answer or a rewrite). */
export function faithfulTidy(raw: string, cleaned: string): boolean {
  const norm = (s: string): string[] =>
    s
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((w) => w.length >= 3);
  const said = norm(raw).filter(
    (w) =>
      ![
        'first',
        'second',
        'third',
        'firstly',
        'secondly',
        'thirdly',
        'number',
        'comma',
        'full',
        'stop',
        'new',
        'line',
        'next',
        'bullet',
        'point',
      ].includes(w),
  );
  if (!cleaned.trim()) return false;
  if (cleaned.length > raw.length * 1.6 + 20) return false;
  const kept = new Set(norm(cleaned));
  const hits = said.filter((w) => kept.has(w)).length;
  return said.length === 0 || hits / said.length >= 0.7;
}
