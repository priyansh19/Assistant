/**
 * What Clicky knows about the user when it writes or answers: the "writes like me" profile and the
 * playbooks that apply to the app in front. Everything here is stored on the PC only and sent to
 * the AI provider as part of the prompt, nowhere else.
 */

import type { AppInfo } from './write.js';

export interface VoiceProfile {
  name: string;
  /** How they sign emails, e.g. "Best,\nPriyansh". */
  signOff: string;
  /** A few words, e.g. "friendly, direct, no jargon". */
  tone: string;
  /** Pasted examples of their writing. */
  samples: string;
}

/**
 * A playbook: Markdown instructions that shape answers, writing and agent runs. 'auto' playbooks
 * switch on by themselves when the app in front matches one of `apps`.
 */
export interface Playbook {
  id: string;
  name: string;
  description: string;
  /** Process names or window-title words, e.g. ['outlook', 'gmail']. */
  apps: string[];
  mode: 'auto' | 'always' | 'off';
  body: string;
}

export const PLAYBOOK_MODES = ['auto', 'always', 'off'] as const;

/** Upper bounds so a huge playbook or sample can't crowd out the screenshot. */
const MAX_SAMPLES = 2500;
const MAX_PLAYBOOKS_CHARS = 6000;

/** True if the playbook applies to this app ('always', or 'auto' with a matching app). */
export function playbookActive(p: Playbook, app: AppInfo | null): boolean {
  if (p.mode === 'always') return true;
  if (p.mode !== 'auto' || !app || !p.apps.length) return false;
  const hay = `${app.process} ${app.title}`.toLowerCase();
  return p.apps.some((a) => {
    const needle = a
      .trim()
      .toLowerCase()
      .replace(/\.exe$/, '');
    return needle.length >= 2 && hay.includes(needle);
  });
}

export function activePlaybooks(list: readonly Playbook[], app: AppInfo | null): Playbook[] {
  return list.filter((p) => playbookActive(p, app));
}

/** The "About the user" block for prompts. Empty when there's nothing to say. */
export function buildUserContext(profile: VoiceProfile, playbooks: readonly Playbook[], app: AppInfo | null): string {
  const lines: string[] = [];
  if (profile.name.trim()) lines.push(`Name: ${profile.name.trim().slice(0, 80)}`);
  if (profile.signOff.trim()) lines.push(`Signs emails as:\n${profile.signOff.trim().slice(0, 200)}`);
  if (profile.tone.trim()) lines.push(`Their tone: ${profile.tone.trim().slice(0, 200)}`);
  if (profile.samples.trim())
    lines.push(
      `Examples of how they write (match this voice):\n"""\n${profile.samples.trim().slice(0, MAX_SAMPLES)}\n"""`,
    );
  let budget = MAX_PLAYBOOKS_CHARS;
  for (const p of activePlaybooks(playbooks, app)) {
    const body = p.body.trim().slice(0, budget);
    if (!body) continue;
    budget -= body.length;
    lines.push(`Playbook "${p.name}" (follow it):\n${body}`);
    if (budget <= 0) break;
  }
  return lines.join('\n\n');
}

/**
 * Parse a playbook file: optional front matter (name, description, apps, mode) then Markdown.
 *
 *   ---
 *   name: Email replies
 *   apps: outlook, gmail
 *   mode: auto
 *   ---
 *   - Keep replies under 120 words…
 */
export function parsePlaybook(id: string, text: string): Playbook {
  let body = text.replace(/^\uFEFF/, '');
  const meta: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (m?.[1]) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^\s*([a-z]+)\s*:\s*(.*)$/i.exec(line);
      if (kv?.[1]) meta[kv[1].toLowerCase()] = (kv[2] ?? '').trim();
    }
    body = body.slice(m[0].length);
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const mode = (PLAYBOOK_MODES as readonly string[]).includes(meta['mode'] ?? '')
    ? (meta['mode'] as Playbook['mode'])
    : 'off';
  return {
    id,
    name: (meta['name'] || heading || id).slice(0, 80),
    description: (meta['description'] ?? '').slice(0, 200),
    apps: (meta['apps'] ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .slice(0, 20),
    mode,
    body: body.trim(),
  };
}

export function serializePlaybook(p: Playbook): string {
  return [
    '---',
    `name: ${p.name.replace(/\n/g, ' ')}`,
    `description: ${p.description.replace(/\n/g, ' ')}`,
    `apps: ${p.apps.join(', ')}`,
    `mode: ${p.mode}`,
    '---',
    '',
    p.body.trim(),
    '',
  ].join('\n');
}
