import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_BRAIN } from '@clicky/core';
import { DEFAULT_VOICE_ID, findModel } from '../src/engine/local-speech/catalog';
import { matchesKeep, overBudget, selectFiles } from './fetch-bundle.mjs';

const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'bundle.json'), 'utf8'));

describe('bundle.json', () => {
  it('ships the default speech model, the default voice and both halves of the built-in model', () => {
    const win = selectFiles(manifest, { platform: 'win32' });
    const ids = win.map((f) => f.id);
    expect(ids).toContain('moonshine-tiny');
    expect(ids).toContain(DEFAULT_VOICE_ID);
    expect(ids).toContain('llama-server');
    const names = win.filter((f) => f.to === BUILTIN_BRAIN.dir).map((f) => f.url.split('/').pop());
    expect(names.sort()).toEqual([BUILTIN_BRAIN.model, BUILTIN_BRAIN.mmproj].sort());
  });

  it('uses the same archives and checksums as the in-app downloads', () => {
    for (const f of manifest.files.filter((x) => x.to === 'models')) {
      const spec = findModel(f.id);
      expect(spec, f.id).toBeDefined();
      expect(f.url).toBe(spec.url);
      expect(f.sha256).toBe(spec.sha256);
    }
  });

  it('keeps extras and other platforms out unless asked', () => {
    expect(selectFiles(manifest, { platform: 'linux' }).some((f) => f.id === 'llama-server')).toBe(false);
    expect(selectFiles(manifest, { platform: 'win32' }).some((f) => f.extra)).toBe(false);
    expect(selectFiles(manifest, { platform: 'win32', all: true }).some((f) => f.id === 'parakeet-v3')).toBe(true);
  });

  it('stays inside what one NSIS setup .exe can hold (2 GiB, with room for the app)', () => {
    expect(manifest.budgetBytes).toBeLessThan(2 ** 31 - 150e6);
  });
});

describe('fetch-bundle helpers', () => {
  it('matches keep patterns on file names', () => {
    expect(matchesKeep('llama-server.exe', ['llama-server.exe', '*.dll'])).toBe(true);
    expect(matchesKeep('ggml-vulkan.DLL', ['*.dll'])).toBe(true);
    expect(matchesKeep('llama-cli.exe', ['llama-server.exe', '*.dll'])).toBe(false);
    expect(matchesKeep('LICENSE-curl', ['LICENSE*'])).toBe(true);
  });

  it('names the largest files when over budget', () => {
    expect(overBudget([{ path: 'a', bytes: 5 }], 10)).toBeNull();
    expect(
      overBudget(
        [
          { path: 'a', bytes: 5 },
          { path: 'b', bytes: 9 },
        ],
        10,
      ),
    ).toEqual({ total: 14, budget: 10, largest: ['b', 'a'] });
  });
});
