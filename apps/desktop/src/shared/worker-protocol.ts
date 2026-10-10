// Messages between the main process and the hidden worker window, which owns everything that
// needs Chromium's media stack: the microphone, screen capture streams and audio playback.

export interface CaptureSource {
  sourceId: string;
  /** Physical pixel size of the display, so the stream is captured at native resolution. */
  width: number;
  height: number;
}

export interface CapturedFrame {
  data: Uint8Array;
  width: number;
  height: number;
}

export type WorkerRequest =
  /** `owner` lets the voice loop and the dashboard mic test use the mic at the same time. */
  | { op: 'mic.start'; deviceId: string; owner: 'voice' | 'test' }
  | { op: 'mic.stop'; owner: 'voice' | 'test' }
  /** Keep the device open between presses (deviceId '' = default), or close it (null). */
  | { op: 'mic.arm'; deviceId: string | null }
  | { op: 'mic.devices' }
  | { op: 'capture.begin'; sources: CaptureSource[] }
  | { op: 'capture.take'; sources: CaptureSource[]; maxEdge: number; quality: number }
  | { op: 'capture.stop' }
  | { op: 'audio.open'; streamId: string; sampleRate: number }
  | { op: 'audio.chunk'; streamId: string; data: Uint8Array }
  | { op: 'audio.finish'; streamId: string }
  | { op: 'audio.stop'; streamId: string }
  | { op: 'voice.say'; streamId: string; text: string }
  | { op: 'voice.finish'; streamId: string }
  | { op: 'voice.stop'; streamId: string };

export interface MicDevice {
  deviceId: string;
  label: string;
}

/** Events the worker sends without being asked. */
export type WorkerEvent =
  | { type: 'mic.frame'; frame: Int16Array }
  | { type: 'mic.level'; level: number }
  | { type: 'mic.error'; message: string }
  | { type: 'audio.started'; streamId: string }
  | { type: 'audio.finished'; streamId: string }
  | { type: 'audio.error'; streamId: string; message: string }
  /** Synthesised in main when the worker process dies, so every waiter fails fast. */
  | { type: 'worker.crashed' };

export interface WorkerReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}
