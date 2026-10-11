import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';
import { CREDENTIAL_IDS, validateApiKey, type CredentialId } from '@clicky/core';

export type KeyStatus = Record<CredentialId, boolean>;

type Listener = () => void;

/**
 * API keys encrypted with Electron safeStorage (DPAPI on Windows) in `<userData>/credentials.json`.
 * Keys are decrypted only in the main process and never sent to a renderer. Decrypted keys are
 * cached in main-process memory so the key-down path doesn't pay for file reads and DPAPI calls.
 * If OS encryption is unavailable we refuse to store keys rather than fall back to plaintext.
 */
export class CredentialStore {
  private blobs: Partial<Record<CredentialId, string>>;
  private readonly plain = new Map<CredentialId, string | null>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly file = join(app.getPath('userData'), 'credentials.json')) {
    this.blobs = this.read();
  }

  get encryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  status(): KeyStatus {
    return Object.fromEntries(CREDENTIAL_IDS.map((id) => [id, typeof this.blobs[id] === 'string'])) as KeyStatus;
  }

  /** Last four characters of each saved key, so the user can tell which key is stored. */
  hints(): Partial<Record<CredentialId, string>> {
    const out: Partial<Record<CredentialId, string>> = {};
    for (const id of CREDENTIAL_IDS) {
      const k = this.get(id);
      if (k && k.length >= 12) out[id] = k.slice(-4);
    }
    return out;
  }

  set(id: CredentialId, key: string): { ok: true } | { ok: false; reason: string } {
    if (!CREDENTIAL_IDS.includes(id)) return { ok: false, reason: 'Unknown provider.' };
    const v = validateApiKey(id, key);
    if (!v.ok) return v;
    if (!this.encryptionAvailable) {
      return { ok: false, reason: 'Windows encryption is not available, so the key was not saved.' };
    }
    this.blobs = { ...this.blobs, [id]: safeStorage.encryptString(v.key).toString('base64') };
    this.plain.set(id, v.key);
    this.write(this.blobs);
    this.changed();
    return { ok: true };
  }

  clear(id: CredentialId): void {
    const { [id]: _removed, ...rest } = this.blobs;
    this.blobs = rest;
    this.plain.delete(id);
    this.write(this.blobs);
    this.changed();
  }

  /** Main process only: the decrypted key, or null if none is stored or it can't be decrypted. */
  get(id: CredentialId): string | null {
    if (this.plain.has(id)) return this.plain.get(id) ?? null;
    const blob = this.blobs[id];
    let value: string | null = null;
    if (typeof blob === 'string') {
      try {
        value = safeStorage.decryptString(Buffer.from(blob, 'base64'));
      } catch {
        value = null;
      }
    }
    this.plain.set(id, value);
    return value;
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  private read(): Partial<Record<CredentialId, string>> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<Record<CredentialId, string>>) : {};
    } catch {
      return {};
    }
  }

  private write(data: Partial<Record<CredentialId, string>>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.file);
  }
}
