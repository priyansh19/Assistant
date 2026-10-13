import { app, BrowserWindow } from 'electron';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An SVG drawn into a PNG (base64), off screen, so the model can look at a sketch Clicky made before
 * drawing it on the user's screen. Null if it can't be rendered.
 */
export async function renderSvg(svg: string, size = 512): Promise<string | null> {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, javascript: false, sandbox: true },
  });
  try {
    const html = `<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((r) => setTimeout(r, 120));
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    return image.isEmpty() ? null : image.toPNG().toString('base64');
  } catch {
    return null;
  } finally {
    win.destroy();
  }
}

/** Keep a rendered drawing in userData/sketches (the newest 100), named by time. */
export function keepSketchPicture(pngBase64: string): void {
  try {
    const dir = join(app.getPath('userData'), 'sketches');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.png`), Buffer.from(pngBase64, 'base64'));
    const old = readdirSync(dir).sort().slice(0, -100);
    for (const f of old) rmSync(join(dir, f), { force: true });
  } catch {
    // a picture that isn't kept changes nothing
  }
}
