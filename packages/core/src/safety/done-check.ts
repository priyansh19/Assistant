/**
 * Deterministic "is it really done?" checks. The plan says up front what will be true when the task
 * is finished (text that will show in the window, a window that will be open, a file that will
 * exist), and before Clicky tells the user "done" the app checks that against what it can read
 * itself (window titles, UI Automation names, the file system), without asking a model.
 */

export interface DoneCriteria {
  /** Text that must appear in a window title or a control's name or value (each one, case-insensitive). */
  shows: string[];
  /** A window whose title contains this must be open. */
  window: string;
  /** Files (full paths) that must exist. */
  files: string[];
}

export const NO_CRITERIA: DoneCriteria = { shows: [], window: '', files: [] };

export function hasCriteria(c: DoneCriteria): boolean {
  return c.shows.length > 0 || !!c.window || c.files.length > 0;
}

const list = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim().slice(0, 200))
    .filter((s) => s.length >= 2)
    .slice(0, max);

/** Read `done_when` from a plan or done reply: {"shows": [...], "window": "...", "files": [...]}. */
export function parseDoneCriteria(v: unknown): DoneCriteria {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return NO_CRITERIA;
  const o = v as Record<string, unknown>;
  return {
    shows: list(o['shows'] ?? o['text'], 5),
    window: typeof o['window'] === 'string' ? o['window'].trim().slice(0, 200) : '',
    files: list(o['files'] ?? o['file'], 5),
  };
}

/** What the app can read about the screen and disk right now. */
export interface DoneObservation {
  /** Open window titles. */
  windows: readonly string[];
  /** Names and values of the controls of the window in front (and anything else readable). */
  texts: readonly string[];
  fileExists(path: string): Promise<boolean>;
}

export type DoneVerdict =
  | { kind: 'confirmed' }
  | { kind: 'failed'; missing: string[] }
  /** Nothing to check against (no criteria). */
  | { kind: 'unverifiable' };

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export async function checkDone(c: DoneCriteria, o: DoneObservation): Promise<DoneVerdict> {
  if (!hasCriteria(c)) return { kind: 'unverifiable' };
  const missing: string[] = [];
  const all = [...o.windows, ...o.texts].map(norm);
  for (const s of c.shows) if (!all.some((t) => t.includes(norm(s)))) missing.push(`"${s}" is not on screen`);
  if (c.window && !o.windows.some((w) => norm(w).includes(norm(c.window))))
    missing.push(`no window "${c.window}" is open`);
  for (const f of c.files) {
    let ok: boolean;
    try {
      ok = await o.fileExists(f);
    } catch {
      ok = false;
    }
    if (!ok) missing.push(`the file ${f} does not exist`);
  }
  return missing.length ? { kind: 'failed', missing } : { kind: 'confirmed' };
}
