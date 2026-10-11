/**
 * On-device speech models Clicky can download and run (sherpa-onnx). Archives come from the
 * official k2-fsa/sherpa-onnx GitHub releases and are verified against pinned SHA-256 digests.
 *
 * Measured on the owner's laptop (Core Ultra 7 155H, CPU only, 2026-10-11):
 * - Moonshine Tiny (int8): 2.9 s of speech → text in 55–69 ms, word-perfect.
 * - Piper medium (fp32): a full sentence in 130–180 ms. The int8 Piper builds were ~5× slower on
 *   this CPU and Kokoro int8 took ~5 s per sentence, so neither is offered.
 */

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

export interface SttModelSpec {
  kind: 'stt';
  id: 'moonshine-tiny' | 'parakeet-v3';
  name: string;
  desc: string;
  url: string;
  sha256: string;
  sizeMb: number;
  /** Folder inside the archive. */
  dir: string;
}

export interface VoiceSpec {
  kind: 'voice';
  /** The part after "piper:" in Settings.localVoice. */
  id: string;
  name: string;
  desc: string;
  url: string;
  sha256: string;
  sizeMb: number;
  dir: string;
}

export type ModelSpec = SttModelSpec | VoiceSpec;

export const STT_MODELS: SttModelSpec[] = [
  {
    kind: 'stt',
    id: 'moonshine-tiny',
    name: 'Moonshine Tiny',
    desc: 'English. Fastest: about 60 ms per question on this laptop.',
    url: `${RELEASES}/asr-models/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2`,
    sha256: 'd5fe6ec4334fef36255b2a4010412cad4c007e33103fec62fb5d17cad88086f2',
    sizeMb: 108,
    dir: 'sherpa-onnx-moonshine-tiny-en-int8',
  },
  {
    kind: 'stt',
    id: 'parakeet-v3',
    name: 'Parakeet v3',
    desc: 'Best accuracy, 25 languages. Larger and slower (same model OpenWhispr uses).',
    url: `${RELEASES}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
    sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
    sizeMb: 487,
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  },
];

function piper(id: string, name: string, desc: string, sha256: string, sizeMb = 67): VoiceSpec {
  const file = `vits-piper-${id}-medium`;
  return { kind: 'voice', id, name, desc, url: `${RELEASES}/tts-models/${file}.tar.bz2`, sha256, sizeMb, dir: file };
}

export const VOICES: VoiceSpec[] = [
  piper(
    'en_US-lessac',
    'Lessac',
    'US English, female, clear',
    '9e3febfacf0abf4270172d2958bcec246032b7e88efc2720840cc80c93de334e',
  ),
  piper(
    'en_US-amy',
    'Amy',
    'US English, female, warm',
    '9a5d1fc497f85e8022b785bff5f8105203b1e33099ee6265203efc70b0cb0264',
  ),
  piper('en_US-ryan', 'Ryan', 'US English, male', 'c546af78b6395b4e7c4ce1ed899438b64426a362f5d4ec5fecd090ded9ad7505'),
  piper(
    'en_US-joe',
    'Joe',
    'US English, male, relaxed',
    '261b903a1fb2ce621e2b5b14233cd41223c3b9f9590f896c11daee4df22d9bd3',
  ),
  piper(
    'en_GB-alan',
    'Alan',
    'British English, male',
    'a48d4017da0f77668b27bed63fe6e04dd64c6397e1fadad4f460efb0ef7c9012',
  ),
  piper(
    'en_GB-jenny_dioco',
    'Jenny',
    'British English, female',
    'a0888024569bafbefc05a4b48ddf8419d8dbbf3205f4af37cf7c6f1a87cc20c5',
  ),
];

export const DEFAULT_VOICE_ID = 'en_US-lessac';

export function voiceFromSetting(localVoice: string): VoiceSpec {
  const id = localVoice.startsWith('piper:') ? localVoice.slice('piper:'.length) : '';
  return VOICES.find((v) => v.id === id) ?? (VOICES.find((v) => v.id === DEFAULT_VOICE_ID) as VoiceSpec);
}

export function findModel(id: string): ModelSpec | undefined {
  return [...STT_MODELS, ...VOICES].find((m) => m.id === id);
}
