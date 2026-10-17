// Hidden worker window: microphone, screen capture streams, audio playback and the offline voice.
// Main sends requests (id + op) and gets one reply per request; mic frames and playback progress
// are pushed as events.
import type { WorkerApi } from '../../preload/worker';
import type {
  CaptureSource,
  CapturedFrame,
  MicDevice,
  WorkerEvent,
  WorkerReply,
  WorkerRequest,
} from '../../shared/worker-protocol';

declare global {
  interface Window {
    clickyWorker: WorkerApi;
  }
}

const api = window.clickyWorker;

// ---------------------------------------------------------------- links

/**
 * Who a request came from: main (dashboard mic test, mic arming, the in-process engine) or the
 * engine process over its own port. Replies and stream events go back to whoever asked, and mic
 * frames only to whoever is recording, so audio for the voice loop never passes through main.
 */
interface Link {
  reply(r: WorkerReply): void;
  emit(e: WorkerEvent): void;
}

const mainLink: Link = { reply: (r) => api.reply(r), emit: (e) => api.emit(e) };
let engineLink: Link | null = null;
/** Mic owner ('voice' | 'test') → link that started it. */
const ownerLinks = new Map<string, Link>();
/** Playback / voice stream id → link that opened it. */
const streamLinks = new Map<string, Link>();

function emit(e: WorkerEvent): void {
  if (e.type === 'mic.frame') {
    for (const link of new Set(ownerLinks.values())) link.emit(e);
  } else if (e.type === 'mic.level') {
    mainLink.emit(e); // the overlay waveform and the dashboard meter live in main
  } else if (e.type === 'mic.error') {
    for (const link of new Set([mainLink, ...ownerLinks.values()])) link.emit(e);
  } else if (e.type === 'audio.started' || e.type === 'audio.finished' || e.type === 'audio.error') {
    (streamLinks.get(e.streamId) ?? mainLink).emit(e);
    if (e.type !== 'audio.started') streamLinks.delete(e.streamId);
  } else {
    mainLink.emit(e);
  }
}

window.addEventListener('message', (ev: MessageEvent<{ type?: string }>) => {
  if (ev.source !== window || ev.data?.type !== 'clicky-engine-port') return;
  const port = ev.ports[0];
  if (!port) return;
  detachEngine();
  const link: Link = {
    reply: (reply) => port.postMessage({ kind: 'reply', reply }),
    emit: (event) => port.postMessage({ kind: 'event', event }),
  };
  engineLink = link;
  port.onmessage = (m: MessageEvent<{ kind: string; id: number; req: WorkerRequest }>) => {
    if (engineLink === link && m.data.kind === 'request') dispatch(m.data.id, m.data.req, link);
  };
  port.start();
});

/** The engine went away (or was replaced): stop what it was using, so nothing keeps running. */
function detachEngine(): void {
  const old = engineLink;
  engineLink = null;
  if (!old) return;
  for (const [owner, link] of [...ownerLinks]) if (link === old) micStop(owner);
  for (const [id, link] of [...streamLinks]) {
    if (link !== old) continue;
    streamLinks.delete(id);
    audioStop(id);
    voiceStop(id);
  }
}

// ---------------------------------------------------------------- microphone

/** 20 ms of 16 kHz audio per frame. */
const FRAME_SAMPLES = 320;

const WORKLET = `
class ClickyPcm extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(${FRAME_SAMPLES}); this.n = 0; this.sum = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sum += s * s;
      if (this.n === ${FRAME_SAMPLES}) {
        this.port.postMessage({ frame: this.buf, rms: Math.sqrt(this.sum / ${FRAME_SAMPLES}) }, [this.buf.buffer]);
        this.buf = new Int16Array(${FRAME_SAMPLES}); this.n = 0; this.sum = 0;
      }
    }
    return true;
  }
}
registerProcessor('clicky-pcm', ClickyPcm);
`;

