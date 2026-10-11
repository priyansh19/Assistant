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

import { mapPointToDisplay } from '../coordinates.js';
import type { MappedPoint } from '../coordinates.js';
import { classifyFailure, StageError, type Stage } from '../errors.js';
import type { LatencyRecorder } from '../latency.js';
import type { PointTarget } from '../point-parser.js';
import type { ScreenCapture } from '../ports.js';
import { buildSystemPrompt } from '../prompt.js';
import type { ChatTurn, VisionChatProvider, VisionChatRequest } from '../providers.js';
import type { SpeechFactory } from '../speech.js';
import { answerEvents } from './answer-stage.js';
import { withTimeout } from './budget.js';
import { SpeechStage } from './speech-stage.js';

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
  trace: LatencyRecorder;
  hooks: AnswerRunHooks;
}

export interface AnswerRunHooks {
  point(target: MappedPoint, label: string): void;
  caption?(answerSoFar: string): void;
  /** What the model heard, as soon as it says (direct listening only). */
  heard?(question: string): void;
  firstAudio(): void;
  /**
   * The voice failed while the answer was still streaming. The caller should end the
   * interaction now (which aborts `signal`), not after the whole answer arrives.
   */
  speechFailed(e: StageError): void;
  log?(message: string): void;
}

export interface AnswerRunResult {
  /** 'no-speech': the model listened and heard no question. */
  outcome: 'answered' | 'no-speech';
  answer: string;
  /** What the model heard, when it listened to the recording. */
  heard: string | null;
  pointLabel: string | null;
}

/** Run the answer path. Throws a StageError on failure; returns quietly if `signal` aborts. */
export async function runAnswer(input: AnswerRunInput): Promise<AnswerRunResult> {
  const { chat, signal, trace } = input;
  const result: AnswerRunResult = { outcome: 'answered', answer: '', heard: null, pointLabel: null };
  let stage: Stage = 'capture';
  let speech: SpeechStage | null = null;
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
    const system = buildSystemPrompt({
      screens: screens.images.map((img, i) => ({
        index: i + 1,
        imageWidth: img.width,
        imageHeight: img.height,
        hasCursor: i + 1 === screens.cursorScreen,
      })),
      ...(input.userContext ? { userContext: input.userContext } : {}),
      ...(input.audio ? { audioQuestion: true } : {}),
    });

    const output = input.speech.create(signal);
    const voice = new SpeechStage(output, { onFirstSpeech: () => trace.mark('firstSpeech') });
    speech = voice;
    // Cancel must silence the voice at once, whatever the output implementation does with the signal.
    signal.addEventListener('abort', () => voice.stop(), { once: true });
    // A voice failure on the first sentence should surface now, not after the whole answer streams.
    output.done.catch((e: unknown) => {
      if (!signal.aborted) input.hooks.speechFailed(classifyFailure(e, 'speech'));
    });
    output.onFirstAudio(() => {
      if (signal.aborted) return;
      trace.mark('firstAudio');
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
      },
      firstTokenMs: input.timeouts.firstTokenMs,
      answerMs: input.timeouts.answerMs,
      now: input.now,
      onFirstToken: () => trace.mark('firstToken'),
    });
    for await (const ev of events) {
      if (signal.aborted) return result;
      if (ev.type === 'text') {
        result.answer += ev.text;
        input.hooks.caption?.(result.answer);
        speech.push(ev.text);
      } else if (ev.type === 'point') {
        pointAt(ev.tag, screens, result, input);
      } else if (ev.type === 'heard') {
        result.heard = ev.text;
        input.hooks.heard?.(ev.text);
      } else {
        input.hooks.log?.(`invalid POINT tag dropped: ${ev.raw}`);
      }
    }
    speech.end();
    result.answer = result.answer.trim();
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

function pointAt(
  tag: PointTarget | null,
  screens: ScreenCapture,
  result: AnswerRunResult,
  input: AnswerRunInput,
): void {
  if (!tag || result.pointLabel !== null) return; // only the first point is used
  const mapped = mapPointToDisplay(tag, screens.geometry);
  if (!mapped.ok) {
    input.hooks.log?.(`POINT skipped (${mapped.reason}): ${mapped.detail}`);
    return;
  }
  result.pointLabel = tag.label || 'here';
  input.trace.mark('firstPoint');
  input.hooks.point(mapped.point, tag.label);
}
