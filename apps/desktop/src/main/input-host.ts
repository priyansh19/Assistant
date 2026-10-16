import { app, clipboard, ClipboardItem, screen, shell } from 'electron';
import { join, sep } from 'node:path';
import {
  isTerminal,
  type AppInfo,
  type InputAction,
  type OtherAgent,
  type UiElement,
  type WriteContext,
} from '@clicky/core';
import type { InputDriver } from '../platform/types';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { opensWithAnApp } from '../platform';
import { log } from './log';

/** Processes Clicky never closes: the Claude app (it may be driving Clicky's tests) and Clicky itself. */
const PROTECTED = ['claude', 'clicky'];

/** Editors whose tabs say whether they have unsaved changes. */
const TABBED_EDITORS = ['notepad'];

/** The PC map is rebuilt this often in the background, and a copy this old is still used. */
const MAP_REFRESH_MS = 6000;
const MAP_FRESH_MS = 8000;

/**
 * Throws if Windows is showing a User Account Control prompt (the app asked for administrator
 * rights): Clicky can't see or click it, and nothing else works until the user answers it.
 */
function adminPrompt(app: string): void {
  let out: string;
  try {
    out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq consent.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
  } catch {
    return;
  }
  if (/consent\.exe/i.test(out))
    throw new Error(
      `${app} asked for administrator permission: Windows' User Account Control prompt is waiting for you to answer Yes or No`,
    );
}

/** Text longer than this is pasted rather than typed key by key. */
const PASTE_OVER = 40;

/** How often Clicky notes which window is in front. */
const USE_POLL_MS = 3000;

/** A title that says the document has unsaved changes ("*notes.txt - Notepad", "● main.ts - VS Code"). */
export function looksUnsaved(title: string): boolean {
  return /^\s*[*●•]|\*\s+-\s|[*●]\s*$|\(unsaved\)|\bunsaved\b|\bnot saved\b|\(modified\)|\bedited\b\s*$/i.test(title);
}

/** A tab's title without the browser's notes ("- Inactive tab - 147 MB freed up", "- Memory usage - 47 MB"). */
export function cleanTab(title: string): string {
  return title.replace(/\s+-\s+(?:inactive tab|memory usage|audio playing|muted)\b.*$/i, '').trim();
}

/** "4 min ago", "2 h ago". */
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return 'just now';
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** When each window and each browser tab was last in front (since Clicky started). */
export class UseTracker {
  private readonly windows = new Map<string, number>();
  private readonly tabs = new Map<string, number>();

  saw(handle: string, title: string, browser: boolean, now = Date.now()): void {
    this.windows.set(handle, now);
    // A browser window's title is its active tab's title plus " - Comet".
    if (browser)
      this.tabs.set(
        `${handle}|${title
          .replace(/\s+-\s+[^-]+$/, '')
          .trim()
          .toLowerCase()}`,
        now,
      );
    if (this.tabs.size > 2000) this.tabs.delete(this.tabs.keys().next().value as string);
  }

  lastUsed(handle: string): number | undefined {
    return this.windows.get(handle);
  }

