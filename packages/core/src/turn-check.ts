/**
 * A checker for short lines Clicky shows in a bubble or speaks unprompted: the hello, onboarding
 * lines, hand-offs, routine and helper announcements. Models drift past word caps and add dashes
 * and second questions; the code checks every such line and, when it can't be repaired, the caller
 * falls back to fixed copy.
 */

export interface TurnRules {
  maxWords?: number;
  maxSentences?: number;
  /** No em or en dashes, or spaced hyphens (they read badly in a bubble and when spoken). */
  noDashes?: boolean;
  /** At most this many questions (0 = none). */
  maxQuestions?: number;
  /** Must not introduce itself ("I'm Clicky"): used on the first hello after the overlay did. */
  noSelfIntro?: boolean;
  /** Words or phrases that must appear (case-insensitive). */
  mustInclude?: string[];
  /** Words or phrases that must not appear (case-insensitive). */
  mustNotInclude?: string[];
}

export type TurnViolation =
  | { kind: 'words'; count: number; max: number }
  | { kind: 'sentences'; count: number; max: number }
  | { kind: 'dash' }
  | { kind: 'questions'; count: number; max: number }
  | { kind: 'self-intro' }
  | { kind: 'missing'; text: string }
  | { kind: 'forbidden'; text: string }
  | { kind: 'empty' };

const DASH = /[—–]|\s-\s|\s--\s/;
const SELF_INTRO = /\b(?:i'?m|i am|my name is|this is|call me)\s+(?:hey\s*)?click(?:e)?y\b|\bclick(?:e)?y here\b/i;

export const wordCount = (t: string): number => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

function sentences(t: string): string[] {
  return t
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}"'(])/u)
    .filter((s) => s.trim());
}

export function checkTurn(text: string, rules: TurnRules): TurnViolation[] {
  const t = text.trim();
  if (!t) return [{ kind: 'empty' }];
  const out: TurnViolation[] = [];
  const words = wordCount(t);
  if (rules.maxWords !== undefined && words > rules.maxWords) out.push({ kind: 'words', count: words, max: rules.maxWords });
  const sent = sentences(t).length;
  if (rules.maxSentences !== undefined && sent > rules.maxSentences) out.push({ kind: 'sentences', count: sent, max: rules.maxSentences });
  if (rules.noDashes && DASH.test(t)) out.push({ kind: 'dash' });
  const q = (t.match(/\?/g) ?? []).length;
  if (rules.maxQuestions !== undefined && q > rules.maxQuestions) out.push({ kind: 'questions', count: q, max: rules.maxQuestions });
  if (rules.noSelfIntro && SELF_INTRO.test(t)) out.push({ kind: 'self-intro' });
  const lower = t.toLowerCase();
  for (const m of rules.mustInclude ?? []) if (!lower.includes(m.toLowerCase())) out.push({ kind: 'missing', text: m });
  for (const m of rules.mustNotInclude ?? []) if (lower.includes(m.toLowerCase())) out.push({ kind: 'forbidden', text: m });
  return out;
}

/**
 * Repair what can be repaired (dashes become commas, extra sentences and words are cut at a
 * sentence boundary, extra questions dropped) and return the line, or the fallback when the
 * result still breaks a rule (a self-introduction, a missing or forbidden phrase, or nothing left).
 */
export function fitTurn(text: string, rules: TurnRules, fallback: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  if (rules.noDashes) t = t.replace(/\s*[—–]\s*|\s+--?\s+/g, ', ').replace(/,\s*,/g, ',');
  let parts = sentences(t);
  if (rules.maxQuestions !== undefined) {
    let q = 0;
    const max = rules.maxQuestions;
    parts = parts.filter((s) => !s.includes('?') || ++q <= max);
  }
  if (rules.maxSentences !== undefined) parts = parts.slice(0, Math.max(1, rules.maxSentences));
  if (rules.maxWords !== undefined) {
    const kept: string[] = [];
    let n = 0;
    for (const s of parts) {
      const w = wordCount(s);
      if (n + w > rules.maxWords) break;
      kept.push(s);
      n += w;
    }
    parts = kept;
  }
  t = parts.join(' ').trim();
  return t && checkTurn(t, rules).length === 0 ? t : fallback;
}

/** Caps for the lines Clicky speaks on its own. */
export const TURN_RULES = {
  /** The first hello after the overlay already said "Hey! I'm Clicky." */
  hello: { maxWords: 25, maxSentences: 2, noDashes: true, maxQuestions: 1, noSelfIntro: true },
  onboarding: { maxWords: 25, maxSentences: 2, noDashes: true, maxQuestions: 1 },
  /** A finished task or routine announced when the user isn't looking. */
  announcement: { maxWords: 30, maxSentences: 2, noDashes: true, maxQuestions: 1 },
  /** Starter helper suggestions: never claim work has started. */
  suggestion: {
    maxWords: 40,
    maxSentences: 2,
    noDashes: true,
    maxQuestions: 1,
    mustNotInclude: ["i'm on it", 'started', 'working on it', 'already done'],
  },
} satisfies Record<string, TurnRules>;
