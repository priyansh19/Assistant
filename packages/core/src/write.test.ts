import { describe, expect, it } from 'vitest';
import { buildUserContext, parsePlaybook, playbookActive, serializePlaybook, type Playbook } from './profile.js';
import { backspaceCount, cleanInsert, planDictation, SayTagSplitter, TypingQueue, type LastInsert } from './write.js';

const last = (at: number): LastInsert => ({
  text: 'Thanks so much!',
  replaced: null,
  instruction: 'reply and say thanks',
  at,
  app: { process: 'chrome', title: 'Gmail' },
});

describe('planDictation', () => {
  it('types plain speech as dictation', () => {
    expect(planDictation('Today I have to ship three things', { hasSelection: false, last: null, now: 0 })).toEqual({
      kind: 'plain',
      text: 'Today I have to ship three things',
    });
  });

  it('treats "hey clicky", instructions and selections as writing requests', () => {
    expect(
      planDictation('Hey Clicky, reply to this and say thanks', { hasSelection: false, last: null, now: 0 }),
    ).toEqual({
      kind: 'write',
      instruction: 'reply to this and say thanks',
    });
    expect(
      planDictation('write a follow-up asking about pricing', { hasSelection: false, last: null, now: 0 }).kind,
    ).toBe('write');
    expect(planDictation('more formal please', { hasSelection: true, last: null, now: 0 }).kind).toBe('write');
  });

  it('rewrites the last insert only when asked soon after', () => {
    expect(planDictation('shorter', { hasSelection: false, last: last(0), now: 10_000 })).toEqual({
      kind: 'revise',
      instruction: 'shorter',
    });
    expect(planDictation('Make it a bit more formal', { hasSelection: false, last: last(0), now: 10_000 }).kind).toBe(
      'revise',
    );
    expect(planDictation('shorter', { hasSelection: false, last: last(0), now: 10 * 60_000 }).kind).toBe('plain');
  });
});

describe('SayTagSplitter', () => {
  const run = (chunks: string[]) => {
    const s = new SayTagSplitter();
    const typed = chunks.map((c) => s.push(c)).join('');
    const end = s.end();
    return { typed: typed + end.text, say: end.say };
  };

  it('never types the spoken tag, at any split point', () => {
    const reply = 'Hi Sam,\n\nThanks so much!\n\nBest,\nPriyansh\n[SAY:I wrote a short thank-you.]';
    for (let i = 1; i < reply.length; i++) {
      const r = run([reply.slice(0, i), reply.slice(i)]);
      expect(r.typed).toBe('Hi Sam,\n\nThanks so much!\n\nBest,\nPriyansh');
      expect(r.say).toBe('I wrote a short thank-you.');
    }
  });

  it('drops code fences, wrapping quotes and leading blank lines', () => {
    expect(run(['```text\n', 'git status', '\n```'])).toEqual({ typed: 'git status', say: null });
    expect(run(['\n\n"Sounds good', ', see you then!"'])).toEqual({ typed: 'Sounds good, see you then!', say: null });
    expect(run(['ok'])).toEqual({ typed: 'ok', say: null });
  });
});

describe('helpers', () => {
  it('cleans and counts', () => {
    expect(cleanInsert('```\nhello\n```')).toBe('hello');
    expect(backspaceCount('a\r\nb😀')).toBe(4);
  });

  it('TypingQueue sends in order, batching while busy, and reports failure', async () => {
    const sent: string[] = [];
    let release!: () => void;
    const q = new TypingQueue(async (t) => {
      sent.push(t);
      if (sent.length === 1) await new Promise<void>((r) => (release = r));
    });
    q.push('Hel');
    q.push('lo');
    q.push(' world');
    release();
    await q.flush();
    expect(sent).toEqual(['Hel', 'lo world']);
    expect(q.typed).toBe('Hello world');
    const bad = new TypingQueue(async () => Promise.reject(new Error('blocked')));
    bad.push('x');
    await expect(bad.flush()).rejects.toThrow('blocked');
  });
});

describe('playbooks and profile', () => {
  const pb = parsePlaybook(
    'email',
    '---\nname: Email replies\ndescription: Short and warm\napps: outlook, gmail\nmode: auto\n---\n- Under 120 words.\n',
  );

  it('parses front matter and round-trips', () => {
    expect(pb).toEqual({
      id: 'email',
      name: 'Email replies',
      description: 'Short and warm',
      apps: ['outlook', 'gmail'],
      mode: 'auto',
      body: '- Under 120 words.',
    });
    expect(parsePlaybook('email', serializePlaybook(pb))).toEqual(pb);
    expect(parsePlaybook('x', '# Code review\nBe blunt.').name).toBe('Code review');
  });

  it('switches on per app', () => {
    expect(playbookActive(pb, { process: 'chrome', title: 'Inbox - Gmail' })).toBe(true);
    expect(playbookActive(pb, { process: 'slack', title: 'general' })).toBe(false);
    expect(playbookActive({ ...pb, mode: 'always' }, null)).toBe(true);
    expect(playbookActive({ ...pb, mode: 'off' }, { process: 'outlook', title: '' })).toBe(false);
  });

  it('builds the user context from profile and active playbooks', () => {
    const books: Playbook[] = [pb, { ...pb, id: 'b', name: 'Off one', mode: 'off', body: 'never' }];
    const ctx = buildUserContext(
      { name: 'Priyansh', signOff: 'Best,\nPriyansh', tone: 'direct, friendly', samples: '' },
      books,
      { process: 'outlook', title: 'Mail' },
    );
    expect(ctx).toContain('Name: Priyansh');
    expect(ctx).toContain('Signs emails as:\nBest,\nPriyansh');
    expect(ctx).toContain('Playbook "Email replies"');
    expect(ctx).not.toContain('never');
    expect(buildUserContext({ name: '', signOff: '', tone: '', samples: '' }, [], null)).toBe('');
  });
});

describe("plain dictation stays the user's words", () => {
  it('only tidies dictated structure', async () => {
    const { needsTidy, faithfulTidy } = await import('./write.js');
    expect(needsTidy('how are you')).toBe(false);
    expect(needsTidy('today I need three things first milk second bread third eggs')).toBe(true);
    expect(faithfulTidy('how are you', "I'm doing well, thank you! How can I help you today?")).toBe(false);
    expect(
      faithfulTidy(
        'today I need three things first milk second bread third eggs',
        'Today I need three things:\n1. Milk\n2. Bread\n3. Eggs',
      ),
    ).toBe(true);
  });
});
