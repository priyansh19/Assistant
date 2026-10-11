/**
 * The assistant's name at the start of what was said, as speech recognition actually hears it:
 * "Clicky", "Clickey", "Plicky", "Click here", "Hi-Clicky", "High Clicky". Found by the voice suite
 * (2026-10-11): an exact match missed most of these, so requests to Clicky were typed or ignored.
 */

const GREETINGS = new Set(['hey', 'hi', 'high', 'hay', 'hai', 'ok', 'okay', 'yo', 'hello', 'oi']);
const NAMES = ['clicky', 'clickey', 'clickhere', 'clicki'];

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  return (d[a.length] as number[])[b.length] ?? 99;
}

const letters = (w: string): string => w.toLowerCase().replace(/[^a-z]/g, '');

/** True for the name or a near-miss of it (within two letters, with the "ck"/"k" sound). */
export function soundsLikeName(word: string): boolean {
  const w = letters(word);
  if (w.length < 4 || w.length > 10 || !/c|k/.test(w)) return false;
  // The ordinary verb is not the name ("click the save button"); "click here" is handled by the caller.
  if (/^click(s|ed|ing)?$/.test(w)) return false;
  return NAMES.some((n) => distance(w, n) <= (n.length >= 8 ? 2 : w.length <= 5 ? 1 : 2));
}

/**
 * Split a leading "(hey) Clicky" off what was said. `rest` is what follows, without the joining
 * punctuation ("Plicky, open Notepad." → woke, "open Notepad.").
 */
export function splitWake(text: string): { woke: boolean; rest: string } {
  const spans = [...text.trim().matchAll(/[^\s-]+/g)];
  const tokens = spans.map((m) => m[0]);
  let i = 0;
  if (tokens.length > 1 && GREETINGS.has(letters(tokens[0] ?? ''))) i = 1;
  const one = tokens[i] ?? '';
  const next = letters(tokens[i + 1] ?? '');
  let used = 0;
  if ((next === 'here' || next === 'y' || next === 'e') && soundsLikeName(one + next)) used = 2;
  else if (soundsLikeName(one)) used = 1;
  if (!used) return { woke: false, rest: text.trim() };
  // The rest exactly as said: hyphens and spacing matter in file names and searches
  // ("clicky-shopping.txt", "lo-fi"). Found by the stress suite.
  const last = spans[i + used - 1];
  const rest = text
    .trim()
    .slice((last?.index ?? 0) + (last?.[0].length ?? 0))
    .replace(/^[\s,:;.!?-]+/, '')
    .trim();
  return { woke: true, rest };
}
