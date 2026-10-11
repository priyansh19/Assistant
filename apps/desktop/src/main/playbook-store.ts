import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { parsePlaybook, serializePlaybook, type Playbook } from '@clicky/core';
import { log } from './log';

/** Playbooks Clicky starts with. Users can edit, switch off or delete any of them. */
const STARTERS: Playbook[] = [
  {
    id: 'email-replies',
    name: 'Email replies',
    description: 'Clear, warm emails that get to the point.',
    apps: ['outlook', 'gmail', 'thunderbird', 'hxoutlook', 'mail'],
    mode: 'auto',
    body: `- Open with the person's first name ("Hi Sam,"), never "Dear Sir/Madam".
- First sentence answers or acknowledges; details after.
- Keep replies under 120 words unless the email asks for detail.
- One clear next step or question at the end.
- Sign off with the user's sign-off.`,
  },
  {
    id: 'chat-messages',
    name: 'Chat messages',
    description: 'Short, natural messages for Slack, Teams, WhatsApp and LinkedIn chat.',
    apps: ['slack', 'teams', 'ms-teams', 'whatsapp', 'discord', 'telegram', 'signal', 'messenger'],
    mode: 'auto',
    body: `- Write like a person typing in chat: one to three short sentences.
- No greeting line, no sign-off, no subject.
- Match the formality of the conversation on screen.`,
  },
  {
    id: 'ai-prompts',
    name: 'Prompts for AI coding tools',
    description: 'Turns what you say into a precise prompt for Claude Code, Cursor and similar tools.',
    apps: ['windowsterminal', 'code', 'cursor', 'claude', 'pwsh', 'powershell'],
    mode: 'auto',
    body: `- When writing a prompt for an AI coding assistant, be specific: what to change, where, and how to check it worked.
- Number the steps if there are several, and ask it to explain anything non-obvious in plain language.
- Use what's visible on screen (errors, file names, the assistant's last message) as context.
- Never include secrets or tokens.`,
  },
  {
    id: 'teach-me',
    name: 'Teach me as I go',
    description: 'Explains the why in plain words, for when you are learning a tool.',
    apps: [],
    mode: 'off',
    body: `- Assume the user is new to this tool. Explain jargon in a few plain words the first time it comes up.
- When pointing at something, say what it does and why they'd use it, not only where it is.`,
  },
  {
    id: 'founder-pitch',
    name: 'Founder pitch',
    description: 'Crisp one-liners, decks and investor updates.',
    apps: [],
    mode: 'off',
    body: `- Lead with the customer and the problem, then what the product does, in plain words.
- One idea per sentence. Concrete numbers beat adjectives. No buzzwords ("revolutionary", "synergy").
- A pitch one-liner fits in one breath: who it's for, what it does, why now.`,
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    description: 'Professional but human posts, comments and connection notes.',
    apps: ['linkedin'],
    mode: 'auto',
    body: `- Warm and professional; no hype, at most one emoji, no hashtag walls.
- Connection notes stay under 300 characters and mention one specific, real reason to connect.`,
  },
];

/** Markdown playbooks in userData/playbooks, one file each. */
export class PlaybookStore {
  readonly dir = join(app.getPath('userData'), 'playbooks');
  private readonly listeners = new Set<() => void>();
  private cache: Playbook[] | null = null;

  constructor() {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      for (const p of STARTERS) writeFileSync(this.file(p.id), serializePlaybook(p));
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private file(id: string): string {
    return join(this.dir, `${id}.md`);
  }

  list(): Playbook[] {
    if (this.cache) return this.cache;
    const out: Playbook[] = [];
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.toLowerCase().endsWith('.md')) continue;
        try {
          out.push(parsePlaybook(f.slice(0, -3), readFileSync(join(this.dir, f), 'utf8')));
        } catch (e) {
          log.warn(`playbook ${f} could not be read`, String(e));
        }
      }
    } catch (e) {
      log.warn('playbooks folder could not be read', String(e));
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    this.cache = out;
    return out;
  }

  /** Save (create or replace) a playbook; returns its id. */
  save(p: Omit<Playbook, 'id'> & { id?: string }): string {
    const id = p.id && /^[a-z0-9-]{1,60}$/.test(p.id) ? p.id : this.newId(p.name);
    writeFileSync(this.file(id), serializePlaybook({ ...p, id }));
    this.changed();
    return id;
  }

  remove(id: string): void {
    if (!/^[a-z0-9-]{1,60}$/.test(id)) return;
    rmSync(this.file(id), { force: true });
    this.changed();
  }

  /** The folder was edited by hand (e.g. after "Open folder"): read it again. */
  reload(): void {
    this.changed();
  }

  private newId(name: string): string {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'playbook';
    let id = base;
    for (let n = 2; existsSync(this.file(id)); n++) id = `${base}-${n}`;
    return id;
  }

  private changed(): void {
    this.cache = null;
    for (const fn of this.listeners) fn();
  }
}
