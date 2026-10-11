import { describe, expect, it } from 'vitest';
import { ApprovalMemory, alwaysAsk } from './approvals.js';

describe('ApprovalMemory', () => {
  it('lets a similar step through once one like it was allowed', () => {
    const m = new ApprovalMemory();
    expect(m.covers('Merging pull request 2')).toBe(false);
    m.allow('Merging pull request 1');
    expect(m.covers('Merging pull request #2')).toBe(true);
    expect(m.covers('Submitting the job application form')).toBe(false);
  });

  it('always asks before deleting, closing, sending or paying', () => {
    const m = new ApprovalMemory();
    for (const t of ['Deleting report.txt', 'Closing the Notepad window', 'Sending the email', 'Paying AED 40']) {
      m.allow(t);
      expect(alwaysAsk(t)).toBe(true);
      expect(m.covers(t)).toBe(false);
    }
  });
});
