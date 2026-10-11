import { describe, expect, it } from 'vitest';
import { HeardTagFilter, joinFrames, pcmToWav } from './audio.js';

function run(chunks: string[]): { out: string; heard: string | null } {
  const f = new HeardTagFilter();
  const out = chunks.map((c) => f.push(c)).join('') + f.end();
  return { out, heard: f.heard };
}

describe('HeardTagFilter', () => {
  it('strips the heard tag and keeps the rest', () => {
    expect(run(['[HEARD: where is export?] [POINT:1,2:x]Click it.'])).toEqual({
      out: '[POINT:1,2:x]Click it.',
      heard: 'where is export?',
    });
  });

  it('works for every split point', () => {
    const text = '[HEARD:open settings][POINT:none]Sure.';
    for (let i = 0; i <= text.length; i++) {
      expect(run([text.slice(0, i), text.slice(i)])).toEqual({ out: '[POINT:none]Sure.', heard: 'open settings' });
    }
  });

  it('passes through answers without the tag', () => {
    expect(run(['[POINT:none]', 'Hello.'])).toEqual({ out: '[POINT:none]Hello.', heard: null });
    expect(run(['[HE'])).toEqual({ out: '[HE', heard: null });
  });
});

describe('audio helpers', () => {
  it('joins frames and writes a WAV header', () => {
    const all = joinFrames([new Int16Array([1, 2]), new Int16Array([3])]);
    expect([...all]).toEqual([1, 2, 3]);
    const wav = pcmToWav(all, 16000);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(wav.length).toBe(44 + 6);
  });
});
