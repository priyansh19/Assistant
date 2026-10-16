import { describe, expect, it } from 'vitest';
import type { AgentAction } from '../agent.js';
import { approvalKey, classifyRisk, confirmText, isNetworkPath, looksLikeCardNumber, maxRisk } from './risk.js';

const click = (target: string, risky = false): AgentAction => ({
  type: 'click',
  x: 500,
  y: 500,
  screen: null,
  target,
  say: 'Clicking',
  risky,
});
const key = (keys: string[]): AgentAction => ({ type: 'key', keys, say: '', risky: false });
const type = (text: string): AgentAction => ({ type: 'type', text, say: '', risky: false });
const open = (path: string): AgentAction => ({ type: 'open', app: '', url: '', path, say: '', risky: false });

describe('classifyRisk', () => {
  it('judges a destructive click by its target even when the model says it is not risky', () => {
    for (const t of ['Send', 'Delete repository', 'Buy now', 'Confirm merge', 'Elimina', 'Senden', 'Supprimer'])
      expect(classifyRisk(click(t, false)).level).toBe('irreversible');
  });

  it('uses the real control name too, not just the model label', () => {
    expect(classifyRisk(click('the blue button'), { targetName: 'Send' }).level).toBe('irreversible');
  });

  it('lets ordinary clicks through', () => {
    expect(classifyRisk(click('Search box')).level).toBe('safe');
    expect(classifyRisk(click('Sentence case')).level).toBe('safe');
  });

  it('asks before installs, sign-outs and permission grants', () => {
    expect(classifyRisk(click('Install')).level).toBe('confirm');
    expect(classifyRisk(click('Sign out')).level).toBe('confirm');
    expect(classifyRisk(click('Allow')).level).toBe('confirm');
  });

  it('raises a step the model marks risky to at least confirm, never lowers one', () => {
    expect(classifyRisk(click('Next', true)).level).toBe('confirm');
    expect(classifyRisk(click('Send', true)).level).toBe('irreversible');
  });

  it('treats Enter by the app it lands in', () => {
    expect(classifyRisk(key(['enter']), { window: 'WhatsApp' }).level).toBe('irreversible');
    expect(classifyRisk(key(['enter']), { window: 'Windows PowerShell' }).level).toBe('irreversible');
    expect(classifyRisk(key(['enter']), { window: 'Untitled - Notepad' }).level).toBe('safe');
    // An assistant app the user named in the task: sending the question is the task.
    expect(classifyRisk(key(['enter']), { window: 'Grok - Comet', goal: 'ask Grok about the weather' }).level).toBe(
      'safe',
    );
    expect(classifyRisk(key(['enter']), { window: 'Grok - Comet', goal: 'summarise this page' }).level).toBe('confirm');
  });

  it('treats a line break in typed text like pressing Enter', () => {
    expect(classifyRisk(type('see you at 5\n'), { window: 'Slack' }).level).toBe('irreversible');
    expect(classifyRisk(type('see you at 5'), { window: 'Slack' }).level).toBe('safe');
  });

  it('never types passwords, card numbers or into security windows', () => {
    expect(classifyRisk(type('hunter2'), { focusIsPassword: true }).level).toBe('forbidden');
    expect(classifyRisk(type('4111 1111 1111 1111')).level).toBe('forbidden');
    expect(classifyRisk(type('hello'), { window: 'Windows Security' }).level).toBe('forbidden');
    expect(
      classifyRisk({ type: 'set_value', id: 3, target: 'Password', text: 'x', say: '', risky: false } as AgentAction, {
        targetKind: 'password',
      }).level,
    ).toBe('forbidden');
  });

  it('knows dangerous keys', () => {
    expect(classifyRisk(key(['ctrl', 'alt', 'delete'])).level).toBe('forbidden');
    expect(classifyRisk(key(['shift', 'delete'])).level).toBe('irreversible');
    expect(classifyRisk(key(['delete']), { window: 'Downloads - File Explorer' }).level).toBe('irreversible');
    expect(classifyRisk(key(['delete']), { window: 'Untitled - Notepad' }).level).toBe('safe');
    expect(classifyRisk(key(['alt', 'f4'])).level).toBe('confirm');
    expect(classifyRisk(key(['win', 'r'])).level).toBe('confirm');
    expect(classifyRisk(key(['ctrl', 'enter']), { window: 'Untitled - Notepad' }).level).toBe('confirm');
  });

  it('runs programs only after asking, and never opens network paths', () => {
    expect(classifyRisk(open('C:\\Users\\Ana\\Downloads\\setup.exe')).level).toBe('irreversible');
    expect(classifyRisk(open('C:\\Users\\Ana\\Downloads\\run.ps1')).level).toBe('irreversible');
    expect(classifyRisk(open('C:\\Users\\Ana\\Documents\\report.pdf')).level).toBe('safe');
    expect(classifyRisk(open('\\\\server\\share\\x.pdf')).level).toBe('forbidden');
  });

  it('asks before moving files or closing windows', () => {
    const move: AgentAction = {
      type: 'move_files',
      from: 'C:\\a',
      pattern: '*.pdf',
      to: 'C:\\b',
      copy: false,
      say: '',
      risky: false,
    };
    expect(classifyRisk(move).level).toBe('confirm');
    expect(classifyRisk({ ...move, to: '\\\\nas\\backup' }).level).toBe('forbidden');
    expect(classifyRisk({ type: 'close_window', title: 'Notepad', say: '', risky: false }).level).toBe('confirm');
  });

  it('treats an action it does not know as needing a confirmation', () => {
    expect(classifyRisk({ type: 'teleport', say: '', risky: false } as unknown as AgentAction).level).toBe('confirm');
  });
});

describe('confirmText and approvalKey', () => {
  it('shows the real action, not the model wording', () => {
    const a: AgentAction = { type: 'type', text: 'Transfer 500 to Bob', say: 'Typing a friendly note', risky: false };
    expect(confirmText(a, { window: 'Bank - Edge' })).toBe('Type "Transfer 500 to Bob" in "Bank - Edge"');
    expect(confirmText(key(['ctrl', 'enter']))).toBe('Press Ctrl+Enter');
  });

  it('keys differ when the text or window differs', () => {
    const a = type('hello');
    expect(approvalKey(a, { window: 'Slack' })).not.toBe(approvalKey(type('bye'), { window: 'Slack' }));
    expect(approvalKey(a, { window: 'Slack' })).not.toBe(approvalKey(a, { window: 'Teams' }));
    expect(approvalKey(a, { window: 'Slack' })).toBe(approvalKey(type('hello'), { window: 'slack' }));
  });
});

describe('helpers', () => {
  it('finds card numbers only when the Luhn check passes', () => {
    expect(looksLikeCardNumber('4111-1111-1111-1111')).toBe(true);
    expect(looksLikeCardNumber('order 1234 5678 9012 3456')).toBe(false);
    expect(looksLikeCardNumber('call me at 555 1234')).toBe(false);
  });

  it('spots network paths', () => {
    expect(isNetworkPath('\\\\server\\share')).toBe(true);
    expect(isNetworkPath('//server/share')).toBe(true);
    expect(isNetworkPath('C:\\Users')).toBe(false);
  });

  it('orders levels', () => {
    expect(maxRisk('safe', 'confirm')).toBe('confirm');
    expect(maxRisk('forbidden', 'irreversible')).toBe('forbidden');
  });
});
