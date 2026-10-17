/**
 * Answer stage: one streaming vision-chat request turned into typed events. It owns the
 * time-to-first-token and whole-answer budgets, strips a leading [HEARD:...] tag when the model
 * listened to the audio itself, and splits POINT tags from speakable text.
 */

import { HeardTagFilter } from '../audio.js';
import { PointStreamParser, type GuideTag, type ParserEvent, type PointTarget } from '../point-parser.js';
import type { VisionChatProvider, VisionChatRequest } from '../providers.js';
import type { DrawShape } from '../shapes.js';
import { withTimeout } from './budget.js';

export type AnswerEvent =
  | { type: 'text'; text: string }
  /** `tag` is null for [POINT:none]. */
  | { type: 'point'; tag: PointTarget | null }
  | { type: 'draw'; shape: DrawShape }
  /** The model says this is a task for agent mode, not a question ([TASK:goal]). */
  | { type: 'task'; goal: string }
  /** A guided-walkthrough step to arm ([TARGET:…] or [HOVER:…]). */
  | { type: 'target'; target: GuideTag }
  /** The fast model handed the question to the stronger model ([DEEP]). */
  | { type: 'deep' }
  /** Something that looked like a tag but didn't parse; dropped, never spoken. */
  | { type: 'invalid-tag'; raw: string }
  /** What the model heard, when it listened to the recording itself. */
  | { type: 'heard'; text: string };

export interface AnswerStageOptions {
  chat: VisionChatProvider;
  request: VisionChatRequest;
  /** Request sent → first token. */
  firstTokenMs: number;
  /** Request sent → last token. */
  answerMs: number;
  now: () => number;
  /** Called once, when the first token arrives. */
  onFirstToken?(): void;
}

function* fromParser(events: ParserEvent[]): Generator<AnswerEvent> {
  for (const ev of events) {
    if (ev.type === 'text') yield ev;
    else if (ev.type === 'point') yield { type: 'point', tag: ev.tag.kind === 'point' ? ev.tag : null };
    else if (ev.type === 'draw' || ev.type === 'task' || ev.type === 'target' || ev.type === 'deep') yield ev;
    else yield { type: 'invalid-tag', raw: ev.raw };
  }
}

/** Stream the answer as events. Throws on provider failure, timeout or abort. */
export async function* answerEvents(opts: AnswerStageOptions): AsyncGenerator<AnswerEvent> {
  const { chat, request } = opts;
  const parser = new PointStreamParser();
  const heard = request.audio ? new HeardTagFilter() : null;
  let heardReported = false;
  function* reportHeard(): Generator<AnswerEvent> {
    if (heard?.heard && !heardReported) {
      heardReported = true;
      yield { type: 'heard', text: heard.heard };
    }
  }

  const iterator = chat.stream(request)[Symbol.asyncIterator]();
  const deadline = opts.now() + opts.answerMs;
  let first = true;
  try {
    for (;;) {
      const remaining = first ? opts.firstTokenMs : Math.max(1, deadline - opts.now());
      const next = await withTimeout(iterator.next(), remaining, 'answer', 'the AI answer', request.signal);
      if (next.done) break;
      if (first) {
        first = false;
        opts.onFirstToken?.();
      }
      if (!heard) {
        yield* fromParser(parser.push(next.value));
        continue;
      }
      const out = heard.push(next.value);
      yield* reportHeard();
      if (out) yield* fromParser(parser.push(out));
    }
    if (heard) {
      const rest = heard.end();
      yield* reportHeard();
      if (rest) yield* fromParser(parser.push(rest));
    }
    yield* fromParser(parser.end());
  } finally {
    // Stop the provider stream if the consumer gave up early (cancel, speculation discarded).
    void iterator.return?.().catch(() => undefined);
  }
}
