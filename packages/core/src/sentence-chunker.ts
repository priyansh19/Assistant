/**
 * Splits streamed text into speakable chunks so TTS can start on the first sentence while
 * the model is still writing the rest (plan §3.3 step 4).
 *
 * A chunk ends at sentence punctuation followed by whitespace. Very short sentences are
 * merged with the next one ("Yes." on its own sounds clipped), except the first chunk,
 * which goes out as soon as it is complete because time to first audio matters most.
 */

const BOUNDARY_RE = /[.!?…]+["')\]]*\s+|\n+/g;
/** Chunks after the first are at least this long unless the stream ends. */
export const MIN_CHUNK_CHARS = 40;

export class SentenceChunker {
  private buffer = '';
  private emitted = 0;

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    let cut = 0;
    BOUNDARY_RE.lastIndex = 0;
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
