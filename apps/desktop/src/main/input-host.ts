import { clipboard, ClipboardItem, screen } from 'electron';
import { isTerminal, type AppInfo, type InputAction, type WriteContext } from '@clicky/core';
import type { InputDriver } from '../platform/types';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Clipboard formats we can put back exactly; anything else (copied files…) skips the selection check. */
const RESTORABLE = /^(text\/plain|text\/html|text\/rtf|image\/png)$/;

/**
 * Carries out the engine's mouse and keyboard requests (agent mode, write mode). Points arrive as
 * global DIP on a display; Windows wants physical pixels, which only main's screen API can map
 * correctly across displays with different scaling.
 */
export class InputHost {
  constructor(private readonly driver: InputDriver | null) {}

  /** Start the helper in the background so the first dictation doesn't wait for it. */
  warm(): void {
    this.driver?.warm();
  }

  async run(action: InputAction): Promise<void> {
    const d = this.need();
    switch (action.kind) {
      case 'click': {
        const p = screen.dipToScreenPoint(action.at.global);
        return d.click(p.x, p.y, action.button, action.count);
      }
      case 'scroll': {
        const p = screen.dipToScreenPoint(action.at.global);
        return d.scroll(p.x, p.y, action.amount);
      }
      case 'type':
        return d.type(action.text);
      case 'backspace':
        return d.backspace(action.count);
      case 'keys':
        return d.keys(action.keys);
    }
  }

  /** The app in front (never-touch check for agent mode). */
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
