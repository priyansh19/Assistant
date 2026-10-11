import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelSpec } from './catalog';

/**
 * Where downloaded on-device models live and whether one is complete. Read-only, so the engine
 * process can use it; downloads are main's job (main/local-speech/store.ts).
 */
export class ModelFiles {
  constructor(readonly root: string) {}

  dirOf(spec: ModelSpec): string {
    return join(this.root, spec.dir);
  }

  isInstalled(spec: ModelSpec): boolean {
    const d = this.dirOf(spec);
    try {
      return existsSync(join(d, 'tokens.txt')) && readdirSync(d).some((f) => f.endsWith('.onnx'));
    } catch {
      return false;
    }
  }
}
