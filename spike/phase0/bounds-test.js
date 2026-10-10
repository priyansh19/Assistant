// Which window options let a transparent overlay cover the taskbar area on Windows?
const { app, BrowserWindow, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const outFile = path.join(__dirname, 'bounds.json');
const trace = (m) => fs.appendFileSync(path.join(__dirname, 'bounds.trace'), m + '\n');
const variants = {
  base: {},
  resizable: { resizable: true },
  thickFrameOff: { thickFrame: false },
  resizableNoThick: { resizable: true, thickFrame: false },
  largerThanScreen: { enableLargerThanScreen: true },
};
trace('loaded');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  trace('ready');
  const d = screen.getPrimaryDisplay();
  const out = {};
  for (const [name, extra] of Object.entries(variants)) {
    trace('variant ' + name);
    const w = new BrowserWindow({ ...d.bounds, transparent: true, frame: false, resizable: false, focusable: false, skipTaskbar: true, show: false, ...extra });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setIgnoreMouseEvents(true);
    w.showInactive();
    const afterShow = w.getBounds();
    w.setBounds(d.bounds);
    const afterSet = w.getBounds();
    await new Promise((r) => setTimeout(r, 300));
    out[name] = { afterShow, afterSet, later: w.getBounds() };
    w.destroy();
  }
  fs.writeFileSync(outFile, JSON.stringify({ display: d.bounds, workArea: d.workArea, out }, null, 1));
  app.quit();
}).catch((e) => trace('err ' + e.stack));
