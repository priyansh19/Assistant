import { join } from 'node:path';
import { app } from 'electron';
import { BUILTIN_BRAIN } from '@clicky/core';

/**
 * Folders of what shipped inside the installer (scripts/fetch-bundle.mjs fills apps/desktop/bundle,
 * electron-builder copies it into resources/). In dev they are read from apps/desktop/bundle.
 */
function bundleRoot(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'bundle');
}

export const bundlePaths = {
  /** Speech-to-text models and voices, one folder each (same layout as userData/models). */
  models: (): string => join(bundleRoot(), 'models'),
  /** The built-in answer model's two .gguf files. */
  brain: (): string => join(bundleRoot(), BUILTIN_BRAIN.dir),
  /** llama.cpp's server and its libraries. */
  server: (): string => join(bundleRoot(), BUILTIN_BRAIN.serverDir),
};
