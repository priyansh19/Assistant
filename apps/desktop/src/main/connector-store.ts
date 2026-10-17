import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  capabilityLine,
  checkConnector,
  commandCandidates,
  connectorCopy,
  credentialsInvalidated,
  launchSpec,
  type ConnectorConfig,
  type ConnectorSecrets,
  type McpToolInfo,
} from '@clicky/core';
import { log } from './log';

export type ConnectorSaveResult =
  { ok: true; connector: ConnectorConfig; warnings: string[]; cleared: boolean } | { ok: false; errors: string[] };

export type ConnectorCheckResult = { ok: true; message: string; tools: McpToolInfo[] } | { ok: false; message: string };

const CHECK_TIMEOUT_MS = 20_000;

/**
 * Custom connectors: the list (names only) in userData/connectors.json, each connector's keys
 * encrypted with safeStorage (DPAPI) in userData/connector-secrets.json. Keys are decrypted only
 * here, in main, and handed to the server as its environment or request headers.
 */
export class ConnectorStore {
  private readonly file = join(app.getPath('userData'), 'connectors.json');
  private readonly secretsFile = join(app.getPath('userData'), 'connector-secrets.json');
  private list_: ConnectorConfig[] = [];
  private blobs: Record<string, string> = {};
  private readonly open = new Map<string, Client>();
  private readonly listeners = new Set<() => void>();

