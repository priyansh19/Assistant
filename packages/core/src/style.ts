/**
 * "Writes like me", learned. As Clicky is used it picks up how the user writes in each kind of
 * place (email, chat, social, documents) from two sources, and nothing else:
 * - the screenshot of a write-mode request: text the user themselves wrote that's visible there
 *   (their sent messages, earlier emails in the thread, their drafts), summarised by the model;
 * - their own plain dictation (the words they said), kept as short examples.
 * Everything is stored on the PC, shown on the "Writes like me" page, editable and clearable, and
 * never collected in excluded apps (password managers by default).
 */

import type { AppInfo } from './write.js';

export const STYLE_CONTEXTS = ['email', 'chat', 'social', 'docs', 'other'] as const;
export type StyleContext = (typeof STYLE_CONTEXTS)[number];

export const STYLE_CONTEXT_NAMES: Record<StyleContext, string> = {
  email: 'Emails',
  chat: 'Chat messages',
  social: 'Social posts',
  docs: 'Documents',
  other: 'Everything else',
};

export interface StyleProfile {
  notes: string[];
  examples: string[];
  updatedAt: number;
}

export type LearnedStyle = Partial<Record<StyleContext, StyleProfile>>;

const MAX_NOTES = 12;
const MAX_EXAMPLES = 6;
const MAX_NOTE = 140;
const MAX_EXAMPLE = 200;

/** What kind of writing the app in front is for. */
export function contextOf(app: AppInfo | null): StyleContext {
  if (!app) return 'other';
  const hay = `${app.process} ${app.title}`.toLowerCase();
  if (/outlook|hxoutlook|thunderbird|gmail|mail\b|proton ?mail|superhuman/.test(hay)) return 'email';
  if (/whatsapp|slack|teams|telegram|discord|signal|messenger|wechat|imessage/.test(hay)) return 'chat';
  if (/linkedin|twitter|\bx\.com|facebook|instagram|threads|reddit/.test(hay)) return 'social';
  if (/winword|word\b|google docs|docs\.google|notion|obsidian|onenote|notepad|wordpad/.test(hay)) return 'docs';
  return 'other';
}

/** True if learning is allowed in this app (not on the exclude list). */
export function learningAllowed(app: AppInfo | null, exclude: string): boolean {
  if (!app) return false;
  const hay = `${app.process} ${app.title}`.toLowerCase().replace(/\s+/g, '');
  return !exclude
    .split(',')
    .map((a) =>
      a
        .trim()
        .toLowerCase()
        .replace(/\.exe$/, '')
        .replace(/\s+/g, ''),
    )
    .some((a) => a.length >= 2 && hay.includes(a));
}

export const STYLE_PROMPT = `You study how a person writes, from a screenshot of their screen, so an assistant can
write in their voice later. Look ONLY at text the user wrote themselves: their sent messages (often
on the right in chat apps, or marked "You"/"Me"), emails they sent, their drafts and posts. Ignore
other people's messages, menus, ads and anything that isn't their writing.

Reply with ONLY a JSON object:
{"found": true, "notes": ["short observation", …], "examples": ["short phrase they actually wrote", …]}
- notes: up to 5 concrete style observations, e.g. "greets with 'Hey <name>'", "signs off 'Cheers, P'",
  "short sentences, no exclamation marks", "uses lowercase in chat", "mixes Hindi and English".
- examples: up to 3 short verbatim phrases (under 20 words) that show their voice.
- Never include passwords, codes, card numbers, addresses, phone numbers or other private data.
If there's no text written by the user, reply {"found": false}.`;

export interface StyleObservation {
  notes: string[];
  examples: string[];
}

/** Parse the model's reply; null when nothing was found or the reply isn't usable. */
export function parseStyleReply(reply: string): StyleObservation | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const o = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
    if (o['found'] !== true) return null;
    const list = (v: unknown, max: number, len: number): string[] =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.trim().slice(0, len))
            .filter((x) => x.length >= 3 && !looksPrivate(x))
            .slice(0, max)
        : [];
    const notes = list(o['notes'], 5, MAX_NOTE);
    const examples = list(o['examples'], 3, MAX_EXAMPLE);
    return notes.length || examples.length ? { notes, examples } : null;
  } catch {
    return null;
  }
}

/** Long digit runs, emails and URLs never go into the profile. */
function looksPrivate(s: string): boolean {
  return /\d{5,}|[\w.+-]+@[\w-]+\.\w|https?:\/\//i.test(s);
}

/** Add an observation, newest first, without duplicates, within the caps. */
export function mergeStyle(prev: LearnedStyle, ctx: StyleContext, obs: StyleObservation, now: number): LearnedStyle {
  const cur = prev[ctx] ?? { notes: [], examples: [], updatedAt: 0 };
  const merge = (fresh: string[], old: string[], max: number): string[] => {
    const seen = new Set<string>();
    return [...fresh, ...old]
      .filter((x) => {
        const k = x
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, max);
  };
  return {
    ...prev,
    [ctx]: {
      notes: merge(obs.notes, cur.notes, MAX_NOTES),
      examples: merge(obs.examples, cur.examples, MAX_EXAMPLES),
      updatedAt: now,
    },
  };
}

/** The learned part of "About the user" for the app in front (its context, else everything else). */
export function learnedStyleText(style: LearnedStyle, app: AppInfo | null): string {
  const ctx = contextOf(app);
  const p = style[ctx]?.notes.length || style[ctx]?.examples.length ? style[ctx] : style.other;
  if (!p || (!p.notes.length && !p.examples.length)) return '';
  const name = STYLE_CONTEXT_NAMES[p === style[ctx] ? ctx : 'other'].toLowerCase();
  const lines = [`How they write ${name} (learned from their own writing):`];
  for (const n of p.notes) lines.push(`- ${n}`);
  if (p.examples.length) lines.push(`Phrases they use: ${p.examples.map((e) => `"${e}"`).join('; ')}`);
  return lines.join('\n');
}
