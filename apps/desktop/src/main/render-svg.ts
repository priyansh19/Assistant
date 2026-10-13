import { BrowserWindow } from 'electron';

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
