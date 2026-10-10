/**
 * Interaction state machine (AGENTS.md rule 4, plan §3.1).
 *
 *   idle → listening → transcribing → thinking → speaking → idle
 *                 ↘ cancelled / error (from any active state)
 *
 * Every interaction has an id and an AbortController. Cancelling or failing aborts it, so
 * every in-flight request tied to that signal stops, and nothing late from an old interaction
 * can be mistaken for the current one.
 */

export const INTERACTION_STATES = [
  'idle',
  'listening',
  'transcribing',
  'thinking',
  'speaking',
  'cancelled',
  'error',
] as const;

export type InteractionState = (typeof INTERACTION_STATES)[number];

/** States in which the overlay should show the "capture active" indicator. */
export function isCapturing(state: InteractionState): boolean {
  return state === 'listening';
}

/** States where nothing is running and a key press starts a fresh interaction. */
export function isResting(state: InteractionState): boolean {
  return state === 'idle' || state === 'cancelled' || state === 'error';
}

export type InteractionEvent =
  | { type: 'keyDown' }
  | { type: 'keyUp' }
  | { type: 'transcriptFinal'; text: string }
  | { type: 'firstAudio' }
  | { type: 'speechDone' }
  | { type: 'cancel'; reason: string }
  | { type: 'fail'; reason: string };

export interface Interaction {
  readonly id: string;
  readonly state: InteractionState;
  readonly signal: AbortSignal;
  readonly transcript: string | null;
  /** Why it ended in `cancelled` or `error`. */
  readonly endReason: string | null;
}

export interface Transition {
  interactionId: string;
  from: InteractionState;
  to: InteractionState;
  event: InteractionEvent['type'];
}

type Listener = (t: Transition, interaction: Interaction) => void;

interface Mutable {
  id: string;
  state: InteractionState;
  abort: AbortController;
  transcript: string | null;
  endReason: string | null;
}

export class InteractionMachine {
  private current: Mutable | null = null;
  private readonly listeners = new Set<Listener>();
  private seq = 0;

  constructor(private readonly newId: () => string = () => `i${Date.now().toString(36)}-${++this.seq}`) {}

  get state(): InteractionState {
    return this.current?.state ?? 'idle';
  }

  get interaction(): Interaction | null {
    return this.current ? this.snapshot(this.current) : null;
  }

  onTransition(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Apply an event. Returns the transition, or null if the event doesn't apply in the current
   * state (for example a late `firstAudio` after the user cancelled). Ignored events are normal
   * and must not be treated as errors by callers.
   */
  dispatch(event: InteractionEvent): Transition | null {
    const cur = this.current;
    const state = this.state;

    if (event.type === 'keyDown') {
      if (state === 'listening') return null; // auto-repeat or duplicate
      // A press while busy interrupts the current answer and starts a new question.
      if (cur && !isResting(state)) this.end(cur, 'cancelled', 'interrupted by a new question', 'keyDown');
      const next: Mutable = {
        id: this.newId(),
        state: 'idle',
        abort: new AbortController(),
        transcript: null,
        endReason: null,
      };
      this.current = next;
      return this.move(next, 'listening', 'keyDown');
    }

    if (!cur || isResting(state)) return null;

    switch (event.type) {
      case 'keyUp':
        return state === 'listening' ? this.move(cur, 'transcribing', 'keyUp') : null;
      case 'transcriptFinal': {
        if (state !== 'transcribing') return null;
        const text = event.text.trim();
        if (!text) return this.end(cur, 'cancelled', 'no speech detected', 'transcriptFinal');
        cur.transcript = text;
        return this.move(cur, 'thinking', 'transcriptFinal');
      }
      case 'firstAudio':
        return state === 'thinking' ? this.move(cur, 'speaking', 'firstAudio') : null;
      case 'speechDone':
        return state === 'speaking' ? this.move(cur, 'idle', 'speechDone') : null;
      case 'cancel':
        return this.end(cur, 'cancelled', event.reason, 'cancel');
      case 'fail':
        return this.end(cur, 'error', event.reason, 'fail');
    }
  }

  private end(cur: Mutable, to: 'cancelled' | 'error', reason: string, event: InteractionEvent['type']): Transition {
    cur.endReason = reason;
    cur.abort.abort(new Error(`${to}: ${reason}`));
    return this.move(cur, to, event);
  }

  private move(cur: Mutable, to: InteractionState, event: InteractionEvent['type']): Transition {
    const t: Transition = { interactionId: cur.id, from: cur.state, to, event };
    cur.state = to;
    const snap = this.snapshot(cur);
    for (const fn of this.listeners) fn(t, snap);
    return t;
  }

  private snapshot(cur: Mutable): Interaction {
    return {
      id: cur.id,
      state: cur.state,
      signal: cur.abort.signal,
      transcript: cur.transcript,
      endReason: cur.endReason,
    };
  }
}
