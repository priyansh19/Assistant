/**
 * Where agent file actions may reach. Clicky opens, lists, moves and copies only inside the user's
 * own folders (Desktop, Documents, Downloads, Pictures, Music, Videos, OneDrive and any folder the
 * user listed), never network paths, system folders, AppData, the Startup folder or Clicky's own
 * data (its memory, skills and lessons). Pure: the app passes in the real folder list.
 */

import { isNetworkPath } from './risk.js';

export interface PathPolicy {
  /** Absolute roots the agent may use, e.g. "C:\\Users\\Ana\\Documents". */
  allowed: readonly string[];
  /** Absolute roots it must never touch even inside an allowed one, e.g. Clicky's own data folder. */
  denied?: readonly string[];
}

export type PathVerdict = { ok: true; path: string } | { ok: false; why: string };

/** Windows paths compare case-insensitively with either slash; ".." segments are resolved. */
export function normalizeWinPath(path: string): string {
  const raw = path
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\//g, '\\');
  const drive = /^[a-z]:/i.exec(raw)?.[0]?.toUpperCase() ?? '';
  const parts: string[] = [];
  for (const p of raw.slice(drive.length).split('\\')) {
    if (!p || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return `${drive}\\${parts.join('\\')}`;
}

function within(path: string, root: string): boolean {
  const p = normalizeWinPath(path).toLowerCase();
  const r = normalizeWinPath(root).toLowerCase().replace(/\\$/, '');
  return p === r || p.startsWith(`${r}\\`);
}

/** Folders no agent step may use, wherever the user's folders are. */
const SYSTEM =
  /\\(?:windows|program files(?: \(x86\))?|programdata|\$recycle\.bin|system volume information|recovery)(?:\\|$)|\\appdata(?:\\|$)|\\start menu\\programs\\startup(?:\\|$)/i;

/** May an agent step use this path? */
export function checkPath(path: string, policy: PathPolicy): PathVerdict {
  const t = path.trim();
  if (!t) return { ok: false, why: 'no path given' };
  if (isNetworkPath(t) || /^\\\\[?.]\\/.test(t)) return { ok: false, why: 'network and device paths are not allowed' };
  if (!/^[a-z]:[\\/]/i.test(t)) return { ok: false, why: 'the path must be a full path like C:\\Users\\…' };
  const p = normalizeWinPath(t);
  if (SYSTEM.test(p)) return { ok: false, why: 'system folders, AppData and Startup are off limits' };
  if (policy.denied?.some((d) => within(p, d))) return { ok: false, why: "that is Clicky's own data folder" };
  if (!policy.allowed.some((r) => within(p, r)))
    return { ok: false, why: "it is outside the user's own folders (Desktop, Documents, Downloads…)" };
  return { ok: true, path: p };
}
