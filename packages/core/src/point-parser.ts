/**
 * Streaming parser for the POINT protocol (blueprint §5, development plan §3.2).
 *
 *   [POINT:x,y:label]            point on the screen the image came from
 *   [POINT:x,y:label:screenN]    point on screen N (1-based, in the order images were sent)
 *   [POINT:none]                 nothing to point at
 *   [BOX:…] [ARROW:…] [CIRCLE:…] [HIGHLIGHT:…] [PATH:…] [TEXT:…] drawings, see shapes.ts
 *   [TASK:goal]                  the user wants something done on the PC, not answered: hand the
 *                                goal (restated in full by the model) to agent mode
 *   [TARGET:x,y,r:label:screenN] a guided-walkthrough step: Clicky rings x,y (radius r) and waits
 *                                for the user's own click there before asking for the next step
 *   [HOVER:x,y,r:label:screenN]  the same, completed by resting the pointer there (hover menus)
 *   [DEEP] / [DEEP:reason]       the fast model hands a hard question to the stronger model
 *
 * Text arrives as LLM tokens split at arbitrary positions. The parser releases text that is
 * safe to speak and holds back anything that could still turn into a tag, so tag text never
 * reaches TTS. Tags may appear anywhere; the prompt asks for one at the start.
 */

import { DRAW_TAGS, parseDrawTag, type DrawShape } from './shapes.js';

export interface PointTarget {
  kind: 'point';
  /** Coordinates in the pixel space of the screenshot image sent to the model. */
  x: number;
  y: number;
  label: string;
  /** 1-based screen index, if the model gave one. */
  screen: number | null;
}

export interface NoPoint {
  kind: 'none';
}

export type PointTag = PointTarget | NoPoint;

/** A click or hover target for a guided walkthrough (guide.ts). Coordinates as for POINT. */
export interface GuideTag {
  kind: 'click' | 'hover';
  x: number;
  y: number;
  /** Radius in thousandths of the screenshot width, or null when the model left it out (a default is used). */
  r: number | null;
  label: string;
  screen: number | null;
}

export type ParserEvent =
  | { type: 'text'; text: string }
  | { type: 'point'; tag: PointTag }
  | { type: 'draw'; shape: DrawShape }
  /** The model routed this request to agent mode, with the goal restated in full. */
  | { type: 'task'; goal: string }
  /** A walkthrough step: ring this spot and wait for the user's own click (or hover) there. */
  | { type: 'target'; target: GuideTag }
  /** The fast model judged the question too hard for a quick answer: hand it to the stronger model. */
  | { type: 'deep' }
  /** Something that started like a tag but did not parse. It is dropped, never spoken. */
  | { type: 'invalid-tag'; raw: string };

/** Tag openings the parser holds back from speech. */
const OPENERS = ['[POINT:', '[TASK:', '[TARGET:', '[HOVER:', '[DEEP]', '[DEEP:', ...DRAW_TAGS.map((t) => `[${t}:`)];
const OPEN_RE = new RegExp(`\\[(?:POINT|TASK|TARGET|HOVER|${DRAW_TAGS.join('|')}):|\\[DEEP[\\]:]`, 'i');
/** A tag longer than this is not a tag; release it as text so a stray "[POINT:" can't swallow the answer. */
export const MAX_TAG_LENGTH = 160;
/** A task goal is a whole restated request ("open Calculator, work out 18% of 2450 and…"), so it may run longer. */
export const MAX_TASK_TAG_LENGTH = 600;
/** A PATH carries up to 40 points, so it may run longer. */
export const MAX_PATH_TAG_LENGTH = 520;

const maxLength = (s: string): number =>
  /^\[TASK:/i.test(s) ? MAX_TASK_TAG_LENGTH : /^\[PATH:/i.test(s) ? MAX_PATH_TAG_LENGTH : MAX_TAG_LENGTH;

/** The goal in a complete `[TASK:goal]` tag, or null if it's empty. */
export function parseTaskTag(raw: string): string | null {
  const m = /^\[TASK:([\s\S]*)\]$/i.exec(raw);
  const goal = m?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  return goal.length >= 2 ? goal : null;
}

const TAG_RE =
  /^\[POINT:\s*(?:(none)|(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*:\s*([^\]]*?))?(?:\s*:\s*screen\s*(\d+))?)\s*\]$/i;

/** Parse one complete tag such as `[POINT:10,20:Save button:screen2]`. Returns null if it isn't valid. */
export function parsePointTag(raw: string): PointTag | null {
  const m = TAG_RE.exec(raw);
  if (!m) return null;
  if (m[1]) return { kind: 'none' };
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const screen = m[5] === undefined ? null : Number(m[5]);
  if (screen !== null && screen < 1) return null;
  return { kind: 'point', x, y, label: (m[4] ?? '').trim(), screen };
}

const GUIDE_RE =
  /^\[(TARGET|HOVER):\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d+(?:\.\d+)?))?(?:\s*:\s*([^\]]*?))?(?:\s*:\s*screen\s*(\d+))?\s*\]$/i;

