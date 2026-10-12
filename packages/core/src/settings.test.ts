import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings, requiredCredentials, validateApiKey } from './settings.js';

describe('normalizeSettings', () => {
  it('returns defaults for garbage', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('x')).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid fields and replaces invalid ones', () => {
    const s = normalizeSettings({
      chatProvider: 'openrouter',
      chatModel: '  some/model  ',
      sttProvider: 'nope',
      holdKey: 'F9',
      captureMaxEdge: 99999,
      launchAtLogin: 'yes',
      extra: 1,
    });
    expect(s).toEqual({
      ...DEFAULT_SETTINGS,
      chatProvider: 'openrouter',
      chatModel: 'some/model',
      holdKey: 'F9',
      captureMaxEdge: 2560,
    });
  });

  it('shows the companion all the time unless turned off', () => {
    expect(DEFAULT_SETTINGS.showCompanion).toBe(true);
    expect(normalizeSettings({ showCompanion: false }).showCompanion).toBe(false);
    expect(normalizeSettings({ showCompanion: 'no' }).showCompanion).toBe(true);
  });

  it('keeps Clicky out of screenshots unless turned off', () => {
    expect(DEFAULT_SETTINGS.hideFromCapture).toBe(true);
    expect(normalizeSettings({ hideFromCapture: false }).hideFromCapture).toBe(false);
    expect(normalizeSettings({ hideFromCapture: 1 }).hideFromCapture).toBe(true);
  });

  it('merges a partial update onto the current settings', () => {
    const current = normalizeSettings({ holdKey: 'F8', ttsProvider: 'system' });
    expect(normalizeSettings({ launchAtLogin: true }, current)).toMatchObject({
      holdKey: 'F8',
      ttsProvider: 'system',
      launchAtLogin: true,
    });
  });
});

describe('requiredCredentials', () => {
  it('lists each needed key once and none for the system voice', () => {
    expect(requiredCredentials(DEFAULT_SETTINGS)).toEqual(['anthropic', 'assemblyai', 'elevenlabs']);
    expect(
      requiredCredentials({
        ...DEFAULT_SETTINGS,
        chatProvider: 'openai',
        sttProvider: 'openai',
        ttsProvider: 'system',
      }),
    ).toEqual(['openai']);
  });
});

describe('validateApiKey', () => {
  it('accepts plausible keys and trims them', () => {
    expect(validateApiKey('anthropic', '  sk-ant-abcdefghijklmnop  ')).toEqual({
      ok: true,
      key: 'sk-ant-abcdefghijklmnop',
    });
    expect(validateApiKey('assemblyai', '0123456789abcdef0123')).toMatchObject({ ok: true });
  });

  it('rejects empty, short, spaced and wrong-prefix keys', () => {
    expect(validateApiKey('assemblyai', ' ')).toMatchObject({ ok: false });
    expect(validateApiKey('assemblyai', 'short')).toMatchObject({ ok: false });
    expect(validateApiKey('assemblyai', '0123456789 abcdef0123')).toMatchObject({ ok: false });
    expect(validateApiKey('openrouter', 'sk-ant-abcdefghijklmnop')).toMatchObject({ ok: false });
  });
});
