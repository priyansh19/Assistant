/**
 * Per-interaction trace (architecture §8.3): timestamped marks for the plan §3.3 latency line,
 * plus a small event log with metadata (provider ids, byte counts, failure kinds). Never content:
 * no transcript text, audio or image data goes in here.
 * The clock is injected so tests and the benchmark can use their own.
 */

import type { FailureKind, Stage } from './errors.js';

export const LATENCY_MARKS = [
  'keyDown',
  'recordingStarted',
  /** The STT connection is open and audio is flowing to it. */
  'sttReady',
  'captureReady',
  'keyUp',
  'transcriptFinal',
  /** The answer request went out (speculative or final). */
  'requestSent',
  'firstToken',
  'firstPoint',
  /** The first speakable chunk went to the voice. */
  'firstSpeech',
  'firstAudio',
  'done',
] as const;

export type LatencyMark = (typeof LATENCY_MARKS)[number];

/** One entry in the trace. `data` holds small metadata only (ids, sizes, kinds). */
export interface TraceEvent {
  /** Milliseconds since key-down. */
  t: number;
  stage: Stage;
  name: string;
  data?: Record<string, string | number | boolean>;
}

export interface LatencySummary {
  interactionId: string;
  /** key-down → recording start */
  recordingStartMs: number | null;
  /** key-up → final transcript */
  transcriptMs: number | null;
  /** final transcript → first LLM token */
  firstTokenMs: number | null;
  /** first token → first audio */
  tokenToAudioMs: number | null;
  /** key-up → first audio: the headline metric */
  keyUpToFirstAudioMs: number | null;
  /** key-up → dot starts moving */
  keyUpToPointMs: number | null;
  /** key-down → done */
  totalMs: number | null;
  /** key-down → STT connection ready */
  sttConnectMs?: number | null;
  /** key-up → answer request sent (negative is impossible; 0 when it went out at key-up) */
  keyUpToRequestMs?: number | null;
  /** answer request sent → first token: the model's own time to first token */
  modelFirstTokenMs?: number | null;
  /** first token → first speakable chunk handed to the voice */
  tokenToSpeechMs?: number | null;
  /** first speakable chunk → first audio playing: the voice's time to first byte plus playback */
  speechToAudioMs?: number | null;
  /** How the interaction ended, when it didn't end in an answer. */
  failure?: { stage: Stage; kind: FailureKind; provider?: string };
  /** Which providers and settings were in play (ids only). */
  meta?: Record<string, string | number | boolean>;
}

/** The metrics shown per stage in the dashboard and printed by `pnpm bench`. */
export const STAGE_METRICS = [
  'keyUpToFirstAudioMs',
  'transcriptMs',
  'keyUpToRequestMs',
  'modelFirstTokenMs',
  'tokenToSpeechMs',
  'speechToAudioMs',
  'keyUpToPointMs',
  'recordingStartMs',
] as const satisfies ReadonlyArray<keyof LatencySummary>;

export type StageMetric = (typeof STAGE_METRICS)[number];

export class LatencyRecorder {
  private readonly marks = new Map<LatencyMark, number>();
  private readonly log: TraceEvent[] = [];
  private readonly meta: Record<string, string | number | boolean> = {};
  private failure: LatencySummary['failure'];
  private readonly origin: number;

  constructor(
    readonly interactionId: string,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.origin = now();
  }

  /** Record a mark. Only the first occurrence counts (e.g. the first token, not every token). */
  mark(name: LatencyMark, at: number = this.now()): void {
    if (!this.marks.has(name)) this.marks.set(name, at);
  }

  get(name: LatencyMark): number | undefined {
    return this.marks.get(name);
  }

  /** Append an event to the trace. Keep `data` to ids and sizes. */
  event(stage: Stage, name: string, data?: TraceEvent['data']): void {
    // Bounded: a runaway stream must not grow the trace without limit.
    if (this.log.length >= 200) return;
    this.log.push({ t: Math.round(this.now() - this.origin), stage, name, ...(data ? { data } : {}) });
  }

  /** Attach metadata (provider ids, model, image size) to the summary. */
  setMeta(key: string, value: string | number | boolean): void {
    this.meta[key] = value;
  }

  setFailure(failure: NonNullable<LatencySummary['failure']>): void {
    this.failure ??= failure;
  }

  events(): readonly TraceEvent[] {
    return this.log;
  }

  private span(from: LatencyMark, to: LatencyMark): number | null {
    const a = this.marks.get(from);
    const b = this.marks.get(to);
    return a === undefined || b === undefined ? null : Math.round(b - a);
  }

  summary(): LatencySummary {
    // A request sent before key-up (speculation) counts as 0 ms after key-up.
    const keyUpToRequest = this.span('keyUp', 'requestSent');
    // Likewise a first token that arrived before the final transcript (speculation hit).
    const firstToken = this.span('transcriptFinal', 'firstToken');
    return {
      interactionId: this.interactionId,
      recordingStartMs: this.span('keyDown', 'recordingStarted'),
      transcriptMs: this.span('keyUp', 'transcriptFinal'),
      firstTokenMs: firstToken === null ? null : Math.max(0, firstToken),
      tokenToAudioMs: this.span('firstToken', 'firstAudio'),
      keyUpToFirstAudioMs: this.span('keyUp', 'firstAudio'),
      keyUpToPointMs: this.span('keyUp', 'firstPoint'),
      totalMs: this.span('keyDown', 'done'),
      sttConnectMs: this.span('keyDown', 'sttReady'),
      keyUpToRequestMs: keyUpToRequest === null ? null : Math.max(0, keyUpToRequest),
      modelFirstTokenMs: this.span('requestSent', 'firstToken'),
      tokenToSpeechMs: this.span('firstToken', 'firstSpeech'),
      speechToAudioMs: this.span('firstSpeech', 'firstAudio'),
      ...(this.failure ? { failure: this.failure } : {}),
      ...(Object.keys(this.meta).length ? { meta: { ...this.meta } } : {}),
    };
  }
}

/** p-th percentile (0–100) using nearest-rank; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

export interface StageStat {
  n: number;
  p50: number | null;
  p95: number | null;
}

/** p50/p95 per stage metric over a set of interactions (missing values are skipped). */
export function stageStats(rows: readonly Partial<LatencySummary>[]): Record<StageMetric, StageStat> {
  const out = {} as Record<StageMetric, StageStat>;
  for (const m of STAGE_METRICS) {
    const values = rows.map((r) => r[m]).filter((v): v is number => typeof v === 'number');
    out[m] = { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
  }
  return out;
}
