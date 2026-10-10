/**
 * Streaming parser for the POINT protocol (blueprint §5, development plan §3.2).
 *
 *   [POINT:x,y:label]            point on the screen the image came from
 *   [POINT:x,y:label:screenN]    point on screen N (1-based, in the order images were sent)
 *   [POINT:none]                 nothing to point at
 *
 * Text arrives as LLM tokens split at arbitrary positions. The parser releases text that is
 * safe to speak and holds back anything that could still turn into a tag, so tag text never
 * reaches TTS. Tags may appear anywhere; the prompt asks for one at the start.
 */

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

export type ParserEvent =
  | { type: 'text'; text: string }
  | { type: 'point'; tag: PointTag }
  /** Something that started like a tag but did not parse. It is dropped, never spoken. */
  | { type: 'invalid-tag'; raw: string };

const OPEN = '[POINT:';
/** A tag longer than this is not a tag; release it as text so a stray "[POINT:" can't swallow the answer. */
export const MAX_TAG_LENGTH = 160;

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

/** Length of the longest suffix of `s` that is a prefix of "[POINT:" (case-insensitive). */
function partialOpenSuffix(s: string): number {
  const max = Math.min(s.length, OPEN.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.slice(s.length - n).toUpperCase() === OPEN.slice(0, n)) return n;
  }
  return 0;
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
      const start = this.buffer.toUpperCase().indexOf(OPEN);
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
        if (this.buffer.length > MAX_TAG_LENGTH || final) {
          // Never closed: this was prose, not a tag. Release the opening and keep scanning after it.
          emitText(this.buffer.slice(0, OPEN.length));
          this.buffer = this.buffer.slice(OPEN.length);
          continue;
        }
        return events; // wait for more input
      }

      const raw = this.buffer.slice(0, close + 1);
      this.buffer = this.buffer.slice(close + 1);
      const tag = raw.length <= MAX_TAG_LENGTH ? parsePointTag(raw) : null;
      events.push(tag ? { type: 'point', tag } : { type: 'invalid-tag', raw });
    }
  }
}
