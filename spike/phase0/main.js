// Phase 0 spike. Throwaway code: proves the three risky pieces on real hardware.
//   1. uiohook-napi hold-to-talk (key-down AND key-up, latency vs injected input)
//   2. transparent click-through overlay on every display, correct size at each DPI
//   3. capture speed: desktopCapturer cold vs a warm getUserMedia stream
// `npm run auto` collects results into results.json and quits. Add `-- --stay` to keep overlays up.
const { app, BrowserWindow, screen, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { performance } = require('perf_hooks');

if (process.argv.includes('--bounds-test')) { require('./bounds-test'); return; }
const AUTO = process.argv.includes('--auto');
const STAY = process.argv.includes('--stay');
const results = { startedAt: new Date().toISOString(), electron: process.versions.electron, displays: [], overlays: [], hook: { events: [] }, capture: {} };
const overlays = new Map();
const log = (...a) => console.log('[spike]', ...a);
const file = (n) => path.join(__dirname, n);

function describeDisplays() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({
    id: d.id, primary: d.id === primary, label: d.label, bounds: d.bounds, workArea: d.workArea,
    scaleFactor: d.scaleFactor, rotation: d.rotation, internal: d.internal,
    physical: { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) },
  }));
}

function createOverlay(display) {
  const win = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
    transparent: true, frame: false, resizable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, show: false, backgroundColor: '#00000000',
    webPreferences: { preload: file('preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  // Windows clamps a new window to the work area (above the taskbar) when it is first shown.
  // Re-asserting the bounds after show makes it cover the full display. `movable: false` blocks this.
  win.showInactive();
  win.setBounds(display.bounds);
  win.loadFile('overlay.html', { query: { displayId: String(display.id) } });
  overlays.set(display.id, win);
}

function rebuildOverlays() {
  for (const w of overlays.values()) w.destroy();
  overlays.clear();
  for (const d of screen.getAllDisplays()) createOverlay(d);
}

// Cursor-follow: push the cursor position (DIP, display-local) to the overlay that contains it.
function startCursorPump() {
  setInterval(() => {
    const p = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(p);
    for (const [id, w] of overlays) {
      if (w.isDestroyed()) continue;
      w.webContents.send('cursor', id === d.id ? { x: p.x - d.bounds.x, y: p.y - d.bounds.y } : null);
    }
  }, 16);
}

// --- 1. Hold-to-talk hook ---
function startHook() {
  let uIOhook, UiohookKey;
  try { ({ uIOhook, UiohookKey } = require('uiohook-napi')); }
  catch (e) { results.hook.error = String(e); log('uiohook load failed', e); return; }
  // Test key: Right Ctrl (no OS meaning on its own). Configurable in the real app.
  const KEY = UiohookKey.CtrlRight;
  let downAt = null;
  uIOhook.on('keydown', (e) => {
    if (e.keycode !== KEY || downAt !== null) return; // ignore auto-repeat
    downAt = Date.now();
    results.hook.events.push({ type: 'down', at: downAt });
    for (const w of overlays.values()) if (!w.isDestroyed()) w.webContents.send('listening', true);
    log('key down');
  });
  uIOhook.on('keyup', (e) => {
    if (e.keycode !== KEY) return;
    const now = Date.now();
    results.hook.events.push({ type: 'up', at: now, heldMs: downAt ? now - downAt : null });
    downAt = null;
    for (const w of overlays.values()) if (!w.isDestroyed()) w.webContents.send('listening', false);
    log('key up');
  });
  uIOhook.start();
  results.hook.started = true;
}

// --- 3. Capture speed ---
function scaled(phys, longEdge) {
  const s = longEdge / Math.max(phys.width, phys.height);
  return { width: Math.round(phys.width * s), height: Math.round(phys.height * s) };
}

async function benchDesktopCapturer() {
  const d = describeDisplays()[0];
  const out = [];
  for (const sizeCase of ['native', '1280']) {
    for (let i = 0; i < 6; i++) {
      const thumb = sizeCase === 'native' ? d.physical : scaled(d.physical, 1280);
      const t0 = performance.now();
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumb });
      const t1 = performance.now();
      const img = sources[0].thumbnail;
      const jpeg = img.toJPEG(80);
      const t2 = performance.now();
      out.push({ sizeCase, iter: i, getSourcesMs: +(t1 - t0).toFixed(1), jpegMs: +(t2 - t1).toFixed(1), imgSize: img.getSize(), jpegBytes: jpeg.length });
    }
  }
  results.capture.desktopCapturer = out;
  results.capture.sources = (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }))
    .map((s) => ({ id: s.id, name: s.name, display_id: s.display_id }));
}

async function benchWarmStream() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const d = describeDisplays()[0];
  const win = new BrowserWindow({ show: false, webPreferences: { preload: file('preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile('capture.html');
  const res = await new Promise((resolve) => {
    ipcMain.once('capture-result', (_e, r) => resolve(r));
    win.webContents.send('capture-start', { sourceId: sources[0].id, width: d.physical.width, height: d.physical.height });
  });
  results.capture.warmStream = res;
  win.destroy();
}

ipcMain.on('overlay-report', (_e, r) => { results.overlays.push(r); });

function writeResults() { fs.writeFileSync(file('results.json'), JSON.stringify(results, null, 2)); }

async function auto() {
  for (const f of ['.ready', '.inject-done', 'results.json']) fs.rmSync(file(f), { force: true });
  await new Promise((r) => setTimeout(r, 1500)); // let overlays report their size
  results.overlayWindows = [...overlays].map(([id, w]) => ({ displayId: id, windowBounds: w.getBounds(), contentBounds: w.getContentBounds(), hwnd: w.getNativeWindowHandle().readBigUInt64LE().toString() }));
  log('benchmarking desktopCapturer'); await benchDesktopCapturer();
  log('benchmarking warm stream'); await benchWarmStream();
  fs.writeFileSync(file('.ready'), String(Date.now())); // tells inject-keys.ps1 to start
  log('ready for key injection');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !fs.existsSync(file('.inject-done'))) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 200));
  try { results.hook.injected = JSON.parse(fs.readFileSync(file('.inject-done'), 'utf8').replace(/^﻿/, '')); } catch { results.hook.injected = null; }
  writeResults();
  log('wrote results.json');
  if (!STAY) app.quit();
}

app.whenReady().then(() => {
  results.displays = describeDisplays();
  log('displays', JSON.stringify(results.displays));
  rebuildOverlays();
  screen.on('display-added', rebuildOverlays);
  screen.on('display-removed', rebuildOverlays);
  screen.on('display-metrics-changed', rebuildOverlays);
  startCursorPump();
  startHook();
  if (AUTO) auto().catch((e) => { log('auto failed', e); results.error = String(e.stack || e); writeResults(); app.quit(); });
});

app.on('window-all-closed', () => { /* tray-style app: stay alive */ });
app.on('will-quit', () => { try { require('uiohook-napi').uIOhook.stop(); } catch { /* not loaded */ } });

