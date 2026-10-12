import { app, clipboard, ClipboardItem, screen, shell } from 'electron';
import { join, sep } from 'node:path';
import { isTerminal, type AppInfo, type InputAction, type WriteContext } from '@clicky/core';
import type { InputDriver } from '../platform/types';
import { statSync } from 'node:fs';
import { opensWithAnApp } from '../platform';
import { log } from './log';

/** A follow-up within this long reuses the tab Clicky opened instead of opening another. */
const REUSE_TAB_MS = 15 * 60_000;

/** Browser processes, to bring forward after opening a website in one. */
const BROWSERS = 'comet,chrome,msedge,firefox,brave,opera,vivaldi,arc';

/**
 * "C:\Users\me\Desktop" when the Desktop the user sees is elsewhere (OneDrive moves it): the
 * model guesses the usual path, so map it to the real one. Same for Documents, Pictures and so on.
 */
function knownFolder(path: string): string {
  const home = app.getPath('home');
  for (const name of ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'] as const) {
    const usual = join(home, name.charAt(0).toUpperCase() + name.slice(1));
    const real = app.getPath(name);
    if (real.toLowerCase() === usual.toLowerCase()) continue;
    const lower = path.toLowerCase();
    if (lower === usual.toLowerCase() || lower.startsWith(`${usual.toLowerCase()}${sep}`))
      return real + path.slice(usual.length);
  }
  return path;
}

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Clipboard formats we can put back exactly; anything else (copied files…) skips the selection check. */
const RESTORABLE = /^(text\/plain|text\/html|text\/rtf|image\/png)$/;

/**
 * Carries out the engine's mouse and keyboard requests (agent mode, write mode). Points arrive as
 * global DIP on a display; Windows wants physical pixels, which only main's screen API can map
 * correctly across displays with different scaling.
 */
export class InputHost {
  constructor(
    private readonly driver: InputDriver | null,
    private readonly findApp: (name: string) => { name: string; id: string } | null = () => null,
  ) {}

  /** The browser window Clicky last opened a site in, to reuse its tab for follow-ups. */
  private lastBrowser: { handle: string; at: number } | null = null;

  /** Called when a click target was found somewhere else than the screenshot said (the screen changed). */
  onRetarget: ((at: { x: number; y: number }, label: string) => void) | null = null;

  /** Start the helper in the background so the first dictation doesn't wait for it. */
  warm(): void {
    this.driver?.warm();
  }

