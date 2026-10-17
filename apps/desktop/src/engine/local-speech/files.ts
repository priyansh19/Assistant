import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelSpec } from './catalog';

/**
 * Where on-device models live and whether one is complete. `root` is the user's own folder
 * (downloads go there); `bundled` is the read-only folder of models that shipped in the installer,
 * used when the user hasn't downloaded their own copy. Read-only, so the engine process can use it;
 * downloads are main's job (main/local-speech/store.ts).
 */
export class ModelFiles {
  constructor(
    readonly root: string,
    readonly bundled = '',
  ) {}

  /** The folder the model is in: the downloaded copy, else the bundled one, else where a download goes. */
  dirOf(spec: ModelSpec): string {
    const own = join(this.root, spec.dir);
    if (complete(own) || !this.bundled) return own;
    const shipped = join(this.bundled, spec.dir);
    return complete(shipped) ? shipped : own;
  }

  isInstalled(spec: ModelSpec): boolean {
    return complete(this.dirOf(spec));
  }

  /** Shipped with Clicky (and not replaced by a download), so it can't be removed. */
  isBundled(spec: ModelSpec): boolean {
    return !!this.bundled && this.dirOf(spec) === join(this.bundled, spec.dir);
  }
}

function complete(d: string): boolean {
  try {
    return existsSync(join(d, 'tokens.txt')) && readdirSync(d).some((f) => f.endsWith('.onnx'));
  } catch {
    return false;
  }
}