let micReady: Promise<AudioContext> | null = null;
let mic: { stream: MediaStream; nodes: AudioNode[]; deviceId: string } | null = null;
let micOpening: Promise<void> | null = null;
/** Frames are forwarded to main only while someone wants them (key held, and/or a mic test). */
const owners = new Set<string>();
let emitting = false;
/** Armed: keep the device open between presses so listening starts instantly. */
let armedDevice: string | null = null;
/** The last ~200 ms before the key went down, so a word started a moment early isn't clipped. */
const PREROLL_FRAMES = 10;
const preroll: Int16Array[] = [];

/** The AudioContext and worklet are created once, so pressing the key only has to open the device. */
function micContext(): Promise<AudioContext> {
  micReady ??= (async () => {
    // Chromium resamples the device to 16 kHz for us.
    const ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    return ctx;
  })();
  return micReady;
}

async function openMic(deviceId: string): Promise<void> {
  if (mic && mic.deviceId === deviceId) return;
  if (micOpening) await micOpening.catch(() => undefined);
  if (mic && mic.deviceId === deviceId) return;
  closeMic();
  micOpening = (async () => {
    const ctx = await micContext();
    const constraints = (id: string): MediaStreamConstraints => ({
      audio: {
        ...(id ? { deviceId: { exact: id } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    } catch (e) {
      // The chosen microphone was unplugged: fall back to the Windows default instead of failing
      // every press until the user changes settings.
      const name = e instanceof DOMException ? e.name : '';
      if (!deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw e;
      stream = await navigator.mediaDevices.getUserMedia(constraints(''));
    }
    try {
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'clicky-pcm');
      // The worklet only runs when connected to the output; a muted gain keeps it silent.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(node).connect(mute).connect(ctx.destination);
      node.port.onmessage = (ev: MessageEvent<{ frame: Int16Array; rms: number }>) => {
        if (!emitting) {
          preroll.push(ev.data.frame);
          if (preroll.length > PREROLL_FRAMES) preroll.shift();
          return;
        }
        emit({ type: 'mic.frame', frame: ev.data.frame });
        emit({ type: 'mic.level', level: Math.min(1, ev.data.rms * 4) });
      };
      const current = { stream, nodes: [source, node, mute] as AudioNode[], deviceId };
      for (const t of stream.getAudioTracks()) {
        t.onended = () => {
          if (mic !== current) return;
          const wasEmitting = emitting;
          closeMic();
          if (wasEmitting) emit({ type: 'mic.error', message: 'The microphone was disconnected.' });
        };
      }
      mic = current;
    } catch (e) {
      // Never leave a device open that nothing references.
      for (const t of stream.getTracks()) t.stop();
      throw e;
    }
  })();
  try {
    await micOpening;
  } finally {
    micOpening = null;
  }
}

function closeMic(): void {
  if (!mic) return;
  for (const n of mic.nodes) n.disconnect();
  for (const t of mic.stream.getTracks()) t.stop();
  mic = null;
  preroll.length = 0;
}

/** Close the device unless someone still wants it: a running capture, or warm mode for this device. */
function reconcileMic(): void {
  if (!mic || emitting) return;
  if (armedDevice === null || mic.deviceId !== armedDevice) closeMic();
}

/** Bumped by every start/stop so a slow device open can tell it has been overtaken. */
let micGen = 0;

async function micStart(deviceId: string, owner: string): Promise<void> {
  const gen = ++micGen;
  const warm = mic !== null && mic.deviceId === deviceId;
  owners.add(owner);
  // Someone is already emitting from an open device: just join.
  if (emitting && mic) return;
  await openMic(deviceId);
  if (gen !== micGen || !owners.has(owner)) {
    // Released (or cancelled) while the device was opening: don't start emitting.
    reconcileMic();
    return;
  }
  emitting = true;
  // Only a warm device has a meaningful pre-roll; flush it first.
  if (warm) for (const f of preroll.splice(0)) emit({ type: 'mic.frame', frame: f });
  preroll.length = 0;
}

function micStop(owner: string): void {
  owners.delete(owner);
  ownerLinks.delete(owner);
  if (owners.size > 0) return; // the other user (voice or test) still needs it
  micGen++;
  emitting = false;
  preroll.length = 0;
  reconcileMic();
}

async function micArm(deviceId: string | null): Promise<void> {
  armedDevice = deviceId;
  if (deviceId !== null && !emitting) await openMic(deviceId);
  reconcileMic();
}

async function micDevices(): Promise<MicDevice[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

// ---------------------------------------------------------------- screen capture

interface LiveCapture {
  stream: MediaStream | null;
  video: HTMLVideoElement;
  ready: Promise<void>;
}

const captures = new Map<string, LiveCapture>();

function openCapture(src: CaptureSource): LiveCapture {
  const existing = captures.get(src.sourceId);
  if (existing) return existing;
  const video = document.createElement('video');
  video.muted = true;
  const live: LiveCapture = { stream: null, video, ready: Promise.resolve() };
  captures.set(src.sourceId, live);
  live.ready = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // Electron's desktop capture constraints (not in the DOM typings).
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: src.sourceId,
          maxWidth: src.width,
          maxHeight: src.height,
          minWidth: src.width,
          minHeight: src.height,
          maxFrameRate: 30,
        },
      } as unknown as MediaTrackConstraints,
    });
    if (captures.get(src.sourceId) !== live) {
      // Stopped (key released or cancelled) while the stream was opening.
      for (const t of stream.getTracks()) t.stop();
      throw new Error('capture stopped');
    }
    live.stream = stream;
    video.srcObject = stream;
    await video.play();
    // Wait for a real decoded frame, not just the stream opening.
    await new Promise<void>((resolve) => {
      // A locked or protected screen may never deliver a new frame; don't wait forever.
      const fallback = setTimeout(resolve, 1500);
      const done = (): void => {
        clearTimeout(fallback);
        resolve();
      };
      if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(done);
      else setTimeout(done, 50);
    });
  })();
  live.ready.catch(() => {
    if (captures.get(src.sourceId) === live) captures.delete(src.sourceId);
  });
  return live;
}

