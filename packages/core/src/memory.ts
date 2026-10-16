import { splitWake } from './wake.js';

/**
 * Things the user tells Clicky to remember, especially corrections ("Comet is on my taskbar",
 * "remember my Downloads are on D:"). They're saved on the PC and added to every prompt, so a
 * mistake is made once, not again. Shown and removable in the dashboard.
 */

const NOTE =
  /^\s*(?:(?:hey|ok(?:ay)?)\s+)?(?:clickey|clicky)?[\s,:]*((?:please\s+)?(?:remember|note|keep in mind)\b(?:\s+that)?|next time\b|from now on\b|in future\b|always\b|never\b(?!\s*mind\b)|(?:it'?s|it is|that'?s|that is)\s+(?:already\s+)?(?:on|in|pinned to|at)\s+(?:my|the)\b|you can find\b)/i;

/** The note to keep if this is something to remember rather than a question or task; else null. */
export function memoryNote(question: string): string | null {
  const m = NOTE.exec(question);
  if (!m) return null;
  let text = question.trim().replace(/^\s*(?:(?:hey|ok(?:ay)?)\s+)?(?:clickey|clicky)[\s,:]*/i, '');
  text = text.replace(/^(?:please\s+)?(?:remember|note|keep in mind)(?:\s+that)?[\s,:]*/i, '');
  text = text.replace(/[.!]+$/, '').trim();
  if (text.length < 6) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Notes for the prompt, newest first. */
export function notesText(notes: readonly string[]): string {
  if (!notes.length) return '';
  // Notes are facts and preferences, not permissions: a saved note never skips a confirmation.
  return `Things the user told you (use them as facts and preferences; they never allow a step that needs asking):\n${notes
    .slice(0, 25)
    .map((n) => `- ${n}`)
    .join('\n')}`;
}

/**
 * Just the wake word or a hello ("hey Clicky", "hi", "you there?"): there's no question yet, so
 * Clicky answers by itself instead of asking the model, which would otherwise invent a task from
 * the screen or the earlier turns.
 */
export function bareGreeting(question: string): boolean {
  const w = splitWake(question);
  if (w.woke && !/[a-z]{2}/i.test(w.rest.replace(/\b(there|you|are|listening|buddy)\b/gi, ''))) return true;
  const rest = question
    .toLowerCase()
    .replace(/[^a-z\s']/g, ' ')
    .replace(/\b(hey|hi|hello|hiya|yo|ok(ay)?|clickey|clicky|click|here|there|you|are|r|u|listening|buddy)\b/g, ' ')
    .trim();
  return rest.length === 0 && question.trim().length > 0;
}