  async run(action: InputAction): Promise<void> {
    const d = this.need();
    switch (action.kind) {
      case 'click': {
        let p = screen.dipToScreenPoint(action.at.global);
        // The screen may have changed since the screenshot (taskbar icons shift when an app opens):
        // find the named control where it is now and click that.
        if (action.target) {
          const live = await d.locate(action.target, p.x, p.y).catch(() => null);
          if (live && Math.hypot(live.x - p.x, live.y - p.y) > 6) {
            p = live;
            this.onRetarget?.(screen.screenToDipPoint(live), action.target);
          }
        }
        return d.click(p.x, p.y, action.button, action.count);
      }
      case 'close': {
        const want = action.title.toLowerCase().trim();
        const list = await d.windows();
        const w =
          list.find((x) => x.title.toLowerCase() === want) ??
          list.find((x) => x.title.toLowerCase().includes(want) || want.includes(x.title.toLowerCase()));
        if (!w) throw new Error(`no open window is called "${action.title}"`);
        return d.closeWindow(w.handle);
      }
      case 'open': {
        // Whatever opens is maximised once its window comes to the front (folders and files too).
        const before = await d.foregroundHandle().catch(() => '0');
        // Waited for (up to 3 s), so the next screenshot shows what was opened, in front.
        const maximize = (procs = ''): Promise<void> => d.maximizeNew(before, 3000, procs).catch(() => undefined);
        if (action.app) {
          const a = this.findApp(action.app);
          if (a) {
            await d.launch(a.id);
            return await maximize();
          }
          if (!action.url && !action.path) throw new Error(`"${action.app}" isn't installed on this PC.`);
        }
        // Websites open in the user's default browser (whatever Windows has set, e.g. Comet).
        if (action.url) {
          // Follow-ups reuse the tab Clicky opened (the browser window it last used is still in
          // front): go to the address there instead of opening yet another tab.
          const last = this.lastBrowser;
          if (last && last.handle === before && Date.now() - last.at < REUSE_TAB_MS) {
            await d.keys(['ctrl', 'l']);
            await delay(150);
            await d.type(action.url);
            await d.keys(['enter']);
            this.lastBrowser = { handle: before, at: Date.now() };
            log.info('reused the browser tab Clicky opened for a follow-up');
            return;
          }
          await shell.openExternal(action.url);
          // A new tab in a browser that's already open: bring the browser to the front.
          await maximize(BROWSERS);
          const now = await d.foregroundHandle().catch(() => '');
          const fg = await d.foreground().catch(() => null);
          if (now && fg && BROWSERS.split(',').includes(fg.process)) this.lastBrowser = { handle: now, at: Date.now() };
          return;
        }
        if (action.path) {
          const target = knownFolder(action.path);
          // A file no app opens (an .xlsx on a PC without Excel) would only bring up Windows'
          // "pick an app" box: show it selected in File Explorer instead.
          if (!opensWithAnApp(target)) return shell.showItemInFolder(target);
          // Explorer opened by shell.openPath often lands behind the window in front.
          if (isFolder(target)) {
            await d.openFolder(target);
            return await maximize();
          }
          const err = await shell.openPath(target);
          if (err) throw new Error(err);
        }
        return;
      }
      case 'drag':
        return d.drag(action.path.map((p) => screen.dipToScreenPoint(p.global)));
      case 'scroll': {
        const p = screen.dipToScreenPoint(action.at.global);
        return d.scroll(p.x, p.y, action.amount);
      }
      case 'type': {
        // Several lines are pasted, not typed: apps like Windows 11 Notepad autocorrect and mix up
        // typed lines ("delta" came out as "eelta"), found by the live suite.
        if (action.text.includes('\n')) {
          const app = await d.foreground().catch(() => null);
          if (app && !isTerminal(app) && (await this.paste(action.text))) return;
        }
        return d.type(action.text);
      }
      case 'backspace':
        return d.backspace(action.count);
      case 'keys':
        return d.keys(action.keys);
    }
  }

  /** The app in front (never-touch check for agent mode). */
  /**
   * Where the control named `label` really is, near a point the model guessed (global DIP), or null
   * if nothing matching is close by. Answers point with this the way agent clicks do: the official
   * Clicky gets precise targets from a second model pass; UI Automation does it locally in ~50 ms.
   */
  async snap(label: string, at: { x: number; y: number }, timeoutMs: number): Promise<{ x: number; y: number } | null> {
    if (!this.driver || !label.trim()) return null;
    const p = screen.dipToScreenPoint(at);
    const timeout = delay(timeoutMs).then(() => null);
    // The helper stops searching a little before the overall timeout.
    const search = this.driver.snap(label, p.x, p.y, Math.max(100, timeoutMs - 250)).catch(() => null);
    const live = await Promise.race([search, timeout]);
    if (!live || Math.hypot(live.x - p.x, live.y - p.y) <= 6) return null;
    return screen.screenToDipPoint(live);
  }

  async usesAltGr(): Promise<boolean> {
    return (await this.driver?.usesAltGr().catch(() => false)) ?? false;
  }

  /** Open windows for the agent, front first: "Title — app". */
  async windows(): Promise<string[]> {
    const list = (await this.driver?.windows().catch(() => [])) ?? [];
    return list.slice(0, 40).map((w) => `${w.title.slice(0, 120)} — ${w.process || 'app'}`);
  }