function stopCapture(sourceId: string, live: LiveCapture): void {
  live.stream?.getTracks().forEach((t) => t.stop());
  live.video.srcObject = null;
  if (captures.get(sourceId) === live) captures.delete(sourceId);
}

function captureStop(): void {
  for (const [id, c] of [...captures]) stopCapture(id, c);
}

async function captureTake(sources: CaptureSource[], maxEdge: number, quality: number): Promise<CapturedFrame[]> {
  const used: Array<[string, LiveCapture]> = [];
  try {
    const frames: CapturedFrame[] = [];
    for (const src of sources) {
      const live = openCapture(src);
      used.push([src.sourceId, live]);
      await live.ready;
      const vw = live.video.videoWidth || src.width;
      const vh = live.video.videoHeight || src.height;
      const scale = Math.min(1, maxEdge / Math.max(vw, vh));
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas unavailable');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(live.video, 0, 0, w, h);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      frames.push({ data: new Uint8Array(await blob.arrayBuffer()), width: w, height: h });
    }
    return frames;
  } finally {
    // Capture only lives while the key is held: stop the streams as soon as the frame is taken.
    // Only ours: a newer press may already have opened its own.
    for (const [id, live] of used) stopCapture(id, live);
  }
}

// ---------------------------------------------------------------- audio playback

let playCtx: AudioContext | null = null;
function playbackContext(): AudioContext {
  playCtx ??= new AudioContext({ latencyHint: 'interactive' });
  return playCtx;
}

interface PlayStream {
  sampleRate: number;
  nextTime: number;
  leftover: Uint8Array | null;
  sources: Set<AudioBufferSourceNode>;
  started: boolean;
  finishing: boolean;
  done: boolean;
}

const streams = new Map<string, PlayStream>();

function finishIfDrained(id: string, s: PlayStream): void {
  if (s.finishing && s.sources.size === 0 && !s.done) {
    s.done = true;
    streams.delete(id);
    emit({ type: 'audio.finished', streamId: id });
  }
}

