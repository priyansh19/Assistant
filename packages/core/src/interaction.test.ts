import { describe, expect, it } from 'vitest';
import { INTERACTION_STATES, isCapturing } from './interaction.js';

describe('interaction states', () => {
  it('starts with idle and includes the terminal states', () => {
    expect(INTERACTION_STATES[0]).toBe('idle');
    expect(INTERACTION_STATES).toContain('cancelled');
    expect(INTERACTION_STATES).toContain('error');
  });

  it('only reports capture while listening', () => {
    expect(INTERACTION_STATES.filter(isCapturing)).toEqual(['listening']);
  });
});
