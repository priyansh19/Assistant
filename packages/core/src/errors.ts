/**
 * Typed failures (architecture §8.1). Every failure that ends an interaction is a StageError: it
 * says which stage failed, which provider (when there is one) and what kind of failure it was.
 * The sentence the user sees is derived from those fields, never from the raw message alone.
 */

/** The part of the interaction that failed. */
export type Stage = 'mic' | 'capture' | 'stt' | 'answer' | 'speech' | 'config' | 'app';

export type FailureKind =
  /** The key was rejected. */
  | 'auth'
  /** The key is real but of a kind that can't run models (e.g. an OpenRouter management key). */
  | 'wrong-key-type'
  /** Out of credit or over a billing quota. */
  | 'quota'
  | 'rate-limit'
  | 'network'
  | 'timeout'
  | 'server'
  /** The provider refused the request itself (unknown model, bad parameter). */
  | 'request'
  /** The provider answered, but with nothing usable (empty answer, no audio, cut off). */
  | 'bad-output'
  /** The AI declined to answer. */
  | 'refused'
  /** Microphone or audio device problem. */
  | 'device'
  /** Windows blocked the microphone or screen. */
  | 'permission'
  /** Something the user has to set up (a missing key or provider choice). */
  | 'config'
  | 'unknown';

const RETRYABLE: ReadonlySet<FailureKind> = new Set(['network', 'timeout', 'server', 'rate-limit']);

export interface StageErrorOptions {
  provider?: string;
  status?: number | null;
  cause?: unknown;
}

export class StageError extends Error {
  readonly provider: string | undefined;
  readonly status: number | null;

  constructor(
    readonly stage: Stage,
    readonly kind: FailureKind,
    message: string,
    opts: StageErrorOptions = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'StageError';
    this.provider = opts.provider;
    this.status = opts.status ?? null;
  }

  /** Safe to try again automatically, provided nothing reached the user yet. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/** Thrown by provider getters when configuration is missing; shown to the user as-is. */
export class ConfigError extends StageError {
  constructor(message: string) {
    super('config', 'config', message);
    this.name = 'ConfigError';
  }
}

/** A stage took longer than its budget. `what` reads naturally after "Sorry, ". */
export class StageTimeoutError extends StageError {
  constructor(stage: Stage, what: string) {
    super(stage, 'timeout', `${what} took too long`);
    this.name = 'StageTimeoutError';
  }
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  assemblyai: 'AssemblyAI',
  elevenlabs: 'ElevenLabs',
};

/** Display name for a provider id ("openrouter" → "OpenRouter"). */
export function providerName(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return PROVIDER_NAMES[id.toLowerCase()] ?? id;
}

/** Classify an HTTP failure from its status and the provider's own error text. */
export function kindFromHttp(status: number | null, detail: string, provider?: string): FailureKind {
  if (/management key|provisioning key/i.test(detail)) return 'wrong-key-type';
  if (provider === 'openrouter' && /user not found/i.test(detail)) return 'wrong-key-type';
  // Billing first: OpenAI reports quota as 429 and Anthropic labels it invalid_request_error.
  if (status === 402 || /credit|quota|billing|insufficient|payment required|balance/i.test(detail)) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status !== null && status >= 500) return 'server';
  if (status !== null && status >= 400) return 'request';
  return 'unknown';
}

interface ProviderLike {
  provider?: unknown;
  status?: unknown;
  message?: unknown;
}

/** Strip the "provider 401: " prefix ProviderError puts in front of the provider's own text. */
function providerDetail(message: string): string {
  return message.replace(/^[a-z0-9-]+(?: \d{3})?:\s*/i, '');
}

/**
 * Turn anything thrown during an interaction into a StageError. `stage` is the stage that was
 * running; an error that already knows its stage keeps it.
 */
