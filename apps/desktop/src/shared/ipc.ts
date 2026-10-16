import type {
  CredentialId,
  HistoryEntry,
  InteractionState,
  LearnedStyle,
  Playbook,
  SavedAction,
  Settings,
  StageMetric,
  StageStat,
} from '@clicky/core';
import type { MicDevice } from './worker-protocol';

// IPC channel names shared by main, preload and renderer. Preloads inline the strings (typed as
// IpcChannel) because sandboxed preloads can't share runtime modules.
export const IPC = {
  overlayCursor: 'overlay:cursor',
  overlayState: 'overlay:state',
  overlayPoint: 'overlay:point',
  overlayDraw: 'overlay:draw',
  overlayAnchor: 'overlay:anchor',
  overlayOwner: 'overlay:owner',
  overlayGuide: 'overlay:guide',
  stripState: 'strip:state',
  stripPause: 'strip:pause',
  stripStop: 'strip:stop',
  stripAllow: 'strip:allow',
  stripAllowAll: 'strip:allow-all',
  orbState: 'orb:state',
  orbHover: 'orb:hover',
  orbOff: 'orb:off',
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
  dashRecordKeys: 'dash:record-keys',
  dashLocalModels: 'dash:local-models',
  dashTryIt: 'dash:try-it',
  dashDiagnostics: 'dash:diagnostics',
  dashOpenLogs: 'dash:open-logs',
  dashHoldKey: 'dash:hold-key',
  dashChanged: 'dash:changed',
  dashMicLevel: 'dash:mic-level',
  dashLocalDownload: 'dash:local-download',
  dashLocalRemove: 'dash:local-remove',
  dashPlaybookSave: 'dash:playbook-save',
  dashPlaybookRemove: 'dash:playbook-remove',
  dashPlaybooksOpen: 'dash:playbooks-open',
  dashPlayCue: 'dash:play-cue',
  dashTaskAdd: 'dash:task-add',
  dashTaskRemove: 'dash:task-remove',
  dashTaskRun: 'dash:task-run',
  dashStyleRemove: 'dash:style-remove',
  dashStyleClear: 'dash:style-clear',
  dashModels: 'dash:models',
  dashNoteRemove: 'dash:note-remove',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export interface LatencyStatsView {
  count: number;
  lastMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  stages: Record<StageMetric, StageStat>;
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
  local: LocalSpeechView;
  playbooks: Playbook[];
  /** What Clicky learned about how the user writes. */
  style: LearnedStyle;
  tasks: TaskView[];
  /** Things the user asked Clicky to remember. */
  notes: string[];
}

/** One OpenRouter model for the picker. */
export interface ModelOption {
  id: string;
  name: string;
  free: boolean;
  openSource: boolean;
  /** Approximate dollars per 1,000 answers with a screenshot. */
  per1000: number;
}

export interface TaskView {
  id: string;
  goal: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
  addedAt: number;
  endedAt?: number;
  summary?: string;
}

export interface LocalModelView {
  id: string;
  kind: 'stt' | 'voice';
  name: string;
  desc: string;
  sizeMb: number;
  installed: boolean;
  /** 0–1 while downloading, null while unpacking, undefined when idle. */
  progress?: number | null;
  error?: string;
}

export interface LocalSpeechView {
  models: LocalModelView[];
  /** OpenWhispr's local speech server is running (usable without downloading anything). */
  openWhispr: boolean;
}

export type KeySetResult = { ok: true; snapshot: DashboardSnapshot } | { ok: false; reason: string };
/**
 * A live check result. `kind` says what failed: only 'invalid' means the key itself is wrong;
 * billing, transient (network/rate limit) and model problems are warnings, not rejections.
 */
export type TestResult =
  { ok: true; message: string } | { ok: false; message: string; kind?: 'invalid' | 'billing' | 'transient' | 'model' };
export interface TryResult {
  outcome: 'answered' | 'cancelled' | 'error';
  answer: string;
  pointLabel: string | null;
  detail?: string;
}
export type ActionSaveResult = { ok: true; action: SavedAction } | { ok: false; reason: string };
export type { MicDevice };
