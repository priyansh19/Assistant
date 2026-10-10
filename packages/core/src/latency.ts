/**
 * Per-interaction latency marks and the summary line from plan §3.3.
 * The clock is injected so tests and the benchmark can use their own.
 */

export const LATENCY_MARKS = [
  'keyDown',
  'recordingStarted',
  'captureReady',
  'keyUp',
  'transcriptFinal',
  'firstToken',
  'firstPoint',
  'firstAudio',
  'done',
] as const;

export type LatencyMark = (typeof LATENCY_MARKS)[number];

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
}

export class LatencyRecorder {
  private readonly marks = new Map<LatencyMark, number>();

  constructor(
    readonly interactionId: string,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Record a mark. Only the first occurrence counts (e.g. the first token, not every token). */
  mark(name: LatencyMark, at: number = this.now()): void {
    if (!this.marks.has(name)) this.marks.set(name, at);
  }

  get(name: LatencyMark): number | undefined {
    return this.marks.get(name);
  }

  private span(from: LatencyMark, to: LatencyMark): number | null {
    const a = this.marks.get(from);
    const b = this.marks.get(to);
    return a === undefined || b === undefined ? null : Math.round(b - a);
  }

  summary(): LatencySummary {
    return {
      interactionId: this.interactionId,
      recordingStartMs: this.span('keyDown', 'recordingStarted'),
      transcriptMs: this.span('keyUp', 'transcriptFinal'),
      firstTokenMs: this.span('transcriptFinal', 'firstToken'),
      tokenToAudioMs: this.span('firstToken', 'firstAudio'),
      keyUpToFirstAudioMs: this.span('keyUp', 'firstAudio'),
      keyUpToPointMs: this.span('keyUp', 'firstPoint'),
      totalMs: this.span('keyDown', 'done'),
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
