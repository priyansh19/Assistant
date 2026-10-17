import { describe, expect, it } from 'vitest';
import { scrub, stillPersonal } from './scrub.mjs';

describe('scrub (instruction pack)', () => {
  it('replaces folders, emails, phones, account URLs and keys', () => {
    expect(scrub('C:\\Users\\ana\\Desktop\\x.txt')).toBe('%USERPROFILE%\\Desktop\\x.txt');
    expect(scrub('/Users/ana/Documents')).toBe('~/Documents');
    expect(scrub('mail ana.rossi@example.it now')).toBe('mail <email> now');
    expect(scrub('call +39 333 123 4567')).toBe('call <phone>');
    expect(scrub('open github.com/priyansh19/OpenClicky')).toBe('open github.com/<your username>/OpenClicky');
    expect(scrub('linkedin.com/in/ana-rossi')).toBe('linkedin.com/in/<your username>');
    expect(scrub('key sk-or-v1-abcdefghijklmnopqrstuvwxyz')).toBe('key <secret>');
    expect(scrub('C:\\Users\\ana\\OneDrive - Zara Digital\\Desktop')).toBe('%USERPROFILE%\\OneDrive\\Desktop');
  });

  it('leaves ordinary steps alone', () => {
    expect(scrub('opened https://www.youtube.com; pressed ctrl+l; typed "cats"')).toBe(
      'opened https://www.youtube.com; pressed ctrl+l; typed "cats"',
    );
  });

  it('flags text that still names the owner', () => {
    expect(stillPersonal('Send it to Priyansh', ['priyansh'])).toBe(true);
    expect(stillPersonal('Open Notepad', ['priyansh'])).toBe(false);
  });
});