export function classifyFailure(e: unknown, stage: Stage): StageError {
  if (e instanceof StageError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const p = (typeof e === 'object' && e !== null ? e : {}) as ProviderLike;
  const provider = typeof p.provider === 'string' ? p.provider : undefined;
  const status = typeof p.status === 'number' ? p.status : null;
  const opts: StageErrorOptions = { cause: e, status, ...(provider ? { provider } : {}) };
  if (provider || status !== null) {
    const kind = kindFromHttp(status, msg, provider);
    if (kind !== 'unknown') return new StageError(stage, kind, providerDetail(msg), opts);
  }
  // Errors without a status (SDK messages, DOM exceptions, socket failures): look at the text.
  const statusInText = /\b([1-5]\d\d)\b/.exec(msg);
  if (statusInText) {
    const kind = kindFromHttp(Number(statusInText[1]), msg, provider);
    if (kind !== 'unknown' && kind !== 'request') return new StageError(stage, kind, providerDetail(msg), opts);
  }
  if (/credit|quota|billing|insufficient/i.test(msg)) return new StageError(stage, 'quota', msg, opts);
  if (/NotAllowedError|Permission denied/i.test(msg)) return new StageError('mic', 'permission', msg, opts);
  if (/NotFoundError|OverconstrainedError|no microphone|NotReadableError/i.test(msg))
    return new StageError('mic', 'device', msg, opts);
  if (/mic\.start timed out|Microphone unavailable|microphone was disconnected/i.test(msg))
    return new StageError('mic', 'device', msg, opts);
  if (/fetch failed|network|ENOTFOUND|ECONN|EAI_AGAIN|ETIMEDOUT|socket/i.test(msg))
    return new StageError(stage, 'network', msg, opts);
  if (/declined to answer/i.test(msg)) return new StageError(stage, 'refused', msg, opts);
  if (/empty answer|no audio|produced no sound|cut off/i.test(msg))
    return new StageError(stage, 'bad-output', msg, opts);
  return new StageError(stage, 'unknown', msg, opts);
}

const STAGE_SERVICE: Record<Stage, string> = {
  mic: 'The microphone',
  capture: 'Screen capture',
  stt: 'The speech-to-text service',
  answer: 'The AI service',
  speech: 'The voice service',
  config: 'Clicky',
  app: 'Clicky',
};

/** One short sentence the user can act on, naming the provider when there is one. */
export function userMessage(err: StageError): string {
  const who = providerName(err.provider);
  const service = who ?? STAGE_SERVICE[err.stage];
  const detail = err.message.slice(0, 80);
  switch (err.kind) {
    case 'config':
      return err.message;
    case 'wrong-key-type':
      return who === 'OpenRouter' || !who
        ? "Your OpenRouter key can't run models (it may be a management key). Create a normal key at openrouter.ai/keys."
        : `Your ${who} key can't be used for this. Create a normal API key with ${who}.`;
    case 'auth':
      return who
        ? `Your ${who} key was rejected (${detail}). Check it in Clicky > API keys.`
        : 'An API key was rejected. Check your keys in Clicky > API keys.';
    case 'quota':
      return who
        ? `Your ${who} account is out of credit. Add billing with ${who}, then try again.`
        : 'An AI account is out of credit. Add billing with the provider, then try again.';
    case 'rate-limit':
      return `${service} is rate limiting requests. Wait a moment and try again.`;
    case 'timeout':
      return `Sorry, ${err.message}. Please try again.`;
    case 'server':
      return `${service} had a problem. Please try again.`;
    case 'request':
      return `${service} rejected the request (${detail}). Check the model in Clicky > AI and voice.`;
    case 'network':
      return 'Network problem. Check your internet connection.';
    case 'refused':
      return 'The AI declined to answer this question.';
    case 'bad-output':
      return `${service} returned nothing usable (${detail}). Please try again.`;
    case 'permission':
      return 'Windows is blocking the microphone. Open Settings > Privacy & security > Microphone and allow desktop apps.';
    case 'device':
      if (/NotFoundError|OverconstrainedError|no microphone/i.test(err.message))
        return 'No microphone found. Plug one in or pick another in Clicky > General.';
      if (/NotReadableError/i.test(err.message)) return 'Another app is using the microphone. Close it and try again.';
      return 'The microphone did not respond. Try again, or pick another in Clicky > General.';
    case 'unknown':
      return `Something went wrong: ${err.message.slice(0, 120)}`;
  }
}

/** Compatibility wrapper: classify and describe in one step. */
export function describeError(e: unknown, stage: Stage = 'app'): string {
  return userMessage(classifyFailure(e, stage));
}
