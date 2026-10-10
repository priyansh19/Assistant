import type { Platform } from './types';
import { win32Platform } from './win32';

export type { HoldKeyHook, Platform } from './types';

/** The only place that branches on the OS. Windows is the only platform built so far. */
export function getPlatform(): Platform {
  switch (process.platform) {
    case 'win32':
      return win32Platform;
    default:
      throw new Error(`Clicky does not support ${process.platform} yet (Windows-first, see docs/development-plan.md).`);
  }
}
