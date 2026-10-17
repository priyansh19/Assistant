import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findModel } from './catalog';
import { ModelFiles } from './files';

const moonshine = findModel('moonshine-tiny')!;

function place(root: string): string {
  const d = join(root, moonshine.dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'tokens.txt'), 'a');
  writeFileSync(join(d, 'model.onnx'), 'x');
  return d;
}

describe('ModelFiles', () => {
  it('uses the model that shipped in the installer when nothing was downloaded', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'clicky-models-'));
    const own = join(tmp, 'user');
    const shipped = join(tmp, 'bundle');
    const files = new ModelFiles(own, shipped);
    expect(files.isInstalled(moonshine)).toBe(false);
    expect(files.dirOf(moonshine)).toBe(join(own, moonshine.dir));
    const d = place(shipped);
    expect(files.isInstalled(moonshine)).toBe(true);
    expect(files.isBundled(moonshine)).toBe(true);
    expect(files.dirOf(moonshine)).toBe(d);
  });

  it("prefers the user's own download over the shipped copy", () => {
    const tmp = mkdtempSync(join(tmpdir(), 'clicky-models-'));
    place(join(tmp, 'bundle'));
    const d = place(join(tmp, 'user'));
    const files = new ModelFiles(join(tmp, 'user'), join(tmp, 'bundle'));
    expect(files.dirOf(moonshine)).toBe(d);
    expect(files.isBundled(moonshine)).toBe(false);
  });

  it('ignores a half-copied folder', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'clicky-models-'));
    mkdirSync(join(tmp, 'bundle', moonshine.dir), { recursive: true });
    expect(new ModelFiles(join(tmp, 'user'), join(tmp, 'bundle')).isInstalled(moonshine)).toBe(false);
  });
});
