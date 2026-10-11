import { screen } from 'electron';
import type { InputAction } from '@clicky/core';
import type { InputDriver } from '../platform/types';

/**
 * Carries out the engine's mouse and keyboard requests (agent mode, dictation). Points arrive as
 * global DIP on a display; Windows wants physical pixels, which only main's screen API can map
 * correctly across displays with different scaling.
 */
export class InputHost {
  constructor(private readonly driver: InputDriver | null) {}

  /** Start the helper in the background so the first dictation doesn't wait for it. */
  warm(): void {
    this.driver?.warm();
  }

  async run(action: InputAction): Promise<void> {
    const d = this.driver;
    if (!d) throw new Error('Clicky cannot use the mouse and keyboard on this system.');
    switch (action.kind) {
      case 'click': {
        const p = screen.dipToScreenPoint(action.at.global);
        return d.click(p.x, p.y, action.button, action.count);
      }
      case 'scroll': {
        const p = screen.dipToScreenPoint(action.at.global);
        return d.scroll(p.x, p.y, action.amount);
      }
      case 'type':
        return d.type(action.text);
      case 'keys':
        return d.keys(action.keys);
    }
  }

  dispose(): void {
    this.driver?.dispose();
  }
}