/**
 * Parse `[TARGET:x,y,r:label:screenN]` or `[HOVER:…]`. The radius may be missing (`[TARGET:x,y:label]`):
 * the step still counts, with a default ring, rather than being dropped. A zero or negative radius
 * is treated as missing.
 */
export function parseGuideTag(raw: string): GuideTag | null {
  const m = GUIDE_RE.exec(raw);
  if (!m) return null;
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const r = m[4] === undefined ? null : Number(m[4]);
  const screen = m[6] === undefined ? null : Number(m[6]);
  if (screen !== null && screen < 1) return null;
  return {
    kind: m[1]?.toUpperCase() === 'HOVER' ? 'hover' : 'click',
    x,
    y,
    r: r !== null && Number.isFinite(r) && r > 0 ? r : null,
    label: (m[5] ?? '').trim(),
    screen,
  };
}

/** Length of the longest suffix of `s` that is a prefix of a tag opening (case-insensitive). */
function partialOpenSuffix(s: string): number {
  let best = 0;
  for (const open of OPENERS) {
    for (let n = Math.min(s.length, open.length - 1); n > best; n--) {
      if (s.slice(s.length - n).toUpperCase() === open.slice(0, n)) {
        best = n;
        break;
      }
    }
  }
  return best;
}

/** Length of the tag opening at the start of `s` (the buffer always starts with one here). */
function openLength(s: string): number {
  const head = s.slice(0, 12).toUpperCase();
  return (OPENERS.find((o) => head.startsWith(o)) ?? OPENERS[0] ?? '').length;
}

export class PointStreamParser {
  private buffer = '';

  /** Feed the next chunk of model output. Returns the events it completes. */
  push(chunk: string): ParserEvent[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  /** The stream ended: release or resolve whatever is still buffered. */
  end(): ParserEvent[] {
    return this.drain(true);
  }

  private drain(final: boolean): ParserEvent[] {
    const events: ParserEvent[] = [];
    const emitText = (text: string): void => {
      if (!text) return;
      const last = events[events.length - 1];
      if (last?.type === 'text') last.text += text;
      else events.push({ type: 'text', text });
    };

    for (;;) {
      // Search the original string: toUpperCase() can change length (ß → SS) and shift indexes.
      const start = this.buffer.search(OPEN_RE);
      if (start === -1) {
        // No tag opening; keep back a possible partial "[POI" at the end.
        const keep = final ? 0 : partialOpenSuffix(this.buffer);
        emitText(this.buffer.slice(0, this.buffer.length - keep));
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        return events;
      }

      emitText(this.buffer.slice(0, start));
      this.buffer = this.buffer.slice(start);

      const close = this.buffer.indexOf(']');
      if (close === -1) {
        if (this.buffer.length > maxLength(this.buffer) || final) {
          // Never closed: this was prose, not a tag. Release the opening and keep scanning after it.
          emitText(this.buffer.slice(0, openLength(this.buffer)));
          this.buffer = this.buffer.slice(openLength(this.buffer));
          continue;
        }
        return events; // wait for more input
      }

      if (close + 1 > maxLength(this.buffer)) {
        // Too long to be a tag: prose with a tag opening in it. Release the opening and keep scanning.
        emitText(this.buffer.slice(0, openLength(this.buffer)));
        this.buffer = this.buffer.slice(openLength(this.buffer));
        continue;
      }
      const raw = this.buffer.slice(0, close + 1);
      this.buffer = this.buffer.slice(close + 1);
      if (/^\[POINT:/i.test(raw)) {
        const tag = parsePointTag(raw);
        events.push(tag ? { type: 'point', tag } : { type: 'invalid-tag', raw });
      } else if (/^\[(?:TARGET|HOVER):/i.test(raw)) {
        const target = parseGuideTag(raw);
        events.push(target ? { type: 'target', target } : { type: 'invalid-tag', raw });
      } else if (/^\[DEEP[\]:]/i.test(raw)) {
        events.push({ type: 'deep' });
      } else if (/^\[TASK:/i.test(raw)) {
        const goal = parseTaskTag(raw);
        events.push(goal ? { type: 'task', goal } : { type: 'invalid-tag', raw });
      } else {
        const shape = parseDrawTag(raw);
        events.push(shape ? { type: 'draw', shape } : { type: 'invalid-tag', raw });
      }
    }
  }
}
