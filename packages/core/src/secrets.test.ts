import { describe, expect, it } from 'vitest';
import { redactSecrets, secretReason } from './secrets.js';

describe('secretReason', () => {
  it.each([
    ['my key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', 'API key'],
    ['sk-or-v1-0123456789abcdef0123456789', 'API key'],
    ['xi-abcdef1234567890', 'API key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'GitHub token'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', 'sign-in token'],
    ['Authorization: Bearer abcdefghijklmnop123456', 'sign-in token'],
    ['https://x.test/cb?access_token=abc123def456', 'password or token'],
    ['my password is hunter2', 'password or code'],
    ['the PIN is 4821', 'password or code'],
    ['card 4111 1111 1111 1111 exp 12/29', 'card number'],
    ['0123456789abcdef0123456789abcdef', 'key'],
  ])('refuses %s', (text, what) => {
    expect(secretReason(text)).toContain(what);
  });

  it.each([
    'Comet is on my taskbar',
    'my reports are in D:/Reports',
    'Pin Notepad to the taskbar',
    'call me on 050 123 4567',
    'order 1234567890123 arrived', // 13 digits failing the Luhn check
    'the meeting token of thanks',
  ])('keeps %s', (text) => {
    expect(secretReason(text)).toBeNull();
  });
});

describe('redactSecrets', () => {
  it('masks every shape and keeps the rest', () => {
    const out = redactSecrets(
      'key sk-proj-AAAAAAAAAAAAAAAAAAAAAA and Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigsigsigsig ok token=abcd1234',
    );
    expect(out).not.toMatch(/AAAAAAAAAAAA|sigsigsig|abcd1234/);
    expect(out).toContain('sk-p…[redacted]');
    expect(out).toContain('ok');
  });

  it('masks card numbers', () => {
    expect(redactSecrets('pay with 4111-1111-1111-1111 now')).toBe('pay with [card redacted] now');
  });
});
