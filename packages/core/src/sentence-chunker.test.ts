import { describe, expect, it } from 'vitest';
import { eagerCut, SentenceChunker } from './sentence-chunker.js';

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

  describe('eagerFirst', () => {
    const eager = (parts: string[]): string[] => {
      const c = new SentenceChunker({ eagerFirst: true });
      return parts.flatMap((p) => c.push(p)).concat(c.end());
    };

    it('ends the first chunk at a clause break once it has a few words', () => {
      const c = new SentenceChunker({ eagerFirst: true });
      expect(c.push('Open the File menu,')).toEqual([]);
      expect(c.push(' then')).toEqual(['Open the File menu,']);
    });

    it('does not cut a clause that is too short', () => {
      expect(eager(['So, open the File menu and choose Export. '])).toEqual([
        'So, open the File menu and choose Export.',
      ]);
    });

    it('cuts after a few words when there is no break yet', () => {
      const c = new SentenceChunker({ eagerFirst: true });
      expect(c.push('Click the blue button in the top right corner of')).toEqual([
        'Click the blue button in the top right',
      ]);
    });

    it('lets a sentence end that comes first win', () => {
      expect(eager(['Yes. That is the Export button, on the right.'])).toEqual([
        'Yes.',
        'That is the Export button, on the right.',
      ]);
    });

    it('only applies to the first chunk', () => {
      expect(
        eager(['Open the File menu, then choose Export. After that, pick the PDF format, and press the Save button. ']),
      ).toEqual([
        'Open the File menu,',
        'then choose Export. After that, pick the PDF format, and press the Save button.',
      ]);
    });

    it('does not cut inside numbers or hyphenated words', () => {
      expect(eagerCut('It costs 3,000 euros')).toBe(0);
      expect(eagerCut('A well-known fact')).toBe(0);
    });

    it('handles a break split across stream pieces', () => {
      expect(eager(['Open the File', ' menu', ',', ' then Export.'])).toEqual(['Open the File menu,', 'then Export.']);
    });
  });
});
