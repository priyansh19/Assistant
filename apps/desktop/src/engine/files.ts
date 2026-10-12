import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

// File operations for agent mode: reading a folder and moving or copying files by pattern. They
// never delete, and never replace a file that's already there (a copy gets " (2)" instead).

const kb = (n: number): string =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** "name — 12 KB — 2026-10-12 09:30" for each entry, folders first marked with a slash. */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) throw new Error(`no folder at ${dir}`);
  const out: { line: string; dir: boolean; name: string }[] = [];
  for (const name of readdirSync(dir).slice(0, 500)) {
    try {
      const s = statSync(join(dir, name));
      const when = s.mtime.toISOString().slice(0, 16).replace('T', ' ');
      out.push({
        name,
        dir: s.isDirectory(),
        line: s.isDirectory() ? `${name}/ — folder — ${when}` : `${name} — ${kb(s.size)} — ${when}`,
      });
    } catch {
      // unreadable entry
    }
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)).map((x) => x.line);
}

/** Folders skipped when searching: build output, caches, version control. */
const SKIP =
  /^(?:node_modules|\.git|\.cache|\.venv|venv|__pycache__|dist|build|out|target|\.next|AppData|\$Recycle\.Bin)$/i;

/**
 * Files and folders whose name contains every word of the query, searched breadth first under the
 * given folders (at most 6 levels, 40 000 entries): "path — size — modified", newest first.
 */
export function findFiles(query: string, roots: readonly string[], max = 25): string[] {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9.\s_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (!words.length) return [];
  const hits: { path: string; at: number; line: string }[] = [];
  const queue: { dir: string; depth: number }[] = roots.filter((r) => existsSync(r)).map((dir) => ({ dir, depth: 0 }));
  const seen = new Set<string>();
  let visited = 0;
  while (queue.length && visited < 40_000 && hits.length < 200) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    if (seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      visited++;
      if (name.startsWith('.') && name !== '.') continue;
      const full = join(dir, name);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      const lower = name.toLowerCase();
      if (words.every((w) => lower.includes(w))) {
        const when = s.mtime.toISOString().slice(0, 16).replace('T', ' ');
        hits.push({
          path: full,
          at: s.mtimeMs,
          line: s.isDirectory() ? `${full}\\ — folder — ${when}` : `${full} — ${kb(s.size)} — ${when}`,
        });
      }
      if (s.isDirectory() && depth < 6 && !SKIP.test(name)) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return hits
    .sort((a, b) => b.at - a.at)
    .slice(0, max)
    .map((h) => h.line);
}

/** "*.pdf", "report*", "*" → a test on the file name (case-insensitive). */
function matcher(pattern: string): (name: string) => boolean {
  const parts = pattern
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        new RegExp(
          `^${p
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')}$`,
          'i',
        ),
    );
  return (name) => parts.some((re) => re.test(name));
}

/** A name that doesn't exist yet in `dir`: "file.pdf", else "file (2).pdf"… */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let n = 2; ; n++) if (!existsSync(join(dir, `${stem} (${n})${ext}`))) return `${stem} (${n})${ext}`;
}

/** Move (or copy) the files in `from` matching `pattern` into `to`; returns how many. */
export function moveFiles(from: string, pattern: string, to: string, copy: boolean): number {
  if (!existsSync(from)) throw new Error(`no folder at ${from}`);
  const test = matcher(pattern || '*');
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    try {
      if (!statSync(src).isFile() || !test(name)) continue;
    } catch {
      continue;
    }
    const dst = join(to, freeName(to, name));
    if (copy) copyFileSync(src, dst);
    else renameSync(src, dst);
    n++;
  }
  return n;
}

/**
 * The model writes the usual path ("C:\Users\me\Desktop\…"); when the real Desktop or Documents is
 * elsewhere (OneDrive), use the real one, taken from the labelled special folders.
 */
export function mapKnownFolder(path: string, folders: readonly string[]): string {
  for (const f of folders) {
    const m = /^(Desktop|Documents|Downloads|Pictures|Music|Videos) folder: (.+)$/.exec(f);
    if (!m?.[1] || !m[2]) continue;
    const real = m[2];
    const usual = real.replace(/^(.*?\\Users\\[^\\]+)\\.*$/i, `$1\\${m[1]}`);
    if (usual.toLowerCase() === real.toLowerCase()) continue;
    const lower = path.toLowerCase();
    if (lower === usual.toLowerCase() || lower.startsWith(`${usual.toLowerCase()}\\`))
      return real + path.slice(usual.length);
  }
  return path;
}
