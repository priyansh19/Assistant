/**
 * Guided walkthroughs (click to advance). The answer model rings the first thing to click with
 * [TARGET:x,y,r:label] (or [HOVER:…] for hover menus) and says that one step. Clicky then waits:
 * only the user's own click inside the ring (or the pointer resting on a hover target) advances
 * the walkthrough. After a hit it waits for the screen to settle, takes a fresh screenshot and asks
 * the model for the next step, until the task is done, the round budget runs out, or the user
 * wanders off, in which case it ends quietly without nagging.
 *
 * Code, not the model, decides when a step is done, and code enforces the round limit (the prompt
 * states it too). Everything here is pure: the orchestrator feeds in input events and the clock.
 */

import {
  mapPointToDisplay,
  fromThousandths,
  type CaptureGeometry,
  type MappedPoint,
  type Rect,
} from './coordinates.js';
import type { GuideTag } from './point-parser.js';

export const GUIDE_DEFAULTS = {
  /** Targets one walkthrough may arm, the first answer's included. */
  maxRounds: 8,
  /** An armed target nobody clicks is dropped silently after this long. */
  idleTimeoutMs: 45_000,
  /** After a hit, an app or window switch this soon is the click's own effect, not the user leaving. */
  graceMs: 1500,
  /** A hover target completes when the pointer rests inside it this long. */
  hoverRestMs: 700,
  /**
   * After a step with no target (manual work, or a nudge), the walkthrough waits this long for the
   * user to say "next" before it counts as finished.
   */
  parkMs: 120_000,
  /** Wait this long after a hit before looking at the screen again. */
  settleMs: 600,
  /** Extra screenshots (this far apart) while the screen is still changing, at most `settleTries`. */
  settleStepMs: 300,
  settleTries: 3,
  /** Clicks this close outside the ring still count (event-space px). */
  tolerancePx: 6,
  /** Ring radius when the model gave none, in thousandths of the screenshot width. */
  defaultRadius: 25,
  /** The ring is kept between these sizes on the display (DIP), whatever the model asked for. */
  minRadiusDip: 14,
  maxRadiusDip: 120,
} as const;

export type GuideSettings = { -readonly [K in keyof typeof GUIDE_DEFAULTS]: number };

/** A target mapped onto a display, ready to ring. */
export interface GuideTarget {
  kind: 'click' | 'hover';
  at: MappedPoint;
  /** Ring radius in DIP on that display. */
  radius: number;
  label: string;
  /** What Clicky said for this step (kept for the walkthrough history). */
  instruction: string;
}

/**
 * Where clicks count, in the same coordinate space as the input events the app reports (the app
 * converts DIP to that space and may snap the centre onto the real control, with its bounds).
 */
export interface HitArea {
  x: number;
  y: number;
  r: number;
  /** The control's bounds, when known: any click inside counts even outside the ring. */
  box?: Rect;
}

/**
 * Map a model's target onto a display. The radius is in thousandths of the screenshot width, like
 * CIRCLE, and is clamped to a ring that is visible but can't swallow half the screen.
 */
export function mapGuideTag(
  tag: GuideTag,
  captures: readonly CaptureGeometry[],
  settings: Pick<GuideSettings, 'defaultRadius' | 'minRadiusDip' | 'maxRadiusDip'> = GUIDE_DEFAULTS,
): { ok: true; target: Omit<GuideTarget, 'instruction'> } | { ok: false; detail: string } {
  const mapped = mapPointToDisplay(fromThousandths(tag, captures), captures);
  if (!mapped.ok) return { ok: false, detail: `${mapped.reason}: ${mapped.detail}` };
  const cap = captures[(tag.screen ?? 1) - 1];
  const width = cap?.display.bounds.width ?? 0;
  const r = ((tag.r ?? settings.defaultRadius) / 1000) * width;
  const radius = Math.min(settings.maxRadiusDip, Math.max(settings.minRadiusDip, Number.isFinite(r) ? r : 0));
  return { ok: true, target: { kind: tag.kind, at: mapped.point, radius, label: tag.label || 'here' } };
}

/** How far a point is from the target: 0 inside the control's box, else the distance from the ring's centre. */
export function hitDistance(area: HitArea, x: number, y: number): number {
  const b = area.box;
  if (b && x >= b.x && y >= b.y && x <= b.x + b.width && y <= b.y + b.height) return 0;
  return Math.hypot(x - area.x, y - area.y);
}

