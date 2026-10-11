// Messages between the main process (control plane) and the engine (data plane: hold key,
// orchestrator, providers), architecture §4. The engine runs in an Electron utilityProcess, or
// inside main as a fallback; the same messages are used either way.

import type {
  AskResult,
  CredentialId,
  DisplayGeometry,
  HistoryEntry,
  InteractionState,
  LatencySummary,
  MappedPoint,
  Settings,
} from '@clicky/core';
import type { CaptureSource } from './worker-protocol';

/** Everything the engine needs to know about the app. Sent whole whenever any part changes. */
export interface EngineConfig {
  settings: Settings;
  /** Saved API keys. Only ever sent to the engine (a Node process), never to a renderer. */
  keys: Partial<Record<CredentialId, string>>;
  /** Keys the chosen providers need but don't have. */
  missing: CredentialId[];
  /** Text-only history, for follow-up context. */
  history: HistoryEntry[];
  /** CLICKY_DEMO: offline providers. */
  demo: boolean;
}

/** What to capture for one interaction, worked out in main (it owns the screen API). */
export interface CapturePlan {
  displays: DisplayGeometry[];
  sources: CaptureSource[];
}

export type MainToEngine =
  | { type: 'config'; config: EngineConfig }
  /** Start (or restart, after a hold-key change) the hold-to-talk hook. */
  | { type: 'holdKey.start' }
  | { type: 'holdKey.stop' }
  /** Setup wizard "press your key": report presses instead of asking. */
  | { type: 'keyTest'; on: boolean }
  | { type: 'ask'; id: number; question: string; source: 'typed' | 'action' }
  | { type: 'cancel'; reason: string }
  | { type: 'speakSample'; id: number; text: string }
  | { type: 'prewarm' }
  | { type: 'capturePlan.reply'; id: number; plan?: CapturePlan; error?: string }
  /** The media renderer died; a new port follows once it's back. */
  | { type: 'media.crashed' }
  | { type: 'shutdown' };

export type OverlayOp =
  | { op: 'state'; state: InteractionState }
  | { op: 'point'; target: MappedPoint; label: string }
  | { op: 'message'; text: string; kind: 'error' | 'info' }
  | { op: 'caption'; text: string };

export type EngineToMain =
  | { type: 'ready' }
  | { type: 'state'; state: InteractionState; interactionId: string | null }
  | { type: 'overlay'; overlay: OverlayOp }
  | { type: 'record'; entry: Omit<HistoryEntry, 'id' | 'at'> }
  | { type: 'latency'; summary: LatencySummary }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  /** Hold key pressed while keys are missing: open the place to add them. */
  | { type: 'needKeys' }
  /** A voice question started (main moves the dashboard out of the screenshot). */
  | { type: 'listening' }
  | { type: 'keyTest'; down: boolean }
  | { type: 'askResult'; id: number; result: AskResult | null }
  | { type: 'speakSampleResult'; id: number; error?: string }
  | { type: 'capturePlan'; id: number; allDisplays: boolean }
  | { type: 'holdKey.failed'; message: string };
