import type { CredentialId, HistoryEntry, InteractionState, SavedAction, Settings } from '@clicky/core';
import type { MicDevice } from './worker-protocol';

// IPC channel names shared by main, preload and renderer. Preloads inline the strings (typed as
// IpcChannel) because sandboxed preloads can't share runtime modules.
export const IPC = {
  overlayCursor: 'overlay:cursor',
  overlayState: 'overlay:state',
  overlayPoint: 'overlay:point',
  overlayMessage: 'overlay:message',
  overlayLevel: 'overlay:level',
  overlayConfig: 'overlay:config',
  dashGet: 'dash:get',
  dashUpdate: 'dash:update',
  dashKeySet: 'dash:key-set',
  dashKeyClear: 'dash:key-clear',
  dashKeyTest: 'dash:key-test',
  dashMicDevices: 'dash:mic-devices',
  dashMicTest: 'dash:mic-test',
  dashVoiceTest: 'dash:voice-test',
  dashAsk: 'dash:ask',
  dashHistoryRemove: 'dash:history-remove',
  dashHistoryClear: 'dash:history-clear',
  dashActionSave: 'dash:action-save',
  dashActionRemove: 'dash:action-remove',
  dashActionRun: 'dash:action-run',
  dashOpenLink: 'dash:open-link',
  dashHoldKeyTest: 'dash:hold-key-test',
  dashTryIt: 'dash:try-it',
  dashDiagnostics: 'dash:diagnostics',
  dashOpenLogs: 'dash:open-logs',
  dashHoldKey: 'dash:hold-key',
  dashChanged: 'dash:changed',
  dashMicLevel: 'dash:mic-level',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface LatencyStatsView {
  count: number;
  lastMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** What the dashboard sees. Never contains key material, only whether each key is saved. */
export interface DashboardSnapshot {
  settings: Settings;
  keys: Record<CredentialId, boolean>;
  encryptionAvailable: boolean;
  appVersion: string;
  /** Model used when the model field is empty, for the current answer provider. */
  defaultModel: string;
  state: InteractionState;
  /** Keys the chosen providers need but don't have. */
  missing: CredentialId[];
  stats: LatencyStatsView;
  history: HistoryEntry[];
  actions: SavedAction[];
  /** Last four characters of each saved key, so the user can tell which key is stored. */
  keyHints: Partial<Record<CredentialId, string>>;
}

export type KeySetResult = { ok: true; snapshot: DashboardSnapshot } | { ok: false; reason: string };
export type TestResult = { ok: true; message: string } | { ok: false; message: string };
export type ActionSaveResult = { ok: true; action: SavedAction } | { ok: false; reason: string };
export type { MicDevice };
