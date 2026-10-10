# Phase 0 findings (Windows laptop)

Measured 2026-10-10 on the owner's laptop with the throwaway spike in [`spike/phase0/`](../spike/phase0/). Re-run with `npm install && npm run auto` inside that folder (the hook test also needs `inject-keys.ps1` running, see the spike README).

## Machine

| | |
|---|---|
| Model | ASUS Zenbook Duo UX8406MA (two 1920×1200 panels; the lower one is only active when the keyboard is detached) |
| OS | Windows 11 Home Single Language, **Insider Preview build 29683**, x64 |
| CPU / RAM / GPU | Intel Core Ultra 7 155H (16 cores / 22 threads), 32 GB, Intel Arc iGPU |
| Active displays during the run | 1: internal 1920×1200 at 125% (1536×960 DIP). The registry also lists a Samsung external monitor and the second panel from earlier sessions. |
| Toolchain | Node 24.18, npm 11.16, pnpm 10.23, git 2.55, Electron 44.7.0 |

Insider builds change often; anything that breaks after a Windows update should be checked against a stable build before we blame our code.

## 1. Hold-to-talk (`uiohook-napi` 1.5.5): **proven**

- The win32-x64 prebuild loads in Electron 44 without a rebuild (N-API).
- Five injected Right Ctrl presses (600 ms holds) all produced exactly one key-down and one key-up; auto-repeat is filtered in our handler.
- Lag from injection to the hook event: 0–2 ms (27 ms on the very first press while the hook warmed up). Measured hold times: 603–608 ms.
- Caveat: these were injected (`keybd_event`) presses. A physical press goes through the same low-level hook, but the owner should still try holding Right Ctrl with the spike running (`npm start`) and watch the dot turn orange.

## 2. Click-through overlay: **proven on one display, mixed DPI not yet tested**

- One transparent, frameless, `alwaysOnTop('screen-saver')` window per display with `setIgnoreMouseEvents(true, { forward: true })`.
- Extended styles confirmed: `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE`.
- `WindowFromPoint` at the centre, the top-left area and the taskbar strip returns the window underneath (the app behind, `Shell_TrayWnd`), never the overlay. Clicks pass through.
- **Gotcha found:** Windows clamps a new window to the work area when it is first shown, so the overlay stopped above the taskbar (1536×912 instead of 1536×960). Fix: `showInactive()` then `setBounds(display.bounds)`. After the fix the renderer reports 1536×960 CSS px at DPR 1.25 = 1920×1200 physical, an exact match. The spike also dropped `movable: false` in the same change; whether that option alone blocks the resize was not isolated, so the app won't use it.
- Cursor-follow dot driven from `screen.getCursorScreenPoint()` at 60 Hz is smooth.
- **Still to verify:** mixed DPI across two displays (detach the keyboard to light up the lower panel, or plug in the Samsung at a different scale). The code already builds one window per display from DIP bounds and rebuilds on `display-added/removed/metrics-changed`.

## 3. Capture speed: **proven, with a design decision**

Primary display, 1920×1200 physical.

| Method | Cost |
|---|---|
| `desktopCapturer.getSources`, native-size thumbnail | 186–273 ms per call + 10–20 ms JPEG (≈180 KB) |
| `desktopCapturer.getSources`, 1280×800 thumbnail | 159–187 ms per call + 4–8 ms JPEG (≈100 KB) |
| Warm `getUserMedia` desktop stream: open | 227 ms to open, 460 ms to first frame |
| Warm stream: grab a frame | **< 1.5 ms** draw + 10–20 ms to 1280-px JPEG (≈100 KB); native JPEG 21–78 ms |

**Decision:** at key-down, open a desktop media stream for the cursor's display (in parallel with the mic and the pre-warmed connections). At key-up, grab the latest frame and encode a 1280-px JPEG: about 15 ms instead of about 170 ms, and the image shows the screen as it was when the user finished the question. If the key is released before the first frame (holds under ~0.5 s), wait for it. The stream stops as soon as the frame is taken, so capture still only happens while the key is held. A native WGC addon is **not** needed.

## Exit check

All three risks pass on this laptop; we stay on Electron. The mixed-DPI check and a physical key press are the two manual confirmations still owed.

Not done in this phase: running tekram/clicky-windows and emreyilmaz46/clicky_windows side by side. The spike answered the risk questions directly, so those repos are used as code references when each piece is built rather than run up front.
