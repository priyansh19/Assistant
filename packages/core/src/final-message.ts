/**
 * The tail every agent turn ends with: the answer for the chat, then tagged blocks Clicky strips
 * and acts on. The limits are enforced here in code, not trusted to the model, and tag text is
 * never shown or spoken (the same rule as POINT tags).
 *
 *   <SUMMARY>One plain sentence, result first.</SUMMARY>
 *   <NEXT_ACTIONS>
 *   - Short action phrase
 *   </NEXT_ACTIONS>
 *   <DONE_TITLE>Short Noun Phrase</DONE_TITLE>
 *   <ARTIFACTS>
 *   - C:\Users\me\Documents\Clicky\Pitch Lab\output\deck.pptx
 *   </ARTIFACTS>
 *   <NOTES>
 *   - Durable fact for this helper's notes
 *   </NOTES>
 *   <ROUTINE>{"action":"create","every_minutes":1440,"title":"Morning Inbox","task":"…"}</ROUTINE>
 *   <COMPUTER_USE_REQUEST>I need to take over your screen to … Mind if I do that?</COMPUTER_USE_REQUEST>
 */

export const BLOCKS = ['SUMMARY', 'NEXT_ACTIONS', 'DONE_TITLE', 'ARTIFACTS', 'NOTES', 'ROUTINE', 'COMPUTER_USE_REQUEST'] as const;
export type BlockName = (typeof BLOCKS)[number];

export const LIMITS = {
  summaryChars: 200,
  nextActions: 4,
  nextActionChars: 40,
  titleWords: 5,
  artifacts: 8,
  notes: 3,
};

export interface FinalMessage {
  /** The answer shown in the chat, with every block removed. */
  answer: string;
  /** The one sentence spoken when the user isn't looking at the chat. */
  summary: string;
  nextActions: string[];
  title: string;
  /** Paths or http(s) URLs, still to be checked with `checkArtifacts`. */
  artifacts: string[];
  /** Facts the run wants kept in its Clicky's notes; `addNote` still filters them. */
  notes: string[];
  /** Raw ROUTINE JSON, validated by `parseRoutineRequest` in routines.ts. */
  routine: string | null;
  computerUseRequest: string | null;
  /** True when the turn is a question for the user (no next actions offered). */
  isQuestion: boolean;
  /** Blocks that were present but broken, for the log. */
  problems: string[];
}

const blockRe = (name: string): RegExp => new RegExp(`<${name}>([\\s\\S]*?)(?:</${name}>|$)`, 'i');
const ANY_BLOCK = new RegExp(`<(${BLOCKS.join('|')})>[\\s\\S]*?(?:</\\1>|$)`, 'gi');
const STRAY_TAG = new RegExp(`</?(?:${BLOCKS.join('|')})>`, 'gi');

const bullets = (body: string): string[] =>
  body
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);

