import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles, mapKnownFolder, moveFiles } from './files';

describe('agent file operations', () => {
  it('lists, moves by pattern without replacing, and maps the usual Desktop path', () => {
    const d = mkdtempSync(join(tmpdir(), 'clicky-files-'));
    for (const n of ['a.pdf', 'b.PDF', 'c.txt']) writeFileSync(join(d, n), 'x');
    writeFileSync(join(d, 'PDFs-existing.txt'), 'y');
    expect(listFiles(d).some((l) => l.startsWith('a.pdf — '))).toBe(true);
    const to = join(d, 'PDFs');
    expect(moveFiles(d, '*.pdf', to, false)).toBe(2);
    expect(readdirSync(to).sort()).toEqual(['a.pdf', 'b.PDF']);
    writeFileSync(join(d, 'a.pdf'), 'z');
    expect(moveFiles(d, 'a.pdf', to, true)).toBe(1);
    expect(readdirSync(to).sort()).toEqual(['a (2).pdf', 'a.pdf', 'b.PDF']);
    expect(
      mapKnownFolder(String.raw`C:\Users\me\Desktop\x`, [String.raw`Desktop folder: C:\Users\me\OneDrive\Desktop`]),
    ).toBe(String.raw`C:\Users\me\OneDrive\Desktop\x`);
  });
});
