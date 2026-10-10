import { describe, expect, it } from 'vitest';
import { INTERACTION_STATES, InteractionMachine, isCapturing, isResting, type Transition } from './interaction.js';

function machine() {
  let n = 0;
  const m = new InteractionMachine(() => `id${++n}`);
  const log: Transition[] = [];
  m.onTransition((t) => log.push(t));
  return { m, log };
}

describe('state helpers', () => {
  it('only reports capture while listening', () => {
    expect(INTERACTION_STATES.filter(isCapturing)).toEqual(['listening']);
  });
  it('treats idle, cancelled and error as resting', () => {
    expect(INTERACTION_STATES.filter(isResting)).toEqual(['idle', 'cancelled', 'error']);
  });
});

describe('InteractionMachine', () => {
  it('runs the happy path', () => {
    const { m, log } = machine();
    m.dispatch({ type: 'keyDown' });
    m.dispatch({ type: 'keyUp' });
    m.dispatch({ type: 'transcriptFinal', text: ' where is export? ' });
    m.dispatch({ type: 'firstAudio' });
    m.dispatch({ type: 'speechDone' });
    expect(log.map((t) => t.to)).toEqual(['listening', 'transcribing', 'thinking', 'speaking', 'idle']);
    expect(m.interaction?.transcript).toBe('where is export?');
    expect(m.interaction?.signal.aborted).toBe(false);
  });

  it('ignores events that do not apply, including late ones', () => {
    const { m } = machine();
    expect(m.dispatch({ type: 'keyUp' })).toBeNull();
    expect(m.dispatch({ type: 'firstAudio' })).toBeNull();
    m.dispatch({ type: 'keyDown' });
    expect(m.dispatch({ type: 'keyDown' })).toBeNull(); // auto-repeat
    expect(m.dispatch({ type: 'firstAudio' })).toBeNull(); // too early
    expect(m.state).toBe('listening');
  });

  it('cancels with Esc and aborts in-flight work', () => {
    const { m } = machine();
    m.dispatch({ type: 'keyDown' });
    m.dispatch({ type: 'keyUp' });
    const signal = m.interaction?.signal;
    m.dispatch({ type: 'cancel', reason: 'escape' });
    expect(m.state).toBe('cancelled');
    expect(signal?.aborted).toBe(true);
    expect(m.interaction?.endReason).toBe('escape');
    // A late result from the cancelled interaction changes nothing.
    expect(m.dispatch({ type: 'transcriptFinal', text: 'late' })).toBeNull();
  });

  it('never ends a failure in a state that looks successful', () => {
    const { m } = machine();
    m.dispatch({ type: 'keyDown' });
    m.dispatch({ type: 'keyUp' });
    m.dispatch({ type: 'transcriptFinal', text: 'hi' });
    m.dispatch({ type: 'fail', reason: 'llm timeout' });
    expect(m.state).toBe('error');
    expect(m.dispatch({ type: 'firstAudio' })).toBeNull();
    expect(m.dispatch({ type: 'speechDone' })).toBeNull();
    expect(m.state).toBe('error');
  });

  it('cancels when nothing was said', () => {
    const { m } = machine();
    m.dispatch({ type: 'keyDown' });
    m.dispatch({ type: 'keyUp' });
    m.dispatch({ type: 'transcriptFinal', text: '   ' });
    expect(m.state).toBe('cancelled');
    expect(m.interaction?.endReason).toBe('no speech detected');
  });

  it('a new press while answering interrupts and starts a new interaction', () => {
    const { m, log } = machine();
    m.dispatch({ type: 'keyDown' });
    m.dispatch({ type: 'keyUp' });
    m.dispatch({ type: 'transcriptFinal', text: 'first' });
    m.dispatch({ type: 'firstAudio' });
    const first = m.interaction;
    m.dispatch({ type: 'keyDown' });
    expect(first?.signal.aborted).toBe(true);
    expect(m.interaction?.id).toBe('id2');
    expect(m.state).toBe('listening');
    expect(log.slice(-2).map((t) => [t.interactionId, t.to])).toEqual([
      ['id1', 'cancelled'],
      ['id2', 'listening'],
    ]);
  });

  it('starts fresh after an error or a cancel', () => {
    const { m } = machine();
    m.dispatch({ type: 'keyDown' });
    m.dispatch({ type: 'fail', reason: 'mic lost' });
    m.dispatch({ type: 'keyDown' });
    expect(m.state).toBe('listening');
    expect(m.interaction?.id).toBe('id2');
    expect(m.interaction?.signal.aborted).toBe(false);
  });
});