export function isHit(area: HitArea, x: number, y: number, tolerancePx: number = GUIDE_DEFAULTS.tolerancePx): boolean {
  return hitDistance(area, x, y) <= area.r + tolerancePx;
}

/** Mouse input as the app reports it. Only a left-button press can complete or miss a click target. */
export type GuideInput =
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; at: number }
  | { kind: 'move'; x: number; y: number; at: number };

export type GuideStage = 'armed' | 'settling' | 'asking' | 'parked' | 'ended';

export type GuideEndReason =
  'done' | 'off-target' | 'idle' | 'round-limit' | 'superseded' | 'cancelled' | 'app-switch' | 'no-target' | 'failed';

/** What an input or a tick means for the walkthrough. */
export type GuideDecision =
  | { type: 'none' }
  /** The user did the step: stop ringing, settle, recapture, ask for the next step. */
  | { type: 'hit'; distance: number; hover: boolean }
  /** A click elsewhere: the guide ends, with no nagging. */
  | { type: 'miss'; distance: number }
  | { type: 'idle' }
  /** The user clicked again while the next step was being worked out. */
  | { type: 'acted' };

interface Armed {
  target: GuideTarget;
  area: HitArea;
  armedAt: number;
  /** When the pointer entered a hover target (null while outside). */
  restSince: number | null;
}

/** One walkthrough, from its first target to its end. */
export class GuideSession {
  readonly settings: GuideSettings;
  stage: GuideStage = 'armed';
  /** Targets armed so far. */
  armedCount = 0;
  /** What has happened, oldest first ("Clicked Add Modifier"), for the follow-up prompt. */
  readonly history: string[] = [];
  /** The step the user just completed. */
  previous: { label: string; kind: 'click' | 'hover' | 'manual'; instruction: string } | null = null;
  /** When the last step was completed. */
  lastHitAt = 0;
  /** The user clicked again while the next step was being worked out. */
  actedWhileAsking = false;
  /** A follow-up was already redone once for this step because the user acted meanwhile. */
  refreshedThisStep = false;
  endReason: GuideEndReason | null = null;
  private armed: Armed | null = null;
  private parkedAt = 0;
  /** The last step that had no target (what the user was asked to do by hand). */
  private parkedStep = '';

  constructor(
    /** The user's original request ("how do I add a modifier"). */
    readonly goal: string,
    /** The app in front when the walkthrough started (process name), if known. */
    public app: string | null,
    settings: Partial<GuideSettings> = {},
  ) {
    this.settings = { ...GUIDE_DEFAULTS, ...settings };
  }

  get target(): GuideTarget | null {
    return this.armed?.target ?? null;
  }

  /** Targets the model may still arm after the one it is about to choose (0: finish, no target). */
  get remaining(): number {
    return Math.max(0, this.settings.maxRounds - this.armedCount);
  }

  /** May another target be armed? The round limit is enforced here, not only in the prompt. */
  canArm(): boolean {
    return this.stage !== 'ended' && this.armedCount < this.settings.maxRounds;
  }

  arm(target: GuideTarget, area: HitArea, now: number): boolean {
    if (!this.canArm()) return false;
    this.armed = { target, area, armedAt: now, restSince: null };
    this.armedCount++;
    this.stage = 'armed';
    this.actedWhileAsking = false;
    this.refreshedThisStep = false;
    return true;
  }

  /** Feed a mouse event. */
  input(ev: GuideInput): GuideDecision {
    if (this.stage === 'settling' || this.stage === 'asking') {
      if (ev.kind === 'click' && (ev.button ?? 'left') === 'left') {
        this.actedWhileAsking = true;
        return { type: 'acted' };
      }
      return { type: 'none' };
    }
    const a = this.armed;
    if (this.stage !== 'armed' || !a) return { type: 'none' };
    const tol = this.settings.tolerancePx;
    if (ev.kind === 'click') {
      if ((ev.button ?? 'left') !== 'left') return { type: 'none' };
      const distance = hitDistance(a.area, ev.x, ev.y);
      if (distance <= a.area.r + tol) return this.complete(ev.at, distance, false);
      this.end('off-target');
      this.history.push(
        `They were asked to click "${a.target.label}" but clicked somewhere else, so the guide ended; that step is likely not done.`,
      );
      return { type: 'miss', distance: Math.round(distance) };
    }
    if (a.target.kind !== 'hover') return { type: 'none' };
    if (!isHit(a.area, ev.x, ev.y, tol)) {
      a.restSince = null;
      return { type: 'none' };
    }
    a.restSince ??= ev.at;
    return this.tick(ev.at);
  }

