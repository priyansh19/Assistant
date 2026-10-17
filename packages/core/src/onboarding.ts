import { clickyNameProblem, type ClickyAgent } from './clickys.js';

/**
 * First run as a state machine: which step the user is on, the furthest they reached, which steps
 * are done, and how long each took. Content (what they typed or said) is never recorded, only
 * steps and timings, and they stay on this PC (a local funnel instead of analytics). Completion is
 * versioned, so a later version can add a step without making everyone redo setup.
 */

export const ONBOARDING_VERSION = 2;

export const ONBOARDING_STEPS = [
  'welcome',
  'providers',
  'keys',
  'key',
  'mic',
  'speaker',
  'about',
  'helpers',
  'done',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Steps the user may skip; the rest can only be passed by doing them (or skipping all of setup). */
export const OPTIONAL_STEPS: ReadonlySet<OnboardingStep> = new Set(['speaker', 'about', 'helpers']);

export interface OnboardingState {
  version: number;
  step: OnboardingStep;
  furthest: OnboardingStep;
  completed: OnboardingStep[];
  skipped: OnboardingStep[];
  startedAt: number;
  stepEnteredAt: number;
  /** Milliseconds spent on each step, summed over visits. */
  timings: Partial<Record<OnboardingStep, number>>;
  /** Set when the whole flow finished or was skipped. */
  finishedAt?: number;
  /** Install finish to first spoken answer: the headline metric (target 60 s). */
  firstAnswerMs?: number;
}

const idx = (s: OnboardingStep): number => ONBOARDING_STEPS.indexOf(s);

export function startOnboarding(now: number): OnboardingState {
  return {
    version: ONBOARDING_VERSION,
    step: 'welcome',
    furthest: 'welcome',
    completed: [],
    skipped: [],
    startedAt: now,
    stepEnteredAt: now,
    timings: {},
  };
}

/**
 * Whether to show setup: never finished, or finished on an older version that lacked a step the
 * user needs. Older versions only see the new steps, starting at the first one.
 */
export function onboardingResume(state: OnboardingState | undefined, now: number): OnboardingState | null {
  if (!state) return startOnboarding(now);
  if (!state.finishedAt) return { ...state, stepEnteredAt: now };
  if (state.version >= ONBOARDING_VERSION) return null;
  // Version 1 had no speaker check and no starter helpers.
  const missing = ONBOARDING_STEPS.filter(
    (s) =>
      s !== 'done' &&
      !state.completed.includes(s) &&
      !state.skipped.includes(s) &&
      (s === 'speaker' || s === 'helpers'),
  );
  const first = missing[0];
  if (!first) return null;
  const { finishedAt: _f, ...rest } = state;
  void _f;
  return { ...rest, version: ONBOARDING_VERSION, step: first, stepEnteredAt: now };
}

function leave(state: OnboardingState, now: number): OnboardingState {
  const spent = Math.max(0, now - state.stepEnteredAt);
  return { ...state, timings: { ...state.timings, [state.step]: (state.timings[state.step] ?? 0) + spent } };
}

/** Move to a step. Going back is always allowed; going forward past an unfinished required step isn't. */
export function goTo(state: OnboardingState, to: OnboardingStep, now: number): OnboardingState {
  if (to === state.step) return state;
  if (idx(to) > idx(state.step)) {
    for (const s of ONBOARDING_STEPS.slice(0, idx(to))) {
      if (!state.completed.includes(s) && !state.skipped.includes(s) && !OPTIONAL_STEPS.has(s) && s !== state.step)
        return state;
    }
  }
  const left = leave(state, now);
  return { ...left, step: to, furthest: idx(to) > idx(state.furthest) ? to : state.furthest, stepEnteredAt: now };
}

/**
 * Mark a step done. `startedOn` is the step the action began on: a late result (a key check or a
 * spoken hello that finishes after the user moved on) completes only the step it started on.
 */
export function completeStep(state: OnboardingState, startedOn: OnboardingStep, now: number): OnboardingState {
  if (state.completed.includes(startedOn)) return state;
  const s = {
    ...state,
    completed: [...state.completed, startedOn],
    skipped: state.skipped.filter((x) => x !== startedOn),
  };
  if (startedOn !== state.step) return s;
  const next = ONBOARDING_STEPS[idx(startedOn) + 1];
  return next ? goTo(s, next, now) : s;
}

export function skipStep(state: OnboardingState, now: number): OnboardingState {
  if (!OPTIONAL_STEPS.has(state.step)) return state;
  const s = { ...state, skipped: [...new Set([...state.skipped, state.step])] };
  const next = ONBOARDING_STEPS[idx(state.step) + 1];
  return next ? goTo(s, next, now) : s;
}

/** Finish (or skip all of setup): later runs open straight to the dashboard. */
export function finishOnboarding(state: OnboardingState, now: number): OnboardingState {
  const left = leave(state, now);
  return {
    ...left,
    step: 'done',
    finishedAt: now,
    completed: left.completed.includes('done') ? left.completed : [...left.completed, 'done'],
  };
}

export function recordFirstAnswer(state: OnboardingState, now: number): OnboardingState {
  return state.firstAnswerMs !== undefined ? state : { ...state, firstAnswerMs: Math.max(0, now - state.startedAt) };
}

/** The local funnel shown on About and attached to a bug report only if the user chooses. */
export function onboardingFunnel(state: OnboardingState): {
  reached: OnboardingStep;
  completed: number;
  skipped: OnboardingStep[];
  secondsPerStep: Partial<Record<OnboardingStep, number>>;
  firstAnswerSeconds: number | null;
  finished: boolean;
} {
  const secondsPerStep: Partial<Record<OnboardingStep, number>> = {};
  for (const [k, v] of Object.entries(state.timings))
    secondsPerStep[k as OnboardingStep] = Math.round((v ?? 0) / 100) / 10;
  return {
    reached: state.furthest,
    completed: state.completed.length,
    skipped: state.skipped,
    secondsPerStep,
    firstAnswerSeconds: state.firstAnswerMs === undefined ? null : Math.round(state.firstAnswerMs / 100) / 10,
    finished: !!state.finishedAt,
  };
}

// ---- audio readiness: decisions here, probes in platform/win32

export interface SpeakerState {
  muted: boolean;
  /** 0..1 */
  volume: number;
}

/** A one-click fix when the user would see Clicky talk and hear nothing. */
export function speakerAdvice(s: SpeakerState): { fix: 'unmute' | 'raise' | null; line: string } {
  if (s.muted)
    return { fix: 'unmute', line: "Your sound is muted, so you'd see me talk and hear nothing. One click fixes it." };
  if (s.volume < 0.05) return { fix: 'raise', line: 'Your volume is at zero. Set it to 50%?' };
  return { fix: null, line: 'Sound is on.' };
}

export interface MicState {
  deviceName: string;
  /** How long the meter has shown no sound while testing. */
  silentMs: number;
  /** Other inputs the user could switch to. */
  others: string[];
}

/** A warning or a suggestion for the mic test, or null when it's fine. */
export function micAdvice(m: MicState): string | null {
  if (m.silentMs >= 3000) {
    const next = m.others.find((o) => o !== m.deviceName);
    return next
      ? `I can't hear anything from ${m.deviceName}. Try ${next}?`
      : `I can't hear anything from ${m.deviceName}. Check it isn't muted in Windows.`;
  }
  if (/hands-?free|\bhf\b|headset.*bluetooth|bluetooth.*headset/i.test(m.deviceName))
    return "That's a Bluetooth headset mic. They sound muffled, so I may mishear you; the laptop or a wired mic works better.";
  return null;
}

// ---- starter helpers, suggested from the "about you" answer (never started on their own)

export interface StarterHelper {
  name: string;
  role: string;
  purpose: string;
  /** A first thing to ask it, shown as a button; nothing runs until the user presses it. */
  firstAsk: string;
}

const STARTERS: { re: RegExp; helper: StarterHelper }[] = [
  {
    re: /e-?mail|outlook|gmail|inbox|client|support/i,
    helper: {
      name: 'Inbox Desk',
      role: 'Email Triage',
      purpose: 'Sorts your email and drafts replies for you to check.',
      firstAsk: "What's waiting on me in my inbox?",
    },
  },
  {
    re: /start-?up|founder|pitch|investor|fundrais|deck/i,
    helper: {
      name: 'Pitch Lab',
      role: 'Deck Writer',
      purpose: 'Drafts and tightens pitch decks and investor updates.',
      firstAsk: 'Draft an outline for my next investor update.',
    },
  },
  {
    re: /recruit|hiring|job|career|linkedin|interview/i,
    helper: {
      name: 'Job Scout',
      role: 'Role Finder',
      purpose: 'Finds roles that fit you and keeps them in a sheet.',
      firstAsk: 'Find five roles that fit me and put them in a sheet.',
    },
  },
  {
    re: /cod(e|ing)|develop|program|engineer|software|github|repo/i,
    helper: {
      name: 'Repo Desk',
      role: 'Code Helper',
      purpose: 'Keeps an eye on your pull requests and issues.',
      firstAsk: 'Which of my pull requests need me?',
    },
  },
  {
    re: /research|analy|market|competit|report|writ/i,
    helper: {
      name: 'Research Lead',
      role: 'Researcher',
      purpose: 'Looks things up across sites and writes short reports.',
      firstAsk: 'Write a one-page brief on my top three competitors.',
    },
  },
  {
    re: /learn|student|study|course|exam|class/i,
    helper: {
      name: 'Study Coach',
      role: 'Study Planner',
      purpose: 'Turns your course material into plans and practice questions.',
      firstAsk: 'Make me a study plan for this week.',
    },
  },
  {
    re: /shop|store|order|e-?commerce|sell|etsy|amazon/i,
    helper: {
      name: 'Shop Watch',
      role: 'Store Helper',
      purpose: 'Checks orders, stock and reviews in your shop.',
      firstAsk: 'Summarize new orders and reviews.',
    },
  },
];

/** Up to two helpers that fit what the user said they do. They're offered, never auto-started. */
export function starterHelpers(about: string, roster: readonly ClickyAgent[] = [], userName?: string): StarterHelper[] {
  const out: StarterHelper[] = [];
  for (const s of STARTERS) {
    if (out.length >= 2) break;
    if (!s.re.test(about)) continue;
    const taken = [
      ...roster,
      ...out.map((h, i) => ({
        slug: `s${i}`,
        name: h.name,
        role: h.role,
        purpose: h.purpose,
        createdAt: 0,
        standing: [],
        notes: [],
      })),
    ];
    if (clickyNameProblem(s.helper.name, taken, userName)) continue;
    out.push(s.helper);
  }
  return out;
}