  tabSeen(handle: string, tabTitle: string): number | undefined {
    return this.tabs.get(`${handle}|${tabTitle.trim().toLowerCase()}`);
  }
}

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

  /**
   * Fly Clicky's cursor to a point on screen (physical px) and let it land there, so the user always
   * sees where Clicky is about to act. Set by the controller.
   */
  pointAt: ((p: { x: number; y: number }, label: string) => Promise<void>) | null = null;

  /** The default browser (from Windows' https handler): its process and its name on the taskbar. */
  private browser: { process: string; label: string } | null = null;

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
        await this.guardCaption(p);
        return d.click(p.x, p.y, action.button, action.count);
      }
      case 'element': {
        const e = this.lastElements.get(action.id);
        if (e && action.op !== 'set') await this.guardCaption({ x: e.x + e.w / 2, y: e.y + e.h / 2 });
        await d.elementAct(action.id, action.op, action.text ?? '');
        return;
      }
      case 'control': {
        const at = await this.findControl(action.name, action.controlKind ?? '');
        if (!at) throw new Error(`there is no "${action.name}" in the window in front`);
        if (action.op !== 'set') await this.guardCaption(at);
        await this.show(at, action.name);
        if (action.op === 'set') {
          await d.click(at.x, at.y, 'left', 1);
          await delay(120);
          await d.keys(['ctrl', 'a']);
          await d.type(action.text ?? '');
          return;
        }
        return d.click(at.x, at.y, action.op === 'right' ? 'right' : 'left', action.op === 'double' ? 2 : 1);
      }
      case 'closeTab': {
        const list = await d.windows();
        const want = action.window.toLowerCase().trim();
        const fgh = await d.foregroundHandle().catch(() => '0');
        const browsers = list.filter((w) => BROWSERS.split(',').includes(w.process));
        const win =
          (want && browsers.find((w) => w.title.toLowerCase() === want || w.title.toLowerCase().includes(want))) ||
          browsers.find((w) => w.handle === fgh) ||
          browsers[0];
        if (!win) throw new Error('no browser window is open');
        const tabs = await d.tabs(win.handle);
        const t = action.tab.toLowerCase();
        const tab =
          tabs.find((x) => cleanTab(x.title).toLowerCase() === t) ??
          tabs.find((x) => x.title.toLowerCase().includes(t));
        if (!tab) throw new Error(`no tab called "${action.tab}" in ${win.title}`);
        await this.show({ x: tab.x, y: tab.y }, `Close tab ${cleanTab(tab.title).slice(0, 40)}`);
        if (!(await d.closeTab(win.handle, tab.index))) throw new Error(`couldn't close the tab "${action.tab}"`);
        return;
      }
      case 'close': {
        const want = action.title.toLowerCase().trim();
        const list = await d.windows();
        const w =
          list.find((x) => x.title.toLowerCase() === want) ??
          list.find((x) => x.title.toLowerCase().includes(want) || want.includes(x.title.toLowerCase()));
        if (!w) throw new Error(`no open window is called "${action.title}"`);
        await this.mayClose(w);
        // The cursor goes to the window's close button first.
        const box = await d.windowBox(w.handle).catch(() => null);
        if (box) {
          const s = this.scaleAt(box.x + box.w / 2, box.y + 10);
          await this.show({ x: box.x + box.w - Math.round(23 * s), y: box.y + Math.round(16 * s) }, `Close ${w.title}`);
        }
        return d.closeWindow(w.handle);
      }
      case 'open': {
        // Opened the way a person would, with the cursor at each step: the app's taskbar icon, the
        // browser's address bar. Launching in the background is only a fallback, and even then the
        // cursor goes to Start first.
        if (action.url) return this.openUrl(action.url);
        if (action.app) {
          const a = this.findApp(action.app);
          if (a) return this.openApp(a);
        }
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
          await this.show(await this.taskbarButton('File Explorer'), 'File Explorer');
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
        await this.showTyping(action.text);
        // Several lines, or a long line, are pasted, not typed: apps like Windows 11 Notepad
        // autocorrect and mix up typed text ("delta" came out as "eelta"; a 3-idea list came out
        // garbled 12 times in a row), found by the live suite.
        if (action.text.includes('\n') || action.text.length > PASTE_OVER) {
          const app = await d.foreground().catch(() => null);
          if (app && !isTerminal(app) && (await this.paste(action.text))) return;
        }
        return d.type(action.text);
      }
      case 'backspace':
        return d.backspace(action.count);
      case 'keys':
        // Alt+F4 closes the window in front: the same rules as close_window.
        if (action.keys.join('+') === 'alt+f4') {
          const h = await d.foregroundHandle().catch(() => '');
          const w = (await d.windows().catch(() => [])).find((x) => x.handle === h);
          if (w) await this.mayClose(w);
        }
        await this.showTyping(action.keys.join('+'));
        return d.keys(action.keys);
    }
  }

  /** Fly the cursor to a point (physical px); false if there's nowhere to go. */
  private async show(p: { x: number; y: number } | null | undefined, label: string): Promise<boolean> {
    if (!p || !this.pointAt) return false;
    await this.pointAt(p, label);
    return true;
  }

  /** Display scale at a physical point. */
  private scaleAt(x: number, y: number): number {
    return screen.getDisplayNearestPoint(screen.screenToDipPoint({ x, y })).scaleFactor || 1;
  }

  /** Before typing: the cursor goes to the text caret, or to the box that has the focus. */
  private async showTyping(what: string): Promise<void> {
    const d = this.need();
    const caret = await d.caret().catch(() => null);
    if (caret) return void (await this.show({ x: caret.x, y: caret.y + caret.height / 2 }, 'Typing here'));
    const box = await d.focusBox().catch(() => null);
    if (box && box.w < 2500)
      await this.show({ x: box.x + Math.min(box.w / 2, 60), y: box.y + box.h / 2 }, `Typing ${what.slice(0, 30)}`);
  }

  /** A taskbar button by app name ("Comet - 2 running windows pinned" matches "Comet"). */
  private async taskbarButton(name: string): Promise<{ x: number; y: number; name: string } | null> {
    const list = await this.need()
      .taskbar()
      .catch(() => []);
    const n = name.toLowerCase().trim();
    // App buttons only (pinned or running): the tray's "Clock 03:17" isn't the Clock app (found live).
    const apps = list.filter((b) => /^appid:/i.test(b.id) || (n === 'start' && b.id === 'StartButton'));
    return (
      apps.find((b) => {
        const t = b.name.toLowerCase();
        return t === n || t.startsWith(`${n} `);
      }) ?? null
    );
  }

  /** Waits up to ms for the window in front to change; the new handle, or null. */
  private async frontChange(before: string, ms: number): Promise<string | null> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const now = await this.need()
        .foregroundHandle()
        .catch(() => before);
      if (now && now !== before && now !== '0') return now;
      await delay(120);
    }
    return null;
  }

  /**
   * Open an app like a person: click its taskbar icon (pinned or running). Not on the taskbar: the
   * cursor goes to Start and the app is launched from there. The window ends up in front, maximised.
   */
  private async openApp(a: { name: string; id: string }): Promise<void> {
    const d = this.need();
    const before = await d.foregroundHandle().catch(() => '0');
    const fg = await d.foreground().catch(() => null);
    const btn = await this.taskbarButton(a.name);
    const first = a.name.toLowerCase().split(/\s+/)[0] ?? '';
    const inFront = !!fg && !!first && (fg.process.includes(first) || (fg.title ?? '').toLowerCase().endsWith(first));
    if (btn) {
      await this.show(btn, a.name);
      const running = /running window/i.test(btn.name);
      const windows = Number(/(\d+) running window/i.exec(btn.name)?.[1] ?? 0);
      if (inFront) return; // clicking the icon of the app in front would minimise it
      if (!running || windows === 1) {
        await d.click(btn.x, btn.y, 'left', 1);
        if (await this.frontChange(before, 4000)) {
          if (!running) await d.maximizeNew(before, 3000, '').catch(() => undefined);
          log.info(`opened ${a.name} from its taskbar icon`);
          return this.showWindow(a.name);
        }
      }
      // Several windows (the icon would only show thumbnails) or the click didn't bring one up.
      await d.launch(a.id);
      await d.maximizeNew(before, 3000, '').catch(() => undefined);
      adminPrompt(a.name);
      return this.showWindow(a.name);
    }
    await this.show(await this.taskbarButton('Start'), `Start: ${a.name}`);
    await d.launch(a.id);
    await d.maximizeNew(before, 3000, '').catch(() => undefined);
    adminPrompt(a.name);
    log.info(`opened ${a.name} from Start`);
    return this.showWindow(a.name);
  }

  /** The cursor goes to the title of the window in front (what just opened). */
  private async showWindow(label: string): Promise<void> {
    const d = this.need();
    const h = await d.foregroundHandle().catch(() => '0');
    const box = h && h !== '0' ? await d.windowBox(h).catch(() => null) : null;
    if (box)
      await this.show(
        { x: box.x + Math.round(box.w / 2), y: box.y + Math.round(18 * this.scaleAt(box.x, box.y)) },
        label,
      );
  }

  /** The default browser, read once from Windows' https handler. */
  private defaultBrowser(): { process: string; label: string } {
    if (this.browser) return this.browser;
    let prog = '';
    try {
      prog = execFileSync(
        'reg',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
          '/v',
          'ProgId',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 },
      );
    } catch {
      // no handler set
    }
    const known: [RegExp, string, string][] = [
      [/comet/i, 'comet', 'Comet'],
      [/chrome/i, 'chrome', 'Google Chrome'],
      [/msedge/i, 'msedge', 'Microsoft Edge'],
      [/brave/i, 'brave', 'Brave'],
      [/firefox/i, 'firefox', 'Firefox'],
      [/opera/i, 'opera', 'Opera'],
      [/vivaldi/i, 'vivaldi', 'Vivaldi'],
    ];
    const hit = known.find(([re]) => re.test(prog));
    this.browser = hit ? { process: hit[1], label: hit[2] } : { process: 'msedge', label: 'Microsoft Edge' };
    log.info(`default browser: ${this.browser.label}`);
    return this.browser;
  }

  /**
   * Open a website like a person: bring the browser up from its taskbar icon, open a new tab (or
   * reuse the one Clicky opened for a follow-up), click the address bar, type the address, Enter.
   */
  private async openUrl(url: string): Promise<void> {
    const d = this.need();
    const b = this.defaultBrowser();
    let fg = await d.foreground().catch(() => null);
    let fresh = false;
    if (fg?.process !== b.process) {
      const app = this.findApp(b.label);
      const btn = await this.taskbarButton(b.label);
      if (app) {
        fresh = !btn || !/running window/i.test(btn.name);
        await this.openApp(app);
      } else {
        await this.show(btn ?? (await this.taskbarButton('Start')), b.label);
        await shell.openExternal(url);
        await d.maximizeNew('0', 3000, BROWSERS).catch(() => undefined);
        return;
      }
      fg = await d.foreground().catch(() => null);
    }
    const handle = await d.foregroundHandle().catch(() => '0');
    if (fg?.process !== b.process) {
      // The browser didn't come up: open the site the quick way.
      await shell.openExternal(url);
      await d.maximizeNew('0', 3000, BROWSERS).catch(() => undefined);
      return;
    }
    const last = this.lastBrowser;
    const reuse = !!last && last.handle === handle && Date.now() - last.at < REUSE_TAB_MS;
    if (!fresh && !reuse) {
      const plus = await d.findControl(handle, 'button', 'New tab', 700).catch(() => null);
      if (plus && (await this.show(plus, 'New tab'))) await d.click(plus.x, plus.y, 'left', 1);
      else await d.keys(['ctrl', 't']);
      await delay(350);
    }
    // A new tab takes a moment to draw its address bar.
    let bar: { x: number; y: number } | null = null;
    for (let i = 0; i < 3 && !bar; i++) {
      bar = await d.findControl(handle, 'edit', 'Address and search bar', 1200).catch(() => null);
      if (!bar) await delay(400);
    }
    if (bar && (await this.show(bar, 'Address bar'))) {
      await d.click(bar.x, bar.y, 'left', 1);
      await delay(120);
      await d.keys(['ctrl', 'a']);
    } else {
      // A new tab's page can hide the bar's name: focus it with ctrl+l and go to whatever has the focus.
      await d.keys(['ctrl', 'l']);
      await delay(150);
      const box = await d.focusBox().catch(() => null);
      if (box && box.w < 2500)
        await this.show({ x: box.x + Math.min(box.w / 2, 120), y: box.y + box.h / 2 }, 'Address bar');
    }
    await delay(100);
    await d.type(url);
    // The address bar completes what's typed from history ("youtube.com/" becomes an old search
    // page, found live): Delete drops that completion so Enter goes to the address as typed.
    await delay(150);
    await d.keys(['delete']);
    await d.keys(['enter']);
    this.lastBrowser = { handle, at: Date.now() };
    log.info(`opened ${url} in ${b.label}${reuse ? ' (same tab)' : ''}`);
    await delay(800);
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

  /**
   * The controls of the window in front for the agent, numbered, with boxes in global DIP. The
   * numbers stay valid for element actions until the next list is taken.
   */
  async elements(): Promise<UiElement[]> {
    const list = (await this.driver?.elements(150, 1800).catch(() => [])) ?? [];
    this.lastElements = new Map(list.map((e) => [e.id, { x: e.x, y: e.y, w: e.w, h: e.h }]));
    return list.map((e) => {
      const tl = screen.screenToDipPoint({ x: e.x, y: e.y });
      const br = screen.screenToDipPoint({ x: e.x + e.w, y: e.y + e.h });
      return { id: e.id, kind: e.kind, name: e.name, x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
    });
  }

  /** What a browser shows when another agent drives it, or null. */
  async otherAgent(): Promise<OtherAgent | null> {
    const busy = (await this.driver?.otherAgent().catch(() => null)) ?? null;
    if (!busy) return null;
    const fg = await this.driver?.foreground().catch(() => null);
    return {
      ...busy,
      inFront: fg?.process === busy.process,
      defaultBrowser: this.defaultBrowser().process === busy.process,
    };
  }

  /**
   * Open windows for the agent, front first: "Title — app — used 4 min ago — unsaved changes", and
   * each browser window's tabs ("active", "asleep" when the browser put it to sleep for not being
   * used, and when Clicky last saw it in front).
   */
  async windows(): Promise<string[]> {
    // Kept fresh in the background (watchUse), so answers and agent steps don't wait seconds for tabs.
    if (this.mapCache && Date.now() - this.mapCache.at < MAP_FRESH_MS) return this.mapCache.lines;
    const lines = await this.buildMap();
    this.mapCache = { at: Date.now(), lines };
    return lines;
  }

  private mapCache: { at: number; lines: string[] } | null = null;

  private async buildMap(): Promise<string[]> {
    const d = this.driver;
    const list = (await d?.windows().catch(() => [])) ?? [];
    const out: string[] = [];
    const keep = this.protectedHandles();
    for (const w of list.slice(0, 40)) {
      const used = this.tracker.lastUsed(w.handle);
      const parts = [w.title.slice(0, 120), w.process || 'app'];
      if (used) parts.push(`used ${ago(used)}`);
      if (await this.unsaved(w)) parts.push('unsaved changes');
      if (PROTECTED.includes(w.process) || keep.has(w.handle)) parts.push('never close');
      out.push(parts.join(' — '));
      if (d && BROWSERS.split(',').includes(w.process)) {
        const tabs = await d.tabs(w.handle).catch(() => []);
        for (const t of tabs.slice(0, 30)) {
          const title = cleanTab(t.title);
          const seen = this.tracker.tabSeen(w.handle, title);
          const bits = [
            t.selected ? 'active' : '',
            /inactive tab/i.test(t.title) ? 'asleep (not used for a while)' : '',
            seen ? `last in front ${ago(seen)}` : '',
          ].filter(Boolean);
          out.push(`    tab: ${title.slice(0, 100)}${bits.length ? ` (${bits.join(', ')})` : ''}`);
        }
      }
    }
    return out;
  }

  /** Throws if Clicky must not close this window (unsaved work, Claude or Clicky, the user's keep list). */
  private async mayClose(w: { handle: string; process: string; title: string }): Promise<void> {
    if (await this.unsaved(w))
      throw new Error(`"${w.title}" has unsaved changes, so I left it open (closing it would lose that work)`);
    if (PROTECTED.includes(w.process) || this.protectedHandles().has(w.handle))
      throw new Error(`"${w.title}" is one I never close`);
  }

  /**
   * A click on a window's title-bar buttons (close, maximise, minimise) goes through the same rules
   * as close_window: round 1 of the tidy-up test closed windows by clicking their X directly.
   */
  private async guardCaption(p: { x: number; y: number }): Promise<void> {
    const d = this.need();
    const list = await d.windows().catch(() => []);
    for (const w of list.slice(0, 15)) {
      const box = await d.windowBox(w.handle).catch(() => null);
      if (!box || p.x < box.x || p.y < box.y || p.x > box.x + box.w || p.y > box.y + box.h) continue;
      const s = this.scaleAt(p.x, p.y);
      if (p.y - box.y < 48 * s && box.x + box.w - p.x < 150 * s) await this.mayClose(w);
      return; // the top-most window under the point decides
    }
  }

  /** The last list of controls (physical px), for the X-button check on element clicks. */
  private lastElements = new Map<number, { x: number; y: number; w: number; h: number }>();

  /** Unsaved work in a window: its title says so, or (Notepad) one of its tabs is "Modified". */
  private async unsaved(w: { handle: string; process: string; title: string }): Promise<boolean> {
    if (looksUnsaved(w.title)) return true;
    if (!TABBED_EDITORS.includes(w.process) || !this.driver) return false;
    const tabs = await this.driver.tabs(w.handle).catch(() => []);
    return tabs.some((t) => /\bmodified\b/i.test(t.title) && !/\bunmodified\b/i.test(t.title));
  }

  /** Remembers when each window (and each browser tab) was last in front. */
  readonly tracker = new UseTracker();

  /** Start noting which window is in front, every few seconds. */
  watchUse(): void {
    const d = this.driver;
    if (!d || this.useTimer) return;
    this.useTimer = setInterval(() => {
      void Promise.all([d.foregroundHandle().catch(() => ''), d.foreground().catch(() => null)]).then(([h, fg]) => {
        if (h && h !== '0' && fg) this.tracker.saw(h, fg.title, BROWSERS.split(',').includes(fg.process));
      });
    }, USE_POLL_MS);
    // The PC map, rebuilt every few seconds so it's ready the moment it's needed.
    this.mapTimer = setInterval(() => {
      void this.buildMap().then((lines) => (this.mapCache = { at: Date.now(), lines }));
    }, MAP_REFRESH_MS);
  }
  private useTimer: NodeJS.Timeout | null = null;
  private mapTimer: NodeJS.Timeout | null = null;

  /** Windows the user asked Clicky never to close (userData/protect.json: handles or title parts). */
  private protectedHandles(): Set<string> {
    try {
      const raw = JSON.parse(readFileSync(join(app.getPath('userData'), 'protect.json'), 'utf8')) as unknown;
      return new Set(Array.isArray(raw) ? raw.map(String) : []);
    } catch {
      return new Set();
    }
  }

  /** A control by name in the window in front, waiting up to 4 s for it to appear (pages load). */
  private async findControl(name: string, kind: string): Promise<{ x: number; y: number } | null> {
    const d = this.need();
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const at = await d.findControl('0', kind, name, 900).catch(() => null);
      if (at) return at;
      // The kind may be off ("button" for a link): try any kind once too.
      if (kind) {
        const any = await d.findControl('0', '', name, 700).catch(() => null);
        if (any) return any;
      }
      await delay(400);
    }
    return null;
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
    if (this.useTimer) clearInterval(this.useTimer);
    if (this.mapTimer) clearInterval(this.mapTimer);
    this.driver?.dispose();
  }
}