  async foreground(): Promise<AppInfo | null> {
    return (await this.driver?.foreground().catch(() => null)) ?? null;
  }

  /** Write mode, at key-up: the app in front and the text the user has selected there, if any. */
  async writeContext(): Promise<WriteContext> {
    const d = this.driver;
    if (!d) return { app: null, selection: null };
    const app = await d.foreground().catch(() => null);
    const selection = await this.selection(app).catch(() => null);
    return { app, selection };
  }

  /**
   * Copy the selection with Ctrl+C and put the clipboard back exactly as it was. Skipped in
   * terminals (Ctrl+C stops the running program there) and when the clipboard holds something we
   * couldn't restore, such as copied files.
   */
  private async selection(app: AppInfo | null): Promise<string | null> {
    const d = this.need();
    if (!app || isTerminal(app)) return null;
    const items = await clipboard.read();
    if (!items.every((it) => it.types.every((t) => RESTORABLE.test(t)))) return null;
    const saved: Record<string, Blob>[] = [];
    for (const it of items) {
      const rec: Record<string, Blob> = {};
      for (const t of it.types) {
        const v = await it.getType(t);
        if (v instanceof Blob) rec[t] = v;
      }
      saved.push(rec);
    }
    const marker = `⁣clicky-${Date.now()}`;
    await clipboard.writeText(marker);
    let copied: string | null = null;
    try {
      await d.keys(['ctrl', 'c']);
      for (let i = 0; i < 10; i++) {
        await delay(25);
        const t = await clipboard.readText();
        if (t !== marker) {
          copied = t;
          break;
        }
      }
    } finally {
      // Put back exactly what was there (or nothing).
      if (!saved.some((r) => Object.keys(r).length)) clipboard.clear();
      else await clipboard.write(saved.filter((r) => Object.keys(r).length).map((r) => new ClipboardItem(r)));
    }
    if (!copied || !copied.trim()) return null;
    // Code editors copy the whole line when nothing is selected; that isn't a selection.
    if (
      /^(code|cursor|devenv|idea64|pycharm64)$/.test(app.process) &&
      /\n$/.test(copied) &&
      copied.split('\n').length === 2
    )
      return null;
    return copied;
  }

  /** Paste text with Ctrl+V, then put the clipboard back as it was. False if it can't be restored. */
  private async paste(text: string): Promise<boolean> {
    const items = await clipboard.read();
    if (!items.every((it) => it.types.every((t) => RESTORABLE.test(t)))) return false;
    const saved: Record<string, Blob>[] = [];
    for (const it of items) {
      const rec: Record<string, Blob> = {};
      for (const t of it.types) {
        const v = await it.getType(t);
        if (v instanceof Blob) rec[t] = v;
      }
      saved.push(rec);
    }
    await clipboard.writeText(text);
    try {
      await this.need().keys(['ctrl', 'v']);
      await delay(250); // let the app read the clipboard before it's put back
    } finally {
      if (!saved.some((r) => Object.keys(r).length)) clipboard.clear();
      else await clipboard.write(saved.filter((r) => Object.keys(r).length).map((r) => new ClipboardItem(r)));
    }
    return true;
  }

  /** The text caret as a point on a display (DIP, relative to that display), when the app exposes it. */
  async caret(): Promise<{ displayId: number; x: number; y: number; height: number } | null> {
    const c = await this.driver?.caret().catch(() => null);
    if (!c) return null;
    const top = screen.screenToDipPoint({ x: c.x, y: c.y });
    const display = screen.getDisplayNearestPoint(top);
    return {
      displayId: display.id,
      x: top.x - display.bounds.x,
      y: top.y - display.bounds.y,
      height: c.height / display.scaleFactor,
    };
  }

  private need(): InputDriver {
    if (!this.driver) throw new Error('Clicky cannot use the mouse and keyboard on this system.');
    return this.driver;
  }

  dispose(): void {
    this.driver?.dispose();
  }
}
