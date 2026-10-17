import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findFiles, listFiles, mapKnownFolder, moveFiles } from './files';

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

describe('findFiles', () => {
  it('finds files by every word of their name, deep in folders, skipping build output', () => {
    const root = mkdtempSync(join(tmpdir(), 'clicky-find-'));
    mkdirSync(join(root, 'jobs', 'uae', 'active'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'jobs', 'uae', 'active', 'Priyansh Resume UAE.pdf'), 'x');
    writeFileSync(join(root, 'jobs', 'cover letter.docx'), 'x');
    writeFileSync(join(root, 'node_modules', 'pkg', 'resume uae.js'), 'x');
    const hits = findFiles('resume uae', [root]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(join('jobs', 'uae', 'active', 'Priyansh Resume UAE.pdf'));
    expect(findFiles('invoice', [root])).toEqual([]);
  });
});
