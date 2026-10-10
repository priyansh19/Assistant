/**
 * Interaction states (AGENTS.md rule 4). The full state machine with transitions,
 * ids and cancellation lands in the next Phase 1 step; the skeleton only fixes the vocabulary.
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
