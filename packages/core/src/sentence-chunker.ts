/**
 * Splits streamed text into speakable chunks so TTS can start on the first sentence while
 * the model is still writing the rest (plan §3.3 step 4).
 *
 * A chunk ends at sentence punctuation followed by whitespace. Very short sentences are
 * merged with the next one ("Yes." on its own sounds clipped), except the first chunk,
 * which goes out as soon as it is complete because time to first audio matters most.
 *
 * With `eagerFirst`, the first chunk doesn't even wait for the sentence to end: it also ends at a
 * clause break (comma, colon, semicolon, dash) once it has a few words, or after EAGER_MAX_WORDS
 * words, so the voice can start while the model is still writing the first sentence.
 */

const BOUNDARY_RE = /[.!?…]+["')\]]*\s+|\n+/g;
/** Chunks after the first are at least this long unless the stream ends. */
export const MIN_CHUNK_CHARS = 40;
/** An eager first chunk ends at a clause break only once it has this many words ("So," is too short). */
export const EAGER_MIN_WORDS = 3;
/** An eager first chunk with no break at all ends after this many words. */
export const EAGER_MAX_WORDS = 8;

const CLAUSE_RE = /[,;:]["')\]]*\s+|\s+[—–-]\s+/g;
const WORD_RE = /\S+\s+/g;

export interface SentenceChunkerOptions {
  eagerFirst?: boolean;
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** Where an eager first chunk can end in `text`, or 0 if it can't yet. */
export function eagerCut(text: string): number {
  CLAUSE_RE.lastIndex = 0;
  for (let m = CLAUSE_RE.exec(text); m; m = CLAUSE_RE.exec(text)) {
    const end = m.index + m[0].length;
    if (words(text.slice(0, end)) >= EAGER_MIN_WORDS) return end;
  }
  WORD_RE.lastIndex = 0;
  let n = 0;
  for (let m = WORD_RE.exec(text); m; m = WORD_RE.exec(text)) {
    if (++n === EAGER_MAX_WORDS) return m.index + m[0].length;
  }
  return 0;
}

export class SentenceChunker {
  private buffer = '';
  private emitted = 0;

  constructor(private readonly opts: SentenceChunkerOptions = {}) {}

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    let cut = 0;
    if (this.opts.eagerFirst && this.emitted === 0) {
      // A sentence end that comes first still wins (it is found by the loop below).
      BOUNDARY_RE.lastIndex = 0;
      const sentence = BOUNDARY_RE.exec(this.buffer);
      const eager = eagerCut(this.buffer);
      if (eager && (!sentence || eager < sentence.index + sentence[0].length)) {
        const chunk = this.buffer.slice(0, eager).trim();
        if (chunk) out.push(chunk);
        cut = eager;
      }
    }
    BOUNDARY_RE.lastIndex = cut;
    for (let m = BOUNDARY_RE.exec(this.buffer); m; m = BOUNDARY_RE.exec(this.buffer)) {
      const end = m.index + m[0].length;
      const candidate = this.buffer.slice(cut, end);
      if (this.emitted + out.length === 0 || candidate.trim().length >= MIN_CHUNK_CHARS) {
        const chunk = candidate.trim();
        if (chunk) out.push(chunk);
        cut = end;
      }
    }
    this.buffer = this.buffer.slice(cut);
    this.emitted += out.length;
    return out;
  }

  /** Stream ended: whatever is left is the last chunk. */
  end(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) return [];
    this.emitted++;
    return [rest];
  }
}
