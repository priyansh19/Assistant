import type { Platform } from './types';
import { win32Platform } from './win32';
import { opensWithAnApp as win32OpensWithAnApp } from './win32/file-types';

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

/** True if some app on this PC opens this file (always true off Windows, for now). */
export function opensWithAnApp(path: string): boolean {
  return process.platform === 'win32' ? win32OpensWithAnApp(path) : true;
}
