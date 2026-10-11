import { join } from 'node:path';
import { log } from '../log';
import { STT_MODELS, type SttModelSpec, type VoiceSpec } from './catalog';
import type { ModelStore } from './store';

// sherpa-onnx-node is plain JS (N-API addon). Only the parts Clicky uses are typed here.
interface SherpaStream {
  acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void;
}
interface SherpaRecognizer {
  createStream(): SherpaStream;
  decodeAsync(s: SherpaStream): Promise<void>;
  getResult(s: SherpaStream): { text: string };
}
interface SherpaTts {
  sampleRate: number;
  generateAsync(r: {
    text: string;
    sid: number;
    speed: number;
    enableExternalBuffer?: boolean;
  }): Promise<{ samples: Float32Array; sampleRate: number }>;
}
interface SherpaModule {
  OfflineRecognizer: { createAsync(config: unknown): Promise<SherpaRecognizer> };
  OfflineTts: { createAsync(config: unknown): Promise<SherpaTts> };
}

let sherpa: SherpaModule | null = null;
function load(): SherpaModule {
  // Loaded lazily so a missing/broken native addon only affects the local speech options.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy load of a native addon
  sherpa ??= require('sherpa-onnx-node') as SherpaModule;
  return sherpa;
}

const THREADS = 4;

/**
 * Loads local models on first use and keeps them warm. All sherpa calls are async (they run on the
 * addon's own threads), so nothing here blocks the main process.
 */
export class LocalSpeechEngine {
  private recognizer: { id: string; r: Promise<SherpaRecognizer> } | null = null;
  private tts: { id: string; t: Promise<SherpaTts> } | null = null;

  constructor(private readonly store: ModelStore) {}

  /** The installed STT model to use: the preferred one if installed, else any installed one. */
  pickStt(preferred: string): SttModelSpec | null {
    const order = [STT_MODELS.find((m) => m.id === preferred), ...STT_MODELS].filter(Boolean) as SttModelSpec[];
    return order.find((m) => this.store.isInstalled(m)) ?? null;
  }

  private recognizerFor(spec: SttModelSpec): Promise<SherpaRecognizer> {
    if (this.recognizer?.id === spec.id) return this.recognizer.r;
    const d = this.store.dirOf(spec);
    const modelConfig =
      spec.id === 'moonshine-tiny'
        ? {
            moonshine: {
              preprocessor: join(d, 'preprocess.onnx'),
              encoder: join(d, 'encode.int8.onnx'),
              uncachedDecoder: join(d, 'uncached_decode.int8.onnx'),
              cachedDecoder: join(d, 'cached_decode.int8.onnx'),
            },
          }
        : {
            transducer: {
              encoder: join(d, 'encoder.int8.onnx'),
              decoder: join(d, 'decoder.int8.onnx'),
              joiner: join(d, 'joiner.int8.onnx'),
            },
            modelType: 'nemo_transducer',
          };
    const r = load().OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { ...modelConfig, tokens: join(d, 'tokens.txt'), numThreads: THREADS },
    });
    r.catch(() => {
      if (this.recognizer?.r === r) this.recognizer = null;
    });
    this.recognizer = { id: spec.id, r };
    return r;
  }

  async transcribe(spec: SttModelSpec, pcm: Int16Array, sampleRate: number): Promise<string> {
    const rec = await this.recognizerFor(spec);
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 32768;
    const s = rec.createStream();
    s.acceptWaveform({ samples, sampleRate });
    await rec.decodeAsync(s);
    return rec.getResult(s).text.trim();
  }

  private ttsFor(voice: VoiceSpec): Promise<SherpaTts> {
    if (this.tts?.id === voice.id) return this.tts.t;
    const d = this.store.dirOf(voice);
    const t = load().OfflineTts.createAsync({
      model: {
        vits: {
          model: join(d, `${voice.id}-medium.onnx`),
          tokens: join(d, 'tokens.txt'),
          dataDir: join(d, 'espeak-ng-data'),
        },
        numThreads: THREADS,
      },
      maxNumSentences: 1,
    });
    t.catch(() => {
      if (this.tts?.t === t) this.tts = null;
    });
    this.tts = { id: voice.id, t };
    return t;
  }

  /** One generation at a time per engine, so sentences come out in order. */
  private ttsQueue: Promise<unknown> = Promise.resolve();

  async synthesize(voice: VoiceSpec, text: string, speed: number): Promise<{ pcm: Uint8Array; sampleRate: number }> {
    const tts = await this.ttsFor(voice);
    const run = this.ttsQueue.then(() =>
      // Electron forbids external ArrayBuffers; without this flag the addon fails with
      // "TTS settlement failed" (works in plain Node, which is why the benchmarks passed).
      tts.generateAsync({ text, sid: 0, speed, enableExternalBuffer: false }),
    );
    this.ttsQueue = run.catch(() => undefined);
    const a = await run;
    const out = new Uint8Array(a.samples.length * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < a.samples.length; i++) {
      const v = Math.max(-1, Math.min(1, a.samples[i] ?? 0));
      view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return { pcm: out, sampleRate: a.sampleRate };
  }

  private readonly warmed: { stt: string | null; voice: string | null } = { stt: null, voice: null };

  /** Load models in the background so the first question doesn't pay for it. */
  warm(stt: SttModelSpec | null, voice: VoiceSpec | null): void {
    try {
      // The first inference after loading is ~20x slower than the rest (ONNX graph warm-up), so run a
      // throwaway one here instead of on the user's first question.
      if (stt && this.warmed.stt !== stt.id) {
        this.warmed.stt = stt.id;
        void this.transcribe(stt, new Int16Array(8000), 16000).catch((e: unknown) => {
          this.warmed.stt = null;
          log.warn('local STT failed to load', String(e));
        });
      }
      if (voice && this.store.isInstalled(voice) && this.warmed.voice !== voice.id) {
        this.warmed.voice = voice.id;
        void this.synthesize(voice, 'Hi.', 1).catch((e: unknown) => {
          this.warmed.voice = null;
          log.warn('local voice failed to load', String(e));
        });
      }
    } catch (e) {
      log.warn('local speech engine unavailable', String(e));
    }
  }
}
