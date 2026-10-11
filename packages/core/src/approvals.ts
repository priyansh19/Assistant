/**
 * Approvals Clicky remembers, so the user isn't asked again and again for the same kind of step
 * ("Merging pull request 2" after allowing "Merging pull request 1"). Steps that delete, close,
 * send, pay or uninstall are always asked: a mistake there can't be taken back.
 */

/** Steps that are always asked, however similar to one allowed before. */
const ALWAYS_ASK =
  /\b(delet\w*|remov\w*|eras\w*|trash\w*|discard\w*|wip\w*|clos\w*|quit\w*|exit\w*|kill\w*|end task|uninstall\w*|format\w*|send\w*|sent|post\w*|publish\w*|pay\w*|buy\w*|purchas\w*|order\w*|checkout|transfer\w*|empty)\b/i;

const STOP = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'on',
  'in',
  'for',
  'and',
  'this',
  'that',
  'my',
  'your',
  'it',
  'number',
  'pr',
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/["'“”‘’#]/g, ' ')
      .split(/[^a-z]+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

/** True if this step must be asked every time. */
export function alwaysAsk(text: string): boolean {
  return ALWAYS_ASK.test(text);
}

export class ApprovalMemory {
  private readonly allowed: Set<string>[] = [];

  /** Remember that the user allowed this step. */
  allow(text: string): void {
    if (alwaysAsk(text)) return;
    const w = words(text);
    if (w.size) this.allowed.unshift(w);
    this.allowed.splice(50);
  }

  /** True if a step like this was allowed before (most of its words match) and it's safe to repeat. */
  covers(text: string): boolean {
    if (alwaysAsk(text)) return false;
    const w = words(text);
    if (!w.size) return false;
    return this.allowed.some((a) => {
      const shared = [...w].filter((x) => a.has(x)).length;
      return shared / Math.max(w.size, a.size) >= 0.6;
    });
  }

  clear(): void {
    this.allowed.length = 0;
  }
}
