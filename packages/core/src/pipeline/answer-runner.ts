/**
 * Answer runner: connects the stages that run after the question is known.
 *
 *   screenshot ─┐
 *   question ───┴─► AnswerStage ─► POINT → overlay
 *                               └► text → SpeechStage → audio
 *
 * It owns no interaction state: the orchestrator decides when to run it and maps its result
 * (or the StageError it throws) onto the state machine.
 */

import { fromThousandths, mapPointToDisplay } from '../coordinates.js';
import type { MappedPoint } from '../coordinates.js';
import { classifyFailure, StageError, type Stage } from '../errors.js';
import { mapGuideTag, type GuideTarget } from '../guide.js';
import type { GuideTag, PointTarget } from '../point-parser.js';
import { mapShapeToDisplay, scaleShape, type DrawShape, type MappedShape } from '../shapes.js';
import type { ScreenCapture } from '../ports.js';
import { buildSystemPrompt } from '../prompt.js';
import type { ChatTurn, VisionChatProvider, VisionChatRequest } from '../providers.js';
import type { SpeechFactory } from '../speech.js';
import { answerEvents } from './answer-stage.js';
import { withTimeout } from './budget.js';
import { SpeechStage } from './speech-stage.js';
import type { AnswerTrace } from './speculation.js';
import { SentenceChunker } from '../sentence-chunker.js';

/** Upper bound on playing one answer, so a stuck audio device can't hang the loop. */
export const SPEAKING_TIMEOUT_MS = 120_000;

export interface AnswerRunTimeouts {
  firstTokenMs: number;
  answerMs: number;
}

export interface AnswerRunInput {
  chat: VisionChatProvider;
  speech: SpeechFactory;
  screens: Promise<ScreenCapture>;
  question: string;
  /** The recording, when the model listens instead of reading a transcript. */
  audio?: VisionChatRequest['audio'];
  history: readonly ChatTurn[];
  userContext?: string;
  maxTokens: number;
  timeouts: AnswerRunTimeouts;
  signal: AbortSignal;
  now: () => number;
  trace: AnswerTrace;
  hooks: AnswerRunHooks;
  /** Start speaking at the first clause (SentenceChunker eagerFirst). */
  eagerFirstClause?: boolean;
  /**
   * Speculative run: the request goes out at once, but nothing is spoken or shown until this
   * resolves true. On false the caller aborts `signal` and the run returns quietly.
   */
  confirm?: Promise<boolean>;
  /** The prompt prefix was sent ahead with warmCache: mark it cacheable so this request reads it. */
  cache?: boolean;
  /** Agent mode exists here: the model may hand a request over with [TASK:goal] instead of answering. */
  tasks?: boolean;
  /** A stronger model exists: the model may hand a hard question over with [DEEP] instead of answering. */
  deep?: boolean;
  /** Guided walkthroughs: the model may ring a step with [TARGET] ('offer'), or this is a next step ('follow-up'). */
  guide?: 'offer' | 'follow-up';
}

/**
 * The system prompt for these screenshots. Shared with the cache warm-up, which must send a
 * byte-identical prefix for the real request to hit the cache.
 */
export function answerSystemPrompt(
  screens: ScreenCapture,
  opts: { userContext?: string; audio?: unknown; tasks?: boolean; deep?: boolean; guide?: 'offer' | 'follow-up' },
): string {
  return buildSystemPrompt({
    screens: screens.images.map((img, i) => ({
      index: i + 1,
      imageWidth: img.width,
      imageHeight: img.height,
      hasCursor: i + 1 === screens.cursorScreen,
    })),
    ...(opts.userContext ? { userContext: opts.userContext } : {}),
    ...(opts.audio ? { audioQuestion: true } : {}),
    ...(opts.tasks ? { tasks: true } : {}),
    ...(opts.deep ? { deep: true } : {}),
    ...(opts.guide ? { guide: opts.guide } : {}),
  });
}

export interface AnswerRunHooks {
  point(target: MappedPoint, label: string, opts?: { snap?: boolean }): void;
  /** Draw an arrow, box or circle on the screen (optional UI). */
  draw?(shape: MappedShape): void;
  caption?(answerSoFar: string): void;
  /** What the model heard, as soon as it says (direct listening only). */
  heard?(question: string): void;
  /** A walkthrough step was rung ([TARGET]/[HOVER]): arm it now, so a click during the speech counts. */
  target?(target: GuideTarget): void;
  firstAudio(): void;
  /**
   * The voice failed while the answer was still streaming. The caller should end the
   * interaction now (which aborts `signal`), not after the whole answer arrives.
   */
  speechFailed(e: StageError): void;
  log?(message: string): void;
}