  constructor() {
    try {
      if (existsSync(this.file)) {
        const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (Array.isArray(raw))
          this.list_ = raw.filter(
            (c): c is ConnectorConfig =>
              typeof c === 'object' && c !== null && typeof c.id === 'string' && typeof c.name === 'string',
          );
      }
      if (existsSync(this.secretsFile)) {
        const raw: unknown = JSON.parse(readFileSync(this.secretsFile, 'utf8'));
        if (typeof raw === 'object' && raw !== null) this.blobs = raw as Record<string, string>;
      }
    } catch (e) {
      log.warn('connectors could not be read', String(e));
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): ConnectorConfig[] {
    return this.list_;
  }

  /** Which secrets are saved, by name only (for the dashboard). */
  savedSecretNames(id: string): { bearer: boolean; env: string[]; headers: string[] } {
    const s = this.secrets(id);
    return { bearer: !!s.bearer, env: Object.keys(s.env), headers: Object.keys(s.headers) };
  }

  /**
   * Save a connector. `secrets` replaces the saved values it names; values left empty keep what
   * was saved. Changing the server or client ID clears the saved keys.
   */
  save(input: ConnectorConfig, secrets: Partial<ConnectorSecrets>): ConnectorSaveResult {
    const others = this.list_.filter((c) => c.id !== input.id);
    const check = checkConnector(input, others);
    if (check.errors.length) return { ok: false, errors: check.errors };
    if (
      (secrets.bearer || Object.keys(secrets.env ?? {}).length || Object.keys(secrets.headers ?? {}).length) &&
      !safeStorage.isEncryptionAvailable()
    )
      return { ok: false, errors: ['Windows encryption is not available, so keys were not saved.'] };
    const before = this.list_.find((c) => c.id === input.id);
    const cleared = !!before && credentialsInvalidated(before, input);
    const prev = cleared ? { env: {}, headers: {} } : this.secrets(input.id);
    const merged: ConnectorSecrets = {
      env: { ...prev.env, ...(secrets.env ?? {}) },
      headers: { ...prev.headers, ...(secrets.headers ?? {}) },
    };
    const bearer = secrets.bearer || (cleared ? undefined : prev.bearer);
    if (bearer) merged.bearer = bearer;
    const saved: ConnectorConfig = {
      ...input,
      envNames: [...new Set([...input.envNames, ...Object.keys(secrets.env ?? {})])],
      headerNames: [...new Set([...input.headerNames, ...Object.keys(secrets.headers ?? {})])],
    };
    this.list_ = [...others, saved];
    this.writeSecrets(input.id, merged);
    void this.close(input.id);
    this.persist();
    return { ok: true, connector: saved, warnings: check.warnings, cleared };
  }

  remove(id: string): void {
    void this.close(id);
    this.list_ = this.list_.filter((c) => c.id !== id);
    const { [id]: _drop, ...rest } = this.blobs;
    void _drop;
    this.blobs = rest;
    this.writeBlobs();
    this.persist();
  }

  setEnabled(id: string, enabled: boolean): void {
    this.list_ = this.list_.map((c) => (c.id === id ? { ...c, enabled } : c));
    this.persist();
  }

  /**
   * Connect, list its tools, and keep the capability line. This is the save-time check: it says
   * whether the key works without ever showing the key.
   */
  async check(id: string): Promise<ConnectorCheckResult> {
    const c = this.list_.find((x) => x.id === id);
    if (!c) return { ok: false, message: 'That connector no longer exists.' };
    try {
      const client = await this.client(c);
      const res = await client.listTools(undefined, { timeout: CHECK_TIMEOUT_MS });
      const tools: McpToolInfo[] = res.tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
      }));
      this.list_ = this.list_.map((x) =>
        x.id === id ? { ...x, capability: capabilityLine(tools), toolCount: tools.length } : x,
      );
      this.persist();
      return { ok: true, message: connectorCopy.accepted(c.name, tools.length), tools };
    } catch (e) {
      await this.close(id);
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`connector check failed for ${c.name}`, msg.slice(0, 300));
      const status = /\b(401|403)\b/.exec(msg)?.[1];
      if (status) return { ok: false, message: connectorCopy.rejected(c.name, Number(status)) };
      if (/ENOENT|not recognized|cannot find/i.test(msg))
        return { ok: false, message: connectorCopy.notFound(c.command ?? c.name) };
      return { ok: false, message: connectorCopy.unreachable(c.name) };
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((id) => this.close(id)));
  }

  private async client(c: ConnectorConfig): Promise<Client> {
    const existing = this.open.get(c.id);
    if (existing) return existing;
    const spec = launchSpec(c, this.secrets(c.id));
    const client = new Client({ name: 'clicky', version: app.getVersion() });
    if (spec.transport === 'stdio') {
      const command = this.resolveCommand(spec.command);
      await client.connect(
        new StdioClientTransport({
          command,
          args: spec.args,
          env: { ...getDefaultEnvironment(), ...spec.env },
          stderr: 'ignore',
        }),
        { timeout: CHECK_TIMEOUT_MS },
      );
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
        requestInit: { headers: spec.headers },
      });
      // The SDK's optional properties predate exactOptionalPropertyTypes; the transport is the SDK's own.
      await client.connect(transport as unknown as Parameters<Client['connect']>[0], { timeout: CHECK_TIMEOUT_MS });
    }
    this.open.set(c.id, client);
    return client;
  }

  private resolveCommand(command: string): string {
    for (const p of commandCandidates(command, process.env)) if (existsSync(p)) return p;
    return command;
  }

  private async close(id: string): Promise<void> {
    const c = this.open.get(id);
    this.open.delete(id);
    try {
      await c?.close();
    } catch {
      // already gone
    }
  }

  private secrets(id: string): ConnectorSecrets {
    const blob = this.blobs[id];
    if (!blob) return { env: {}, headers: {} };
    try {
      const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(blob, 'base64'))) as Partial<ConnectorSecrets>;
      return {
        env: parsed.env ?? {},
        headers: parsed.headers ?? {},
        ...(parsed.bearer ? { bearer: parsed.bearer } : {}),
      };
    } catch {
      return { env: {}, headers: {} };
    }
  }

  private writeSecrets(id: string, s: ConnectorSecrets): void {
    const empty = !s.bearer && !Object.keys(s.env).length && !Object.keys(s.headers).length;
    if (empty) {
      const { [id]: _drop, ...rest } = this.blobs;
      void _drop;
      this.blobs = rest;
    } else if (safeStorage.isEncryptionAvailable()) {
      this.blobs = { ...this.blobs, [id]: safeStorage.encryptString(JSON.stringify(s)).toString('base64') };
    }
    this.writeBlobs();
  }

  private writeBlobs(): void {
    try {
      mkdirSync(dirname(this.secretsFile), { recursive: true });
      const tmp = `${this.secretsFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.blobs, null, 1));
      renameSync(tmp, this.secretsFile);
    } catch (e) {
      log.warn('connector keys could not be written', String(e));
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.list_, null, 1));
    } catch (e) {
      log.warn('connectors.json could not be written', String(e));
    }
    for (const fn of this.listeners) fn();
  }
}
