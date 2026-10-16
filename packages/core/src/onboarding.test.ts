import { describe, expect, it } from 'vitest';
import {
  completeStep,
  finishOnboarding,
  goTo,
  micAdvice,
  onboardingFunnel,
  onboardingResume,
  ONBOARDING_VERSION,
  recordFirstAnswer,
  skipStep,
  speakerAdvice,
  startOnboarding,
  starterHelpers,
} from './onboarding.js';

describe('onboarding state machine', () => {
  it('walks forward, timing each step', () => {
    let s = startOnboarding(0);
    s = completeStep(s, 'welcome', 2000);
    expect(s.step).toBe('providers');
    s = completeStep(s, 'providers', 5000);
    expect(s).toMatchObject({ step: 'keys', furthest: 'keys', completed: ['welcome', 'providers'] });
    expect(s.timings).toEqual({ welcome: 2000, providers: 3000 });
  });

  it("can't jump past a required step, but can go back", () => {
    let s = startOnboarding(0);
    expect(goTo(s, 'mic', 10)).toBe(s);
    s = completeStep(completeStep(s, 'welcome', 1), 'providers', 2);
    s = goTo(s, 'welcome', 3);
    expect(s).toMatchObject({ step: 'welcome', furthest: 'keys' });
  });

  it('a late result completes only the step it started on', () => {
    let s = completeStep(startOnboarding(0), 'welcome', 1); // on providers
    s = goTo(s, 'welcome', 2); // user went back
    s = completeStep(s, 'providers', 3); // the providers result lands late
    expect(s.step).toBe('welcome');
    expect(s.completed).toContain('providers');
  });

  it('skips only optional steps', () => {
    let s = startOnboarding(0);
    expect(skipStep(s, 1)).toBe(s);
    for (const step of ['welcome', 'providers', 'keys', 'key', 'mic'] as const) s = completeStep(s, step, 1);
    expect(s.step).toBe('speaker');
    s = skipStep(s, 2);
    expect(s).toMatchObject({ step: 'about', skipped: ['speaker'] });
  });

  it('records the first answer once and reports a content-free funnel', () => {
    let s = recordFirstAnswer(startOnboarding(1000), 43_500);
    s = recordFirstAnswer(s, 99_000);
    s = finishOnboarding(s, 50_000);
    const f = onboardingFunnel(s);
    expect(f).toMatchObject({ firstAnswerSeconds: 42.5, finished: true, reached: 'welcome' });
    expect(JSON.stringify(f)).not.toMatch(/about|typed/);
  });

  it('resumes unfinished setup and adds only new steps for older versions', () => {
    expect(onboardingResume(undefined, 5)?.step).toBe('welcome');
    const mid = goTo(completeStep(startOnboarding(0), 'welcome', 1), 'providers', 1);
    expect(onboardingResume(mid, 99)?.stepEnteredAt).toBe(99);
    const done = finishOnboarding(startOnboarding(0), 1);
    expect(onboardingResume(done, 2)).toBeNull();
    const old = { ...done, version: 1, completed: ['welcome', 'providers', 'keys', 'key', 'mic', 'about', 'done'] as never };
    const again = onboardingResume(old, 3);
    expect(again).toMatchObject({ step: 'speaker', version: ONBOARDING_VERSION });
    expect(again?.finishedAt).toBeUndefined();
  });
});

describe('audio readiness', () => {
  it('fixes muted and silent speakers in one click', () => {
    expect(speakerAdvice({ muted: true, volume: 0.5 }).fix).toBe('unmute');
    expect(speakerAdvice({ muted: false, volume: 0.01 }).fix).toBe('raise');
    expect(speakerAdvice({ muted: false, volume: 0.4 }).fix).toBeNull();
  });

  it('warns about Bluetooth mics and dead air', () => {
    expect(micAdvice({ deviceName: 'Headset (WH-1000XM4 Hands-Free AG Audio)', silentMs: 0, others: [] })).toMatch(/Bluetooth/);
    expect(micAdvice({ deviceName: 'USB Mic', silentMs: 3500, others: ['USB Mic', 'Microphone Array'] })).toMatch(/Try Microphone Array/);
    expect(micAdvice({ deviceName: 'USB Mic', silentMs: 3500, others: [] })).toMatch(/isn't muted/);
    expect(micAdvice({ deviceName: 'Microphone Array', silentMs: 500, others: [] })).toBeNull();
  });
});

describe('starter helpers', () => {
  it('suggests up to two helpers from what the user does', () => {
    expect(starterHelpers('I run a startup and spend all day in my inbox with clients').map((h) => h.name)).toEqual(['Inbox Desk', 'Pitch Lab']);
    expect(starterHelpers('software engineer')).toHaveLength(1);
    expect(starterHelpers('I like hiking')).toEqual([]);
  });

  it('skips names already on the roster', () => {
    const roster = [{ slug: 'x', name: 'Inbox Desk', role: 'r', purpose: 'p', createdAt: 0, standing: [], notes: [] }];
    expect(starterHelpers('email and research', roster).map((h) => h.name)).toEqual(['Research Lead']);
  });
});
