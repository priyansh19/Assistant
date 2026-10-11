/**
 * Provider interfaces (blueprint §9, AGENTS.md rule 3). Implementations live in
 * @clicky/providers; the orchestrator only sees these types. Every call takes an
 * AbortSignal tied to the interaction, and every stream is incremental: nothing waits
 * for a complete response (plan §3.3).
 */

export interface ImageInput {
  /** Encoded image bytes (JPEG by default). Held in memory only. */
  data: Uint8Array;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface VisionChatRequest {
  system: string;
  /** Earlier turns, oldest first. Empty for a one-shot question. */
  history: readonly ChatTurn[];
  question: string;
  /** Screenshots in screen order: images[0] is screen1. */
  images: readonly ImageInput[];
  /** The spoken question as audio, when the model listens directly instead of a transcript. */
  audio?: { data: Uint8Array; format: 'wav' };
  maxTokens: number;
  signal: AbortSignal;
}

export interface VisionChatProvider {
  readonly id: string;
  /** Open connections early (TLS, HTTP/2) so the real request starts warm. Safe to call often. */
  prewarm?(signal: AbortSignal): Promise<void>;
  /** Stream text deltas as they arrive. Throws (or rejects the iterator) on failure or abort. */
  stream(request: VisionChatRequest): AsyncIterable<string>;
}

export interface SttSession {
  /** 16 kHz mono PCM16 frames. */
  pushAudio(frame: Int16Array): void;
  /** Key released: finalise now instead of waiting for silence detection. Resolves with the final transcript. */
  finish(): Promise<string>;
  /** Interim transcripts, for display only. */
  onPartial?(fn: (text: string) => void): void;
  close(): void;
}

export interface SttProvider {
  readonly id: string;
  /** Called at key-down so the connection is open before the user stops talking. */
  start(options: { sampleRate: 16000; signal: AbortSignal }): Promise<SttSession>;
  /** Optional: get ready for the next start (e.g. fetch a session token) while idle. */
  prewarm?(): void;
}

export interface TtsAudioChunk {
  data: Uint8Array;
  /** e.g. 'pcm_16000', 'pcm_24000' or 'mp3_44100'. */
  format: string;
}

export interface TtsSession {
  /** Feed the next sentence chunk as soon as it's ready. */
  pushText(text: string): void;
  /** No more text is coming. */
  end(): void;
  /** Audio as it arrives; the first chunk is "first audio". */
  audio(): AsyncIterable<TtsAudioChunk>;
  close(): void;
}

export interface TtsProvider {
  readonly id: string;
  prewarm?(signal: AbortSignal): Promise<void>;
  start(options: { signal: AbortSignal }): Promise<TtsSession>;
}