function audioChunk(id: string, data: Uint8Array): void {
  const s = streams.get(id);
  if (!s || s.done) return;
  const ctx = playbackContext();
  let bytes = data;
  if (s.leftover) {
    const merged = new Uint8Array(s.leftover.length + data.length);
    merged.set(s.leftover);
    merged.set(data, s.leftover.length);
    bytes = merged;
    s.leftover = null;
  }
  if (bytes.length % 2) {
    s.leftover = bytes.slice(bytes.length - 1);
    bytes = bytes.subarray(0, bytes.length - 1);
  }
  const n = bytes.length / 2;
  if (n === 0) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const buffer = ctx.createBuffer(1, n, s.sampleRate);
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 0x8000;
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(ctx.destination);
  // A small cushion before the first chunk absorbs network jitter without adding noticeable delay.
  const start = Math.max(ctx.currentTime + (s.started ? 0.005 : 0.04), s.nextTime);
  node.start(start);
  s.nextTime = start + buffer.duration;
  s.sources.add(node);
  node.onended = () => {
    s.sources.delete(node);
    finishIfDrained(id, s);
  };
  if (!s.started) {
    s.started = true;
    const delayMs = Math.max(0, (start - ctx.currentTime) * 1000);
    setTimeout(() => emit({ type: 'audio.started', streamId: id }), delayMs);
  }
}

function audioStop(id: string): void {
  const s = streams.get(id);
  if (!s) return;
  s.done = true;
  streams.delete(id);
  for (const n of s.sources) {
    n.onended = null;
    try {
      n.stop();
    } catch {
      // already stopped
    }
  }
  s.sources.clear();
}

// ---------------------------------------------------------------- offline Windows voice

interface VoiceStream {
  /** Held so Chromium can't garbage-collect an utterance before its end event fires. */
  utterances: Set<SpeechSynthesisUtterance>;
  pending: number;
  started: boolean;
  finishing: boolean;
  done: boolean;
}
const voices = new Map<string, VoiceStream>();

function pickVoice(): SpeechSynthesisVoice | null {
  const all = speechSynthesis.getVoices();
  const en = all.filter((v) => v.lang.toLowerCase().startsWith('en'));
  return (
    en.find((v) => /natural/i.test(v.name)) ??
    en.find((v) => /aria|jenny|guy|zira/i.test(v.name)) ??
    en.find((v) => v.default) ??
    en[0] ??
    all[0] ??
    null
  );
}
speechSynthesis.getVoices(); // starts loading the voice list
// The first utterance pays for starting the speech engine (~1 s); do it now, silently.
{
  const warm = new SpeechSynthesisUtterance(' ');
  warm.volume = 0;
  speechSynthesis.speak(warm);
}

function voiceDone(id: string, v: VoiceStream): void {
  if (v.finishing && v.pending === 0 && !v.done) {
    v.done = true;
    voices.delete(id);
    emit({ type: 'audio.finished', streamId: id });
  }
}