export interface AnswerRunResult {
  /**
   * 'no-speech': the model listened and heard no question. 'task': the model handed the request to
   * agent mode ([TASK:goal]); nothing was spoken and `task` holds the goal.
   */
  outcome: 'answered' | 'no-speech' | 'task' | 'deep';
  answer: string;
  /** What the model heard, when it listened to the recording. */
  heard: string | null;
  pointLabel: string | null;
  /** The goal from a [TASK:goal] tag. */
  task?: string;
  /** A walkthrough step the answer rang ([TARGET] or [HOVER]), with the words spoken for it. */
  target?: GuideTarget;
}

/** Run the answer path. Throws a StageError on failure; returns quietly if `signal` aborts. */
export async function runAnswer(input: AnswerRunInput): Promise<AnswerRunResult> {
  const { chat, signal, trace } = input;
  const result: AnswerRunResult = { outcome: 'answered', answer: '', heard: null, pointLabel: null };
  let stage: Stage = 'capture';
  let speech: SpeechStage | null = null;
  const drawn = { count: 0 };
  /** Whether the model sent any POINT tag, for the log (no movement is usually a missing tag). */
  let sawTag = false;
  try {
    const screens = await input.screens;
    trace.mark('captureReady');
    if (signal.aborted) return result;
    trace.setMeta(
      'imageBytes',
      screens.images.reduce((n, img) => n + img.data.byteLength, 0),
    );
    const firstImage = screens.images[0];
    if (firstImage) trace.setMeta('imageEdge', Math.max(firstImage.width, firstImage.height));

    stage = 'answer';
    const system = answerSystemPrompt(screens, input);

    const output = input.speech.create(signal);
    const voice = new SpeechStage(
      output,
      { onFirstSpeech: () => trace.mark('firstSpeech') },
      new SentenceChunker({ eagerFirst: input.eagerFirstClause ?? false }),
    );
    speech = voice;
    // Cancel must silence the voice at once, whatever the output implementation does with the signal.
    signal.addEventListener('abort', () => voice.stop(), { once: true });
    // A voice failure on the first sentence should surface now, not after the whole answer streams.
    output.done.catch((e: unknown) => {
      if (!signal.aborted) input.hooks.speechFailed(classifyFailure(e, 'speech'));
    });
    output.onSwitch?.((reason) => {
      trace.setMeta('voiceFallback', true);
      trace.event('speech', 'backup-voice', { reason });
      input.hooks.log?.(`switched to the backup voice: ${reason}`);
    });
    output.onFirstAudio(() => {
      if (signal.aborted) return;
      trace.mark('firstAudio');
      trace.mark('firstSound');
      input.hooks.firstAudio();
    });

    trace.mark('requestSent');
    const events = answerEvents({
      chat,
      request: {
        system,
        history: input.history,
        question: input.audio ? 'Answer the question in the audio.' : input.question,
        images: screens.images,
        ...(input.audio ? { audio: input.audio } : {}),
        maxTokens: input.maxTokens,
        signal,
        ...(input.cache ? { cache: true } : {}),
      },
      firstTokenMs: input.timeouts.firstTokenMs,
      answerMs: input.timeouts.answerMs,
      now: input.now,
      onFirstToken: () => trace.mark('firstToken'),
    });
    const iterator = events[Symbol.asyncIterator]();
    // The request goes out on the first pull; a speculative run then waits for the verdict while
    // the answer streams in behind it.
    let next = iterator.next();
    if (input.confirm) {
      next.catch(() => undefined);
      const confirmed = await input.confirm;
      if (!confirmed || signal.aborted) {
        void iterator.return(undefined).catch(() => undefined);
        return result;
      }
    }
    for (let r = await next; !r.done; r = await (next = iterator.next())) {
      const ev = r.value;
      if (signal.aborted) return result;
      if (ev.type === 'text') {
        result.answer += ev.text;
        input.hooks.caption?.(result.answer);
        speech.push(ev.text);
      } else if (ev.type === 'point') {
        sawTag = true;
        if (!ev.tag) input.hooks.log?.('POINT none: the model chose not to point');
        pointAt(ev.tag, screens, result, input);
      } else if (ev.type === 'draw') {
        drawShape(ev.shape, screens, drawn, input);
      } else if (ev.type === 'task') {
        // Something to do, not to answer: stop here (the tag comes first, so nothing was said)
        // and let the caller run it. Ending the iterator also cancels the model stream.
        input.hooks.log?.(`TASK from the answer model: ${ev.goal}`);
        voice.stop();
        void iterator.return(undefined).catch(() => undefined);
        return { ...result, outcome: 'task', task: ev.goal };
      } else if (ev.type === 'deep') {
        // Only before anything was said: once the answer is playing, it is finished as it started.
        if (input.deep && !result.answer.trim() && !result.target) {
          input.hooks.log?.('DEEP from the answer model: handing the question to the stronger model');
          voice.stop();
          void iterator.return(undefined).catch(() => undefined);
          return { ...result, outcome: 'deep' };
        }
        input.hooks.log?.('DEEP ignored (no stronger model, or the answer had started)');
      } else if (ev.type === 'target') {
        sawTag = true;
        guideAt(ev.target, screens, result, input);
      } else if (ev.type === 'heard') {
        result.heard = ev.text;
        input.hooks.heard?.(ev.text);
      } else {
        input.hooks.log?.(`invalid POINT tag dropped: ${ev.raw}`);
      }
    }
    speech.end();
    if (!sawTag)
      input.hooks.log?.(
        `POINT missing: the reply had no tag (starts "${result.answer.slice(0, 80).replace(/\s+/g, ' ')}")`,
      );
    result.answer = result.answer.trim();
    // The same object the caller armed: it learns what was said for the step.
    if (result.target) result.target.instruction = result.answer.slice(0, 300);
    if (!result.answer) {
      if (input.audio && !result.heard) {
        // The model heard no speech in the recording.
        speech.stop();
        return { ...result, outcome: 'no-speech' };
      }
      throw new StageError('answer', 'bad-output', 'the answer was empty', { provider: chat.id });
    }
    stage = 'speech';
    await withTimeout(speech.done, SPEAKING_TIMEOUT_MS, 'speech', 'playing the answer', signal);
    return result;
  } catch (e) {
    speech?.stop();
    if (signal.aborted) return result;
    throw classifyFailure(e, stage);
  }
}

