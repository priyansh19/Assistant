import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** Strings that look like API keys are masked before anything is written (AGENTS.md privacy rules). */
const SECRET_RE = /\b(sk-[a-z]*-?[A-Za-z0-9_-]{8,}|xi-[A-Za-z0-9]{8,}|[A-Fa-f0-9]{32,})\b/g;

export function redact(text: string): string {
  return text.replace(SECRET_RE, (m) => `${m.slice(0, 4)}…[redacted]`);
}

function write(level: string, message: string, extra?: unknown): void {
  const line = redact(
    `${new Date().toISOString()} ${level} ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`,
  );
  try {
    const dir = join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'clicky.log');
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // first write
    }
    if (size > 5_000_000) writeFileSync(file, `${line}\n`);
    else appendFileSync(file, `${line}\n`);
  } catch {
    // never let logging crash the app
  }
  if (!app.isPackaged) console.log(line);
}

export const log = {
  info: (message: string, extra?: unknown) => write('INFO', message, extra),
  warn: (message: string, extra?: unknown) => write('WARN', message, extra),
  error: (message: string, extra?: unknown) => write('ERROR', message, extra),
};
