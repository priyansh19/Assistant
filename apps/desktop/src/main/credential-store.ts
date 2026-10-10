import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';
import { CREDENTIAL_IDS, validateApiKey, type CredentialId } from '@clicky/core';

export type KeyStatus = Record<CredentialId, boolean>;

/**
 * API keys encrypted with Electron safeStorage (DPAPI on Windows) in `<userData>/credentials.json`.
 * Keys are decrypted only in the main process, on demand, and never sent to a renderer.
 * If OS encryption is unavailable we refuse to store keys rather than fall back to plaintext.
 */
export class CredentialStore {
  constructor(private readonly file = join(app.getPath('userData'), 'credentials.json')) {}

  get encryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  status(): KeyStatus {
    const data = this.read();
    return Object.fromEntries(CREDENTIAL_IDS.map((id) => [id, typeof data[id] === 'string'])) as KeyStatus;
  }

  set(id: CredentialId, key: string): { ok: true } | { ok: false; reason: string } {
    if (!CREDENTIAL_IDS.includes(id)) return { ok: false, reason: 'Unknown provider.' };
    const v = validateApiKey(id, key);
    if (!v.ok) return v;
    if (!this.encryptionAvailable)
      return { ok: false, reason: 'Windows encryption is not available, so the key was not saved.' };
    const data = this.read();
    data[id] = safeStorage.encryptString(v.key).toString('base64');
    this.write(data);
    return { ok: true };
  }

  clear(id: CredentialId): void {
    const { [id]: _removed, ...rest } = this.read();
    this.write(rest);
  }

  /** Main process only: the decrypted key, or null if none is stored or it can't be decrypted. */
  get(id: CredentialId): string | null {
    const blob = this.read()[id];
    if (typeof blob !== 'string') return null;
    try {
      return safeStorage.decryptString(Buffer.from(blob, 'base64'));
    } catch {
      return null;
    }
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