/** Drawing coordinates arrive in thousandths of the screenshot, like POINT. */
function shapeFromThousandths(s: DrawShape, screens: ScreenCapture): DrawShape {
  const cap = screens.geometry[(s.screen ?? 1) - 1];
  if (!cap) return s;
  return scaleShape(s, cap.imageWidth / 1000, cap.imageHeight / 1000);
}

/**
 * At most this many drawings per answer: enough for a sketch the user asked for (a face, a house,
 * a few notes), not enough for a confused model to cover the screen. The prompt asks for at most
 * three when a drawing only helps explain an answer.
 */
export const MAX_DRAWINGS = 20;

function drawShape(shape: DrawShape, screens: ScreenCapture, drawn: { count: number }, input: AnswerRunInput): void {
  if (drawn.count >= MAX_DRAWINGS || !input.hooks.draw) return;
  const mapped = mapShapeToDisplay(shapeFromThousandths(shape, screens), screens.geometry);
  if (!mapped.ok) {
    input.hooks.log?.(`${shape.kind} drawing skipped: ${mapped.detail}`);
    return;
  }
  drawn.count++;
  input.hooks.draw(mapped.shape);
}

/**
 * A walkthrough step: the cursor flies to it like a POINT, and the target goes back to the caller,
 * which rings it and waits for the user's click once the step has been spoken. Without walkthroughs
 * (or for a second target in one answer) it is only a point.
 */
function guideAt(tag: GuideTag, screens: ScreenCapture, result: AnswerRunResult, input: AnswerRunInput): void {
  const mapped = mapGuideTag(tag, screens.geometry);
  if (!mapped.ok) {
    input.hooks.log?.(`TARGET skipped: ${mapped.detail}`);
    return;
  }
  const t = mapped.target;
  if (input.guide && !result.target) {
    result.target = { ...t, instruction: '' };
    input.hooks.target?.(result.target);
    input.hooks.log?.(
      `TARGET ${tag.kind} ${tag.x},${tag.y} r=${tag.r ?? 'default'}${tag.screen ? ` screen${tag.screen}` : ''} "${t.label}" → display ${t.at.displayId} at ${Math.round(t.at.local.x)},${Math.round(t.at.local.y)} radius ${Math.round(t.radius)}`,
    );
  }
  if (result.pointLabel !== null) return;
  result.pointLabel = t.label;
  input.trace.mark('firstPoint');
  input.hooks.point(t.at, t.label, { snap: true });
}

function pointAt(
  tag: PointTarget | null,
  screens: ScreenCapture,
  result: AnswerRunResult,
  input: AnswerRunInput,
): void {
  if (!tag || result.pointLabel !== null) return; // only the first point is used
  const mapped = mapPointToDisplay(fromThousandths(tag, screens.geometry), screens.geometry);
  if (!mapped.ok) {
    input.hooks.log?.(`POINT skipped (${mapped.reason}): ${mapped.detail}`);
    return;
  }
  result.pointLabel = tag.label || 'here';
  input.hooks.log?.(
    `POINT ${tag.x},${tag.y}${tag.screen ? ` screen${tag.screen}` : ''} "${tag.label}" → display ${mapped.point.displayId} at ${Math.round(mapped.point.local.x)},${Math.round(mapped.point.local.y)}`,
  );
  input.trace.mark('firstPoint');
  input.hooks.point(mapped.point, tag.label, { snap: true });
}