function voiceSay(id: string, text: string): void {
  let v = voices.get(id);
  if (!v) {
    v = { utterances: new Set(), pending: 0, started: false, finishing: false, done: false };
    voices.set(id, v);
  }
  const stream = v;
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.rate = 1.08;
  stream.pending++;
  stream.utterances.add(u);
  u.onstart = () => {
    if (!stream.started && !stream.done) {
      stream.started = true;
      emit({ type: 'audio.started', streamId: id });
    }
  };
  const end = (): void => {
    stream.utterances.delete(u);
    stream.pending--;
    voiceDone(id, stream);
  };
  u.onend = end;
  u.onerror = (e) => {
    if (e.error !== 'interrupted' && e.error !== 'canceled') {
      emit({ type: 'audio.error', streamId: id, message: `Windows voice failed: ${e.error}` });
    }
    end();
  };
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------- request dispatch

async function handle(req: WorkerRequest): Promise<unknown> {
  switch (req.op) {
    case 'mic.start':
      return micStart(req.deviceId, req.owner);
    case 'mic.stop':
      return micStop(req.owner);
    case 'mic.arm':
      return micArm(req.deviceId);
    case 'mic.devices':
      return micDevices();
    case 'capture.begin':
      for (const s of req.sources) openCapture(s).ready.catch(() => undefined);
      return;
    case 'capture.take':
      return captureTake(req.sources, req.maxEdge, req.quality);
    case 'capture.stop':
      return captureStop();
    case 'audio.open':
      audioStop(req.streamId);
      streams.set(req.streamId, {
        sampleRate: req.sampleRate,
        nextTime: 0,
        leftover: null,
        sources: new Set(),
        started: false,
        finishing: false,
        done: false,
      });
      void playbackContext().resume();
      return;
    case 'audio.chunk':
      return audioChunk(req.streamId, req.data);
    case 'audio.finish': {
      const s = streams.get(req.streamId);
      if (s) {
        s.finishing = true;
        finishIfDrained(req.streamId, s);
      } else {
        emit({ type: 'audio.finished', streamId: req.streamId });
      }
      return;
    }
    case 'audio.stop':
      return audioStop(req.streamId);
    case 'voice.say':
      return voiceSay(req.streamId, req.text);
    case 'voice.finish': {
      const v = voices.get(req.streamId);
      if (v) {
        v.finishing = true;
        voiceDone(req.streamId, v);
      } else {
        emit({ type: 'audio.finished', streamId: req.streamId });
      }
      return;
    }
    case 'voice.stop':
      return voiceStop(req.streamId);
    case 'engine.detached':
      return detachEngine();
    case 'cue':
      return playCue(req.kind, req.sound);
  }
}

/**
 * Clicky's own key sounds, synthesised so there's nothing to download or license. Each is two quick
 * notes: rising when you start talking, falling when you let go. Quiet on purpose. A task that needs
 * the user's OK plays the rising pair twice, like the official app's "needs you" sound.
 */
const CUES: Record<
  'soft' | 'bubble' | 'glass',
  { type: OscillatorType; notes: [number, number]; len: number; gain: number }
> = {
  soft: { type: 'sine', notes: [660, 880], len: 0.07, gain: 0.12 },
  bubble: { type: 'sine', notes: [520, 1040], len: 0.05, gain: 0.14 },
  glass: { type: 'triangle', notes: [1320, 1760], len: 0.09, gain: 0.07 },
};

function playCue(kind: 'start' | 'end' | 'ask', sound: 'soft' | 'bubble' | 'glass'): void {
  const c = CUES[sound];
  const ctx = playbackContext();
  void ctx.resume();
  const notes = kind === 'start' ? c.notes : kind === 'ask' ? [...c.notes, 0, ...c.notes] : [c.notes[1], c.notes[0]];
  let t = ctx.currentTime + 0.005;
  for (const f of notes) {
    // 0 is a short rest between the two pairs.
    if (f === 0) {
      t += c.len * 1.5;
      continue;
    }
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = c.type;
    osc.frequency.setValueAtTime(f, t);
    if (sound === 'bubble') osc.frequency.exponentialRampToValueAtTime(f * 1.25, t + c.len);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(c.gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + c.len);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + c.len + 0.02);
    t += c.len * 0.8;
  }
}

function voiceStop(id: string): void {
  const v = voices.get(id);
  if (!v) return;
  v.done = true;
  voices.delete(id);
  speechSynthesis.cancel();
}

function dispatch(id: number, req: WorkerRequest, link: Link): void {
  // Remember who owns what, so frames and stream events go back to them.
  if (req.op === 'mic.start') ownerLinks.set(req.owner, link);
  else if (req.op === 'audio.open' || req.op === 'voice.say') streamLinks.set(req.streamId, link);
  handle(req).then(
    (result) => link.reply({ id, ok: true, result }),
    (e: unknown) => link.reply({ id, ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }),
  );
}

api.onRequest((id, req) => dispatch(id, req, mainLink));

// Warm up the mic pipeline and the audio output so the first press and first answer are fast
// (no microphone device is opened here).
void micContext().catch(() => undefined);
void playbackContext()
  .resume()
  .catch(() => undefined);
