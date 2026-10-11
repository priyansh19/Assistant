/* eslint-disable @typescript-eslint/no-require-imports -- a plain CommonJS script run directly by Electron */
// Renders the installer artwork (NSIS wants 24-bit BMPs: sidebar 164x314, header 150x57) from HTML,
// in Clicky's own look: warm paper, the rounded triangle, a lowercase wordmark.
// Run with: electron scripts/installer-art.cjs   (writes into resources/)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'resources');
const tri = (size, color) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path d="M20.5 12 L6.5 20.2 L6.5 3.8 Z" fill="${color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
const font = `font-family:'Segoe UI Variable Display','Segoe UI',sans-serif;`;

/** PNGs: the app icon (256) and the tray icon (32), same triangle on a warm rounded tile. */
const pngs = {
  icon: {
    w: 256,
    h: 256,
    html: `<body style="margin:0;width:256px;height:256px;background:transparent;overflow:hidden"><div style="position:absolute;left:12px;top:12px;width:228px;height:228px;border-radius:52px;background:#f4efe6;border:5px solid #211e1a22;box-sizing:border-box;display:grid;place-items:center;box-shadow:8px 8px 0 #211e1a22">${tri(150, '#2f8cff')}</div></body>`,
  },
  tray: {
    w: 32,
    h: 32,
    html: `<body style="margin:0;width:32px;height:32px;background:transparent;overflow:hidden;display:grid;place-items:center">${tri(30, '#2f8cff')}</body>`,
  },
};

const pages = {
  installerSidebar: {
    w: 164,
    h: 314,
    html: `<body style="margin:0;width:164px;height:314px;background:#f4efe6;${font}overflow:hidden;position:relative">
      <div style="position:absolute;inset:0;background:radial-gradient(circle at 30% 22%,#2f8cff22 0,transparent 55%),radial-gradient(circle at 80% 85%,#ffbd3e2a 0,transparent 50%)"></div>
      <div style="position:absolute;left:20px;top:28px;filter:drop-shadow(3px 3px 0 rgba(33,30,26,.18))">${tri(54, '#2f8cff')}</div>
      <div style="position:absolute;left:22px;top:96px;font-size:30px;font-weight:700;color:#211e1a;letter-spacing:-0.03em">clicky</div>
      <div style="position:absolute;left:22px;top:138px;width:124px;font-size:12px;line-height:1.45;color:#6d665c">your screen-aware buddy. hold a key, ask, and it points the way.</div>
      <div style="position:absolute;left:22px;bottom:22px;display:flex;gap:6px">
        <span style="width:9px;height:9px;border-radius:50%;background:#ff6b5b"></span>
        <span style="width:9px;height:9px;border-radius:50%;background:#ffbd3e"></span>
        <span style="width:9px;height:9px;border-radius:50%;background:#2bc840"></span>
      </div></body>`,
  },
  installerHeader: {
    w: 150,
    h: 57,
    html: `<body style="margin:0;width:150px;height:57px;background:#f4efe6;${font}overflow:hidden;display:flex;align-items:center;gap:8px;padding-left:14px;box-sizing:border-box">
      ${tri(26, '#2f8cff')}<span style="font-size:21px;font-weight:700;color:#211e1a;letter-spacing:-0.03em">clicky</span></body>`,
  },
};

/** 24-bit bottom-up BMP from Electron's BGRA bitmap. */
function bmp(bgra, w, h) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = 54 + (h - 1 - y) * row + x * 3;
      buf[d] = bgra[s];
      buf[d + 1] = bgra[s + 1];
      buf[d + 2] = bgra[s + 2];
    }
  return buf;
}

// Keep running between renders (Electron quits when the last window closes).
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  for (const [name, p] of Object.entries(pages)) {
    // Windows enforces a minimum window size, so render in a roomy window and crop.
    const win = new BrowserWindow({ width: 400, height: 400, show: false, useContentSize: true, frame: false });
    await win.loadURL('data:text/html,' + encodeURIComponent(p.html));
    await new Promise((r) => setTimeout(r, 300));
    const img = (await win.webContents.capturePage({ x: 0, y: 0, width: p.w, height: p.h })).resize({
      width: p.w,
      height: p.h,
      quality: 'best',
    });
    fs.writeFileSync(path.join(out, `${name}.bmp`), bmp(img.toBitmap(), p.w, p.h));
    win.destroy();
  }
  for (const [name, p] of Object.entries(pngs)) {
    const win = new BrowserWindow({
      width: 400,
      height: 400,
      show: false,
      useContentSize: true,
      frame: false,
      transparent: true,
    });
    await win.loadURL('data:text/html,' + encodeURIComponent(p.html));
    await new Promise((r) => setTimeout(r, 300));
    const img = (await win.webContents.capturePage({ x: 0, y: 0, width: p.w, height: p.h })).resize({
      width: p.w,
      height: p.h,
      quality: 'best',
    });
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
    win.destroy();
  }
  app.quit();
});
