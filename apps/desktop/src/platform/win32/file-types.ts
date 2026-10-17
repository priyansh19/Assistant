// Which file types this PC can open (registry), so Clicky never opens Windows' "pick an app" box.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';

/** True for folders, and for files whose type some app on this PC is registered to open. */
export function opensWithAnApp(path: string): boolean {
  try {
    if (!existsSync(path) || statSync(path).isDirectory()) return true;
  } catch {
    return true;
  }
  const ext = extname(path).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return true;
  for (const key of [
    `HKCR\\${ext}`,
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`,
  ]) {
    try {
      const out = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      if (/REG_SZ\s+\S/.test(out) || key.endsWith('UserChoice')) return true;
    } catch {
      // no such key
    }
  }
  return false;
}
