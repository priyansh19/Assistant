// Messages between the main process (control plane) and the engine (data plane: hold key,
// orchestrator, providers), architecture §4. The engine runs in an Electron utilityProcess, or
// inside main as a fallback; the same messages are used either way.

import type {
  AskResult,
  CredentialId,
  DisplayGeometry,
  HistoryEntry,
  InputAction,
  InteractionState,
  LatencySummary,
  MappedPoint,
  MappedShape,
  Playbook,
  AgentLesson,
  AgentSkill,
  LearnedStyle,
  StyleContext,
  WriteContext,
  AppInfo,
  Settings,
  UiElement,
  OtherAgent,
  ClickyAgent,
  Cadence,
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
  /** Folder of downloaded on-device speech models (main downloads them, the engine runs them). */
  modelsDir: string;
  /** Playbooks (all of them; the engine picks the ones that apply to the app in front). */
  playbooks: Playbook[];
  /** How the user writes, learned from their own writing. */
  style: LearnedStyle;
  /** Agent runs that worked, for hints on similar tasks. */
  lessons: AgentLesson[];
  /** Things the user asked Clicky to remember. */
  notes: string[];
  /** Installed app names and common folders (main scans them). */
  inventory: { apps: string[]; folders: string[] };
  /** agents.md: the standing briefing added to every agent run. */
  briefing: string;
  /** Task skills (skills/*.md); the ones matching a task are added to its run. */
  skills: AgentSkill[];
  /** Where files Clicky makes (sheets) are saved: Documents/Clicky. */
  outputDir: string;
  /** Clicky's own data folder (userData): the drawings it has learned live here. */
  dataDir: string;
  /** Named helpers, with notes and preferences as their AGENTS.md has them. */
  clickys: ClickyAgent[];
  /** Each helper's folder, by slug. */
  clickyWorkspaces: Record<string, string>;
  /** Routine titles by owning helper slug, for the twin check. */
  routineTitles: Record<string, string[]>;
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
  /** Settings "Record keys": report the next combination pressed. */
  | { type: 'keyRecord' }
  | { type: 'ask'; id: number; question: string; source: 'typed' | 'action' }
  | { type: 'cancel'; reason: string }
  | { type: 'speakSample'; id: number; text: string }
  | { type: 'prewarm' }
  | { type: 'capturePlan.reply'; id: number; plan?: CapturePlan; error?: string }
  | { type: 'input.reply'; id: number; error?: string }
  | { type: 'writeContext.reply'; id: number; context: WriteContext }
  | { type: 'foreground.reply'; id: number; app: AppInfo | null }
  | { type: 'windows.reply'; id: number; windows: string[] }
  | { type: 'elements.reply'; id: number; elements: UiElement[] }
  | { type: 'otherAgent.reply'; id: number; text: OtherAgent | null }
  /** A sketch rendered to a PNG (base64), or null if it couldn't be. */
  | { type: 'renderSketch.reply'; id: number; png: string | null }
  /** Step strip buttons. */
  | { type: 'agent.pause'; on: boolean }
  | { type: 'agent.allow' }
  /** The notch's Allow all switch (session only). */
  | { type: 'agent.allowAll'; on: boolean }
  /** The media renderer died; a new port follows once it's back. */
  | { type: 'media.crashed' }
  | { type: 'shutdown' };

export type OverlayOp =
  | { op: 'state'; state: InteractionState }
  | { op: 'point'; target: MappedPoint; label: string; snap?: boolean }
  | { op: 'draw'; shape: MappedShape }
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
  | { type: 'keyTest'; down: boolean; key: 'talk' | 'dictate' }
  | { type: 'keyRecorded'; key: string | null }
  | { type: 'askResult'; id: number; result: AskResult | null }
  | { type: 'speakSampleResult'; id: number; error?: string }
  | { type: 'capturePlan'; id: number; allDisplays: boolean }
  /** Agent mode or dictation: press keys or use the mouse (main owns screen coordinates). */
  | { type: 'input'; id: number; action: InputAction }
  /** Write mode, at key-up: the app in front and the selected text. */
  | { type: 'writeContext'; id: number }
  /** Dictation started: move the companion to the text caret. */
  | { type: 'caretAnchor' }
  /** The app in front (never-touch check before each agent step). */
  | { type: 'foreground'; id: number }
  | { type: 'windows'; id: number }
  /** The controls of the window in front, for agent steps. */
  | { type: 'elements'; id: number }
  /** Is another agent driving this PC (checked before each agent step)? */
  | { type: 'otherAgent'; id: number }
  /** Render a sketch's SVG so the model can check the drawing. */
  | { type: 'renderSketch'; id: number; svg: string }
  /** Agent mode was asked for but isn't set up: open its rules screen. */
  | { type: 'agentSetup' }
  /** Step strip: progress, a question waiting for Allow, or the end of the run. */
  | { type: 'agentProgress'; goal: string; step: number; max: number; say: string }
  | { type: 'agentAsk'; text: string | null }
  | { type: 'agentPaused'; on: boolean; reason?: 'user' | 'agent' }
  | { type: 'allowAll'; on: boolean }
  /** Something learned about how the user writes (main stores it). */
  | { type: 'styleLearned'; context: StyleContext; notes: string[]; examples: string[] }
  /** An agent run finished well: remember what worked. */
  | { type: 'agentLesson'; lesson: AgentLesson }
  | { type: 'remember'; note: string }
  /** "Pitch Lab, remember…": a note for one helper's AGENTS.md (main filters secrets again). */
  | { type: 'clickyNote'; slug: string; note: string }
  /** A task was sent to an archived helper: bring it back. */
  | { type: 'clickyRestore'; slug: string }
  /** "Every morning…": set up a routine; the first run is the task running now. */
  | { type: 'routineCreate'; title: string; task: string; cadence: Cadence; owner?: string }
  | { type: 'holdKey.failed'; message: string };