const plain = (t: string): string =>
  t
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // markdown links → their text
    .replace(/[*_`#>]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Cut to `max` characters at a word boundary. */
function clip(t: string, max: number): string {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:–-]+$/, '');
}

function firstSentence(text: string): string {
  const t = plain(text);
  const m = /^(.{10,}?[.!?])(\s|$)/.exec(t);
  return (m?.[1] ?? t).trim();
}

function titleCase(t: string): string {
  return t
    .split(/\s+/)
    .map((w, i) => (i > 0 && /^(a|an|the|and|or|of|for|to|in|on)$/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Text safe to show or speak while the reply is still streaming: blocks and half-open tags removed. */
export function visibleText(partial: string): string {
  let t = partial.replace(ANY_BLOCK, '').replace(STRAY_TAG, '');
  // A tag that has started but not finished ("…done. <SUMM") is held back.
  t = t.replace(/<\/?[A-Z_]{0,24}$/i, '');
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseFinalMessage(text: string): FinalMessage {
  const problems: string[] = [];
  const get = (name: BlockName): string | null => {
    const m = blockRe(name).exec(text);
    if (!m) return null;
    if (!new RegExp(`</${name}>`, 'i').test(text)) problems.push(`${name} was not closed`);
    return (m[1] ?? '').trim();
  };

  const answer = visibleText(text);
  const computerUseRequest = get('COMPUTER_USE_REQUEST') || null;

  let summary = plain(get('SUMMARY') ?? '');
  if (!summary) {
    if (text.match(/<SUMMARY>/i)) problems.push('SUMMARY was empty');
    summary = computerUseRequest ? plain(computerUseRequest) : firstSentence(answer);
  }
  if (summary.length > LIMITS.summaryChars) problems.push('SUMMARY was too long');
  summary = clip(summary, LIMITS.summaryChars);

  const isQuestion = !!computerUseRequest || /\?\s*$/.test(summary);

  const rawActions = bullets(get('NEXT_ACTIONS') ?? '');
  const nextActions = isQuestion
    ? []
    : [...new Set(rawActions.map((a) => clip(a.replace(/["“”]/g, '').replace(/[.!?;:]+$/, ''), LIMITS.nextActionChars)))]
        .filter((a) => a.length >= 3 && !/\b(open|view|show)\b.*\b(file|it|result)\b/i.test(a))
        .slice(0, LIMITS.nextActions);
  if (rawActions.length > LIMITS.nextActions) problems.push('too many NEXT_ACTIONS');

  const rawTitle = plain(get('DONE_TITLE') ?? '').replace(/[.!?]+$/, '');
  const title = titleCase(rawTitle.split(/\s+/).slice(0, LIMITS.titleWords).join(' '));

  const artifacts = [...new Set(bullets(get('ARTIFACTS') ?? ''))].slice(0, LIMITS.artifacts);
  const notes = bullets(get('NOTES') ?? '').slice(0, LIMITS.notes);
  const routine = get('ROUTINE') || null;

  return { answer, summary, nextActions, title, artifacts, notes, routine, computerUseRequest, isQuestion, problems };
}

export interface ArtifactCheck {
  /** Kept, in order. */
  kept: string[];
  /** Dropped, each with the reason. */
  dropped: { item: string; why: string }[];
}

/**
 * Keep only real deliverables: http(s) URLs, or absolute paths that exist now and aren't work
 * files in a tmp folder. The model is asked to check before listing a file; this checks for real.
 */
export function checkArtifacts(items: readonly string[], exists: (path: string) => boolean): ArtifactCheck {
  const kept: string[] = [];
  const dropped: { item: string; why: string }[] = [];
  for (const raw of items) {
    const item = raw.replace(/^["'`<]|["'`>]$/g, '').trim();
    if (/^https?:\/\/\S+$/i.test(item)) {
      kept.push(item);
      continue;
    }
    if (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(item)) {
      dropped.push({ item, why: 'not an absolute path' });
      continue;
    }
    if (/[\\/]tmp[\\/]/i.test(item)) {
      dropped.push({ item, why: 'a work file in tmp' });
      continue;
    }
    if (/^\\\\/.test(item)) {
      dropped.push({ item, why: 'a network path' });
      continue;
    }
    if (!exists(item)) {
      dropped.push({ item, why: "it doesn't exist" });
      continue;
    }
    kept.push(item);
  }
  return { kept, dropped };
}

/** Chips shown when a finished turn offered none. */
export const DEFAULT_NEXT_ACTIONS = ['Summarize this chat', 'Keep going', 'Share the result'];

/** The rules added to an agent's briefing so it writes the tail. */
export const FINAL_MESSAGE_RULES = `## How to finish
End with the answer itself (what you found or did), then these blocks, each on its own lines.
Never mention them in the answer.
<SUMMARY>One plain sentence under 200 characters, result first, no links or paths.</SUMMARY>
<NEXT_ACTIONS>
- Up to four short offers of real work you could do next, under 40 characters, no end punctuation
</NEXT_ACTIONS>
<DONE_TITLE>Two to five words naming the outcome</DONE_TITLE>
Only when this turn made files or online items to open, the absolute paths or links, at most 8,
never work files in tmp and never files you only read. Check each file exists before listing it:
<ARTIFACTS>
- C:\\path\\to\\file.xlsx
</ARTIFACTS>
Only when you learned a durable fact about this job (an account, a preference, a decision), at
most three, never a password, key or code:
<NOTES>
- Default account: work email
</NOTES>
If you need something only the user knows, ask one bundled question as the SUMMARY and skip
NEXT_ACTIONS. Never say something happened unless it did, and never say you saved something in an
app when you wrote a file.`;
