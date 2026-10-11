import { ConfigError, joinFrames, type SttProvider, type TtsAudioChunk, type TtsProvider } from '@clicky/core';
import { probeSherpaWs, SherpaWsStt, sentenceQueueSession, OPENWHISPR_SHERPA_URL } from '@clicky/providers';
import { voiceFromSetting } from './catalog';
import type { LocalSpeechEngine } from './engine';
import type { ModelFiles } from './files';

/** Is OpenWhispr's local server up? Cached for a few seconds so key-down never waits on it. */
let openWhispr: { ok: boolean; at: number } = { ok: false, at: 0 };
export function openWhisprRunning(): boolean {
  if (Date.now() - openWhispr.at > 10_000) refreshOpenWhispr();
  return openWhispr.ok;
}

export function refreshOpenWhispr(): void {
  void probeSherpaWs(OPENWHISPR_SHERPA_URL).then((ok) => (openWhispr = { ok, at: Date.now() }));
}

/**
 * Speech to text on this PC: a downloaded Moonshine/Parakeet model running in-app (fastest), or
 * OpenWhispr's Parakeet server if no model is downloaded yet. Audio is decoded at key-up.
 */
export function localStt(engine: LocalSpeechEngine, preferred: () => string): SttProvider {
  return {
    id: 'local',
    prewarm: () => {
      refreshOpenWhispr();
      engine.warm(engine.pickStt(preferred()), null);
    },
    async start({ sampleRate, signal }) {
      const model = engine.pickStt(preferred());
      if (!model && !openWhispr.ok) {
        refreshOpenWhispr();
        throw new ConfigError('Download a speech model in Clicky > AI and voice (or start OpenWhispr).');
      }
      if (!model) return new SherpaWsStt().start({ sampleRate, signal });
      const frames: Int16Array[] = [];
      return {
        pushAudio: (f) => void frames.push(f),
        finish: async () => {
          const pcm = joinFrames(frames);
          if (pcm.length < sampleRate * 0.2) return '';
          return engine.transcribe(model, pcm, sampleRate);
        },
        close: () => void (frames.length = 0),
      };
    },
  };
}

/** Piper voice on this PC, synthesised sentence by sentence (the next one while this one plays). */
export function localTts(
  engine: LocalSpeechEngine,
  store: ModelFiles,
  settings: () => { localVoice: string; localVoiceSpeed: number },
): TtsProvider {
  return {
    id: 'local-voice',
    prewarm: async () => engine.warm(null, voiceFromSetting(settings().localVoice)),
    async start({ signal }) {
      const voice = voiceFromSetting(settings().localVoice);
      if (!store.isInstalled(voice)) {
        throw new ConfigError(`Download the ${voice.name} voice in Clicky > AI and voice, or pick the Windows voice.`);
      }
      // Piper's speed is a length scale: larger is slower. Map the user's "speed" to it.
      const speed = settings().localVoiceSpeed;
      return sentenceQueueSession(signal, async function* (text): AsyncGenerator<TtsAudioChunk> {
        const { pcm, sampleRate } = await engine.synthesize(voice, text, speed);
        yield { data: pcm, format: `pcm_${sampleRate}` };
      });
    },
  };
}