  /**
   * The model gave a step with no target (manual work, a nudge, or a nudge to finish): wait a while
   * for the user to say "next" before treating the walkthrough as finished.
   */
  park(instruction: string, now: number): void {
    if (this.stage === 'ended') return;
    this.armed = null;
    this.stage = 'parked';
    this.parkedAt = now;
    this.parkedStep = instruction;
  }

  /** A new spoken or typed question continues a parked walkthrough when it's "next", "done" and the like. */
  resumes(question: string, now: number): boolean {
    if (this.stage !== 'parked' || now - this.parkedAt > this.settings.parkMs) return false;
    if (!CONTINUE.test(question.trim())) return false;
    this.previous = { label: 'the manual step', kind: 'manual', instruction: this.parkedStep };
    this.history.push(`Said they finished the step: ${this.parkedStep || 'no words'}`);
    this.lastHitAt = now;
    this.stage = 'settling';
    this.refreshedThisStep = false;
    this.actedWhileAsking = false;
    return true;
  }

  /** Feed the clock: hover rests complete and idle targets drop here. */
  tick(now: number): GuideDecision {
    if (this.stage === 'parked' && now - this.parkedAt > this.settings.parkMs) {
      this.end('done');
      return { type: 'none' };
    }
    const a = this.armed;
    if (this.stage !== 'armed' || !a) return { type: 'none' };
    if (a.target.kind === 'hover' && a.restSince !== null && now - a.restSince >= this.settings.hoverRestMs)
      return this.complete(now, 0, true);
    if (now - a.armedAt >= this.settings.idleTimeoutMs) {
      this.end('idle');
      return { type: 'idle' };
    }
    return { type: 'none' };
  }

  private complete(now: number, distance: number, hover: boolean): GuideDecision {
    const a = this.armed;
    if (!a) return { type: 'none' };
    this.previous = { label: a.target.label, kind: a.target.kind, instruction: a.target.instruction };
    this.history.push(
      `${hover ? 'Hovered' : 'Clicked'} "${a.target.label}" (step: ${a.target.instruction || 'no words'})`,
    );
    this.armed = null;
    this.lastHitAt = now;
    this.stage = 'settling';
    return { type: 'hit', distance: Math.round(distance), hover };
  }

  /** The follow-up request went out. */
  asking(): void {
    if (this.stage !== 'ended') this.stage = 'asking';
  }

  /**
   * The user acted while the next step was being worked out: redo the follow-up on a fresh
   * screenshot, but only once per step, so a busy user can't cause an endless refresh loop.
   */
  shouldRefresh(): boolean {
    if (!this.actedWhileAsking || this.refreshedThisStep || this.stage === 'ended') return false;
    this.refreshedThisStep = true;
    return true;
  }

  /**
   * The app in front changed since the walkthrough was last looking. A change right after the
   * user's click is the click's own effect (a dialog, a new window) and the guide follows it; a
   * change long after it means the user went elsewhere.
   */
  appChanged(app: string | null, now: number): 'same' | 'followed' | 'left' {
    if (!app || !this.app || app.toLowerCase() === this.app.toLowerCase()) {
      if (app) this.app = app;
      return 'same';
    }
    if (now - this.lastHitAt <= this.settings.graceMs) {
      this.app = app;
      return 'followed';
    }
    return 'left';
  }

  end(reason: GuideEndReason): void {
    if (this.stage === 'ended') return;
    this.stage = 'ended';
    this.endReason = reason;
    this.armed = null;
  }
}

/** "Next", "done", "okay what now": the user finished a manual step and wants the next one. */
const CONTINUE =
  /^(?:(?:hey\s+)?click(?:y|ey)\W+)?(?:ok(?:ay)?\W+|alright\W+|so\W+)?(?:next|continue|carry on|go on|keep going|done|i(?:'ve| have)? done (?:it|that)|i did (?:it|that)|finished|what now|what'?s next|what next|then what|now what)\b/i;

/**
 * Two screenshots taken a moment apart look the same: the screen has settled after the click.
 * Compared by encoded size, which changes whenever an animation, menu or page load is still running.
 */
export function screenSettled(a: readonly number[], b: readonly number[], tolerance = 0.015): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return a.every((x, i) => {
    const y = b[i] ?? 0;
    return Math.abs(x - y) <= Math.max(x, y) * tolerance;
  });
}

