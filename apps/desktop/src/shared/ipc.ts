import type { CredentialId, Settings } from '@clicky/core';

// IPC channel names and payloads shared by main, preload and renderer.
export const IPC = {
  overlayCursor: 'overlay:cursor',
  overlayState: 'overlay:state',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  keySet: 'settings:key-set',
  keyClear: 'settings:key-clear',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Cursor position in DIP relative to the overlay's display, or null when it's on another display. */
export type OverlayCursor = { x: number; y: number } | null;

/** What the settings window sees. Never contains key material, only whether each key is saved. */
export interface SettingsSnapshot {
  settings: Settings;
  keys: Record<CredentialId, boolean>;
  encryptionAvailable: boolean;
  appVersion: string;
}

export type KeySetResult = { ok: true; snapshot: SettingsSnapshot } | { ok: false; reason: string };
