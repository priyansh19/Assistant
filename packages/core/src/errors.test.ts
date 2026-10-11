import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  ConfigError,
  describeError,
  kindFromHttp,
  StageError,
  StageTimeoutError,
  userMessage,
} from './errors.js';

/** Shaped like @clicky/providers' ProviderError, which core must not import. */
class FakeProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(status ? `${provider} ${status}: ${detail}` : `${provider}: ${detail}`);
  }
}

describe('kindFromHttp', () => {
  it.each([
    [401, 'invalid x-api-key', undefined, 'auth'],
    [403, 'forbidden', undefined, 'auth'],
    [401, 'User not found.', 'openrouter', 'wrong-key-type'],
    [403, 'management key: cannot run models', 'openrouter', 'wrong-key-type'],
    [429, 'You exceeded your current quota', 'openai', 'quota'],
    [400, 'Your credit balance is too low', 'anthropic', 'quota'],
    [402, 'Payment Required', undefined, 'quota'],
    [429, 'rate limited', undefined, 'rate-limit'],
    [504, 'gateway timeout', undefined, 'timeout'],
    [529, 'overloaded', undefined, 'server'],
    [404, 'model not found', undefined, 'request'],
    [null, 'whatever', undefined, 'unknown'],
  ] as const)('%s %s (%s) → %s', (status, detail, provider, kind) => {
    expect(kindFromHttp(status, detail, provider)).toBe(kind);
  });
});

describe('classifyFailure', () => {
  it('keeps the provider and strips the status prefix from provider errors', () => {
    const err = classifyFailure(new FakeProviderError('openrouter', 401, 'User not found.'), 'answer');
    expect(err).toMatchObject({ stage: 'answer', kind: 'wrong-key-type', provider: 'openrouter', status: 401 });
    expect(err.message).toBe('User not found.');
  });

  it('passes StageErrors through unchanged, keeping their own stage', () => {
    const original = new StageTimeoutError('stt', 'speech recognition');
    expect(classifyFailure(original, 'answer')).toBe(original);
  });

  it('reads a status out of SDK-style messages', () => {
    expect(classifyFailure(new Error('401 {"type":"authentication_error"}'), 'answer').kind).toBe('auth');
  });

  it('classifies microphone and network failures by their DOM/Node error names', () => {
    expect(classifyFailure(new Error('NotAllowedError: Permission denied'), 'app')).toMatchObject({
      stage: 'mic',
      kind: 'permission',
    });
    expect(classifyFailure(new Error('NotReadableError: busy'), 'app').kind).toBe('device');
    expect(classifyFailure(new TypeError('fetch failed'), 'speech')).toMatchObject({
      stage: 'speech',
      kind: 'network',
    });
    expect(classifyFailure('weird', 'app').kind).toBe('unknown');
  });

  it('marks network, timeout, server and rate-limit failures retryable', () => {
    expect(new StageError('answer', 'network', 'x').retryable).toBe(true);
    expect(new StageError('answer', 'auth', 'x').retryable).toBe(false);
  });
});

describe('userMessage', () => {
  it('names the provider and its reason for rejected keys', () => {
    const msg = describeError(new FakeProviderError('anthropic', 401, 'invalid x-api-key'), 'answer');
    expect(msg).toBe('Your Anthropic key was rejected (invalid x-api-key). Check it in Clicky > API keys.');
  });

  it('explains OpenRouter management keys', () => {
    expect(describeError(new FakeProviderError('openrouter', 401, 'User not found.'), 'answer')).toMatch(
      /management key/,
    );
  });

  it('names the stage when no provider is known', () => {
    expect(userMessage(new StageError('speech', 'server', 'boom'))).toBe(
      'The voice service had a problem. Please try again.',
    );
    expect(userMessage(new StageError('answer', 'quota', 'no credit', { provider: 'openai' }))).toMatch(
      /OpenAI account is out of credit/,
    );
  });

  it('shows config errors and timeouts as written', () => {
    expect(userMessage(new ConfigError('Add your Anthropic key in Settings.'))).toBe(
      'Add your Anthropic key in Settings.',
    );
    expect(userMessage(new StageTimeoutError('stt', 'speech recognition'))).toBe(
      'Sorry, speech recognition took too long. Please try again.',
    );
  });
});
