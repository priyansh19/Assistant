import { describe, expect, it } from 'vitest';
import { buildUserContext } from './profile.js';
import {
  contextOf,
  learnedStyleText,
  learningAllowed,
  mergeStyle,
  parseStyleReply,
  type LearnedStyle,
} from './style.js';

describe('style learning', () => {
  it('maps apps to kinds of writing', () => {
    expect(contextOf({ process: 'chrome', title: 'Inbox (3) - Gmail' })).toBe('email');
    expect(contextOf({ process: 'whatsapp', title: 'WhatsApp' })).toBe('chat');
    expect(contextOf({ process: 'msedge', title: 'Feed | LinkedIn' })).toBe('social');
    expect(contextOf({ process: 'explorer', title: 'Downloads' })).toBe('other');
  });

  it('respects the exclude list', () => {
    expect(learningAllowed({ process: 'bitwarden', title: 'Vault' }, '1password, bitwarden')).toBe(false);
    expect(learningAllowed({ process: 'chrome', title: 'HDFC Bank - NetBanking' }, 'bank')).toBe(false);
    expect(learningAllowed({ process: 'slack', title: 'general' }, 'bitwarden')).toBe(true);
    expect(learningAllowed(null, '')).toBe(false);
  });

  it('parses observations and drops private-looking text', () => {
    expect(parseStyleReply('{"found": false}')).toBeNull();
    expect(
      parseStyleReply(
        '{"found": true, "notes": ["greets with Hey", "otp 123456"], "examples": ["cheers, P", "mail me at a@b.co"]}',
      ),
    ).toEqual({ notes: ['greets with Hey'], examples: ['cheers, P'] });
  });

  it('merges newest first without duplicates, and feeds the prompt for the matching app', () => {
    let s: LearnedStyle = {};
    s = mergeStyle(s, 'chat', { notes: ['writes in lowercase'], examples: ['sounds good'] }, 1);
    s = mergeStyle(s, 'chat', { notes: ['Writes in lowercase!', 'uses "haha"'], examples: [] }, 2);
    expect(s.chat?.notes).toEqual(['Writes in lowercase!', 'uses "haha"']);
    const chatApp = { process: 'slack', title: 'dm' };
    expect(learnedStyleText(s, chatApp)).toContain('How they write chat messages');
    expect(learnedStyleText(s, { process: 'outlook', title: 'Mail' })).toBe('');
    const ctx = buildUserContext({ name: 'P', signOff: '', tone: '', samples: '' }, [], chatApp, s);
    expect(ctx).toContain('Phrases they use: "sounds good"');
  });
});