/** Rules the answer model follows on a walkthrough's first answer (added to the system prompt). */
export const GUIDE_OFFER_RULES = `Guided walkthroughs:
- When the user asks how to do something in an app on screen that takes several clicks ("how do I
  add a modifier", "walk me through turning on dark mode"), guide them one step at a time instead
  of listing every step. Start with [TARGET:x,y,r:label] on the first thing to click, where x,y is
  its centre and r is a radius that just covers it, all in thousandths (r of the width, usually 15
  to 40). Then say only that one step in one short sentence ("Click Add Modifier to open the
  list."). Clicky waits for their click there, looks at the screen again and asks you for the
  next step.
- Use [HOVER:x,y,r:label] instead when the step is resting the pointer on something that opens on
  hover.
- One action per target. Never ring something they have to drag, type into, or adjust by eye:
  point at it and explain instead.
- A one-click answer ("where is Save?") is a POINT, not a walkthrough.`;

/** Rules for every follow-up step of a walkthrough (they replace the usual opening-tag rule). */
export const GUIDE_FOLLOW_UP_RULES = `This is a guided walkthrough step. These rules come first:
- The new screenshot is the truth. Treat the step the user just did as done unless the screen
  clearly shows it did not work.
- Use what earlier steps already found. Do not send the user back to a page, tab or menu from the
  history unless the new screenshot shows it is needed again. Never restart a general tour, never
  ask them to repeat a step that already looks done, and never ring the same control twice with a
  vague label like "same step".
- If the screen looks the same as before the click (the menu you ringed is now open, or a toggle
  flipped), that was a reveal or a toggle, not the action itself: do not ring it again. Move to the
  next item that actually does the action, or finish.
- Each reply does exactly one of these:
  1. the next step: start with one [TARGET:x,y,r:label] (or [HOVER:x,y,r:label]) on the one thing to
     click, then say only that step in one short sentence;
  2. a manual step Clicky can't watch (typing into a field, dragging, a slider, choosing by taste):
     start with [POINT:x,y:label] on it, say what to do, and tell them to hold the key and say
     "next" when it's done; no TARGET;
  3. you can't see a change: start with [POINT:none] and give one short plain nudge; no TARGET;
  4. the task is done: start with [POINT:none] and say so in one short sentence; no TARGET.
- One immediate action per TARGET sentence. Never chain "click this, then that".
- Never mention tags, steps left or this list. No preamble, no summary, no future checklist.`;

/** The question for a follow-up step: the goal, where the walkthrough is, and what just happened. */
export function guideFollowUpQuestion(session: GuideSession): string {
  const prev = session.previous;
  const lines = [
    `Continue the guided walkthrough. The user's request: "${session.goal.slice(0, 300)}".`,
    `This is guided step ${session.armedCount + 1} of at most ${session.settings.maxRounds}.`,
  ];
  if (prev)
    lines.push(
      prev.kind === 'hover'
        ? `They just rested the pointer on the hover target "${prev.label}". Treat that as done.`
        : prev.kind === 'manual'
          ? `They said they finished the step you gave them by hand ("${prev.instruction.slice(0, 200)}"). Check the screenshot and continue.`
          : `They just clicked inside the target "${prev.label}". Treat that as done.`,
    );
  lines.push(
    session.history.length
      ? `What has happened in this walkthrough so far, oldest first:\n${session.history
          .slice(-12)
          .map((h) => `- ${h}`)
          .join('\n')}`
      : 'Completed guided steps: none yet.',
  );
  if (session.actedWhileAsking)
    lines.push(
      'Important: they clicked again while you were thinking. Treat the new screenshot as the only truth. They may already have done the next thing; do not ask them to repeat anything that already looks done.',
    );
  const left = session.remaining;
  lines.push(
    left > 0
      ? `You may ring at most ${left} more target${left === 1 ? '' : 's'} in this walkthrough, including this reply's.`
      : 'You may not ring any more targets: give one short sentence to finish or hand over, with [POINT:none] and no TARGET.',
  );
  return lines.join('\n');
}
