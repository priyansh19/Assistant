import { describe, expect, it } from 'vitest';
import { SentenceChunker } from './sentence-chunker.js';

function chunk(parts: string[]): string[] {
  const c = new SentenceChunker();
  return parts.flatMap((p) => c.push(p)).concat(c.end());
}

describe('SentenceChunker', () => {
  it('emits the first sentence as soon as it is complete, even if short', () => {
    const c = new SentenceChunker();
    expect(c.push('Yes. ')).toEqual(['Yes.']);
  });

  it('waits for the boundary whitespace before emitting', () => {
    const c = new SentenceChunker();
    expect(c.push('Click Export.')).toEqual([]);
    expect(c.push(' Then')).toEqual(['Click Export.']);
  });

  it('merges short later sentences', () => {
    expect(chunk(['Click Export. Then PDF. Then choose the folder you want and press Save. Done.'])).toEqual([
      'Click Export.',
      'Then PDF. Then choose the folder you want and press Save.',
      'Done.',
    ]);
  });

  it('does not split decimals or versions', () => {
    expect(chunk(['Version 2.5 is out. '])).toEqual(['Version 2.5 is out.']);
  });

  it('splits on newlines and keeps closing quotes with their sentence', () => {
    expect(chunk(['Press "Save." Then wait for the upload to finish completely please.\nNext'])).toEqual([
      'Press "Save."',
      'Then wait for the upload to finish completely please.',
      'Next',
    ]);
  });

  it('is independent of how tokens are split', () => {
    const text = 'Open Settings. Go to the Privacy tab and turn off location history for all apps. That is it.';
    const whole = chunk([text]);
    expect(chunk([...text])).toEqual(whole);
  });

  it('returns nothing for empty input', () => {
    expect(chunk(['', '   '])).toEqual([]);
  });
});
