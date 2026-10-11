/** Audio helpers shared by providers and the orchestrator. Pure, no I/O. */

/** 16-bit PCM mono → WAV container. */
export function pcmToWav(samples: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(samples);
  return new Uint8Array(buf);
}

/** Concatenate PCM frames. */
export function joinFrames(frames: readonly Int16Array[]): Int16Array {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const all = new Int16Array(total);
  let o = 0;
  for (const f of frames) {
    all.set(f, o);
    o += f.length;
  }
  return all;
}

/**
 * Strips a leading `[HEARD:what the user said]` tag from a streamed answer. Used when the answer
 * model listens to the audio itself: the tag gives us the question text for history without a
 * separate speech-to-text service, and must never be spoken.
 */
export class HeardTagFilter {
  private buffer = '';
  private done = false;
  heard: string | null = null;

  /** Returns text that is safe to pass on (to the POINT parser and then TTS). */
  push(chunk: string): string {
    if (this.done) return chunk;
    this.buffer += chunk;
    const trimmed = this.buffer.trimStart();
    const OPEN = '[HEARD:';
    if (trimmed.length < OPEN.length && OPEN.startsWith(trimmed.toUpperCase())) return ''; // could still be the tag
    if (!trimmed.toUpperCase().startsWith(OPEN)) return this.release();
    const close = trimmed.indexOf(']');
    if (close === -1) {
      // A runaway tag: give up after a reasonable length and treat it as text.
      return trimmed.length > 400 ? this.release() : '';
    }
    this.heard = trimmed.slice(OPEN.length, close).trim() || null;
    this.done = true;
    const rest = trimmed.slice(close + 1);
    this.buffer = '';
    return rest.replace(/^\s+/, '');
  }

  /** Stream ended. */
  end(): string {
    return this.done ? '' : this.release();
  }

  private release(): string {
    this.done = true;
    const out = this.buffer;
    this.buffer = '';
    return out;
  }
}
