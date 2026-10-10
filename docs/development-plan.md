# Clicky: development plan

Source of truth: *Clicky for Windows — Product & Technical Blueprint* (2026-10-10). This plan follows it, except where a deviation is called out as **Deviation** with the reason.

Owner request (2026-10-10): be platform agnostic if that is viable; otherwise focus on Windows. Outcome: **cross-platform architecture, Windows-first delivery.** Windows is the only platform we build, test and ship until the MVP loop is solid. macOS and Linux (X11) follow from the same codebase with small per-OS shims.

## 1. Product in one paragraph

A tray app. Hold a key, ask a question about what's on screen, hear a short spoken answer, and watch an overlay dot fly to the relevant UI element. Pipeline: global hold-to-talk key → mic stream → speech-to-text → screenshot → vision LLM (streaming) → text-to-speech (streaming) + `[POINT:x,y:label:screenN]` → overlay animation. Nothing else gets built until this loop is fast and reliable (blueprint §10, §17).

## 2. Tech stack decision

### 2.1 What actually has to be portable

Clicky is mostly OS integration. The parts that decide the stack:

| Capability | Why it's hard |
|---|---|
| Global **hold**-to-talk (key-down *and* key-up) | Win32 `RegisterHotKey`, Electron `globalShortcut` and similar APIs only report key-down. Needs a low-level hook (libuiohook / `WH_KEYBOARD_LL` / CGEventTap). |
| Transparent, topmost, **click-through** overlay on every monitor | Each OS does this differently; mixed-DPI multi-monitor makes it worse. |
| Fast per-monitor screen capture | Windows Graphics Capture, ScreenCaptureKit, X11/PipeWire portal. |
| Low-latency mic capture and streamed audio playback | |
| Secure credential storage | DPAPI / Credential Manager, Keychain, libsecret. |
| Streaming HTTP/SSE/WebSocket clients for LLM, STT, TTS | Easy everywhere; best SDKs are TypeScript and Python. |

### 2.2 Options compared

| Option | Hold-to-talk | Click-through overlay | Capture | Footprint | Verdict |
|---|---|---|---|---|---|
| **Electron + TypeScript** | `uiohook-napi` (libuiohook) gives press/release on Win/macOS/X11 | `setIgnoreMouseEvents(true, {forward:true})`: mature on Win/macOS | `desktopCapturer` (WGC under Chromium on Windows); native addon if too slow | ~150–250 MB RAM idle | **Chosen.** Named by the blueprint (§6) as the alternative "if cross-platform support becomes important". A working MIT Windows port exists (tekram/clicky-windows). First-party Anthropic/OpenAI TS SDKs. |
| Tauri 2 + Rust | `global-hotkey` has Pressed/Released | `set_ignore_cursor_events`, with open Windows bug reports (tauri#11461); WebKitGTK transparency is uneven on Linux | `xcap` (WGC backend) | ~30–60 MB | Runner-up. Lighter, but riskier on the overlay, which is the core feature, and adds a Rust shell to maintain. Revisit if Electron's footprint becomes a real complaint. |
| .NET + Avalonia | SharpHook (libuiohook) gives press/release | Not supported natively; per-OS P/Invoke (Avalonia discussion #11911) | Per-OS code | ~80–120 MB | Rejected. You end up writing per-OS native code for every hard row anyway. |
| .NET + WPF (blueprint default) | `WH_KEYBOARD_LL` | Native, solid | WGC | ~80–120 MB | Windows-only. Fallback if cross-platform is dropped. |
| Native per OS (Swift + C#) | | | | | That's the original Clicky plus a port: two codebases. Rejected. |

**Wayland** is out of scope for now: there is no portable way to get global key-up, a click-through topmost overlay, or prompt-free capture. X11 Linux is best-effort after macOS.

**Deviation from blueprint §6** (C#/.NET/WPF first): we use the blueprint's named alternative, Electron + TypeScript, because the owner asked for platform agnosticism. The architecture (state machine, provider abstraction, POINT protocol, privacy rules, phases) is unchanged.

### 2.3 Concrete stack

- **Runtime:** Electron (current stable, 44.x at time of writing), Node 22+, TypeScript strict.
- **Build/dev:** electron-vite (main / preload / renderer bundles), Electron Forge or electron-builder for packaging (decide in Phase 6; Forge + Squirrel is what tekram uses).
- **Package manager:** pnpm workspaces.
- **Hold-to-talk:** `uiohook-napi` in the main process; Electron `globalShortcut` only for non-hold shortcuts.
- **Mic:** `getUserMedia` + `AudioWorklet` in a hidden renderer, 16 kHz mono PCM16 frames over IPC/MessagePort to the STT client.
- **Capture:** `desktopCapturer` + `screen` API for display geometry and scale factors. Benchmark in Phase 0; replace with a small native addon (WGC) only if capture is a latency bottleneck.
- **Overlay:** one transparent, frameless, `alwaysOnTop('screen-saver')`, click-through `BrowserWindow` per display, recreated on `display-added/removed/metrics-changed`. Canvas/CSS animation.
- **Tray/settings:** Electron `Tray` + a small settings window (plain TS + lightweight UI; no heavy framework needed).
- **Credentials:** Electron `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux). Never plaintext on disk.
- **Providers (pluggable, blueprint §9):**
  - Vision chat: OpenAI-compatible streaming (OpenRouter and others) first; Anthropic Messages API second.
  - STT: AssemblyAI streaming first; OpenAI-compatible batch fallback; local Whisper later (Phase 4).
  - TTS: ElevenLabs streaming first; OS built-in TTS as free fallback.
- **Tests:** Vitest for unit/integration (core + providers with recorded streams); Playwright's Electron support for smoke tests; GitHub Actions on `windows-latest` (later a macOS job).
- **Lint/format:** ESLint (typescript-eslint) + Prettier.

## 3. Architecture

```
packages/
  core/        # pure TS, no Electron/Node-OS imports:
               #   interaction state machine, POINT stream parser, coordinate mapping,
               #   prompt builder, provider interfaces, latency recorder
  providers/   # HTTP/SSE/WebSocket clients implementing core interfaces
               #   (openai-compatible, anthropic, assemblyai, elevenlabs, ...)
apps/
  desktop/     # Electron app
    src/main/      # app lifecycle, tray, hotkey hook, capture, credential store,
                   # overlay window manager, orchestrator wiring core + providers
    src/preload/   # typed, minimal contextBridge APIs
    src/renderer/  # overlay, settings, hidden audio worker
    src/platform/  # the ONLY place for OS-specific code: win32/, darwin/, linux/
docs/
```

Rules:
- `packages/core` must not import Electron or any OS module; it is unit-testable anywhere (including cloud sessions).
- All OS differences live behind interfaces in `apps/desktop/src/platform/`. Code outside it never checks `process.platform`.
- Renderer windows run with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- API keys never reach a renderer.

### 3.1 Interaction state machine (blueprint §11)

`Idle → Listening → Transcribing → Thinking → Speaking → Idle`, plus `Cancelled` and `Error(reason)`. Every interaction has an id and an `AbortController`. Esc or a second key press cancels. No partial or failed request may end in a state that looks successful.

### 3.2 POINT protocol (blueprint §5)

- Keep the original grammar: `[POINT:x,y:label]`, `[POINT:x,y:label:screenN]`, `[POINT:none]`.
- **Deviation (speed):** the prompt asks the model to put the tag at the *start* of the response, not the end, so the dot can start moving before the first word is spoken. The parser accepts the tag at either position.
- A **streaming** parser releases speakable text sentence by sentence and holds back anything that could be the start of a tag, so TTS never speaks tag text.
- Coordinates are in the coordinate space of the screenshot image sent to the model (after any downscale). Mapping: image px → display physical px → Electron DIP (via `screen` scale factor and display bounds, including negative origins) → overlay window local coords.
- Validate: known screen index, inside bounds after mapping; otherwise speak the answer and skip pointing (logged, not silent).

### 3.3 Speed: beat the official Clicky (owner requirement, 2026-10-10)

Responses must start faster than the official macOS Clicky. Speed is a release gate, not a nice-to-have.

**What the original does** (farzaa/clicky, `CompanionManager.swift`, checked 2026-10-10): it streams the Claude response but discards the chunks and waits for the **full** response before sending the whole text to ElevenLabs. It captures every screen only **after** the transcript is final. Every call goes through a Cloudflare Worker hop. So time-to-first-audio is roughly: transcript finalise + capture + entire LLM response + TTS first byte. My estimate (not measured) is 3–5 s for a typical answer.

**How we beat it:**
1. **Capture at key-down**, in parallel with speaking. The screenshot is ready before the transcript is.
2. **Pre-warm at key-down:** open the STT WebSocket and the TLS connections to the LLM and TTS hosts while the user is still talking.
3. **Force STT finalisation on key-up** (AssemblyAI ForceEndpoint) instead of waiting for silence detection.
4. **True end-to-end streaming:** LLM tokens → sentence chunker → streaming TTS input (ElevenLabs WebSocket input streaming, Flash model) → playback starts on the first audio chunk. The first sentence is spoken while the model is still writing the rest.
5. **POINT tag first** (see 3.2), so pointing starts with the first token.
6. **No proxy hop** for personal use: the app calls providers directly with keys from `safeStorage`.
7. **Lean requests:** only the cursor's display by default, downscaled (start at 1280 px long edge, tune for accuracy vs speed), a short-answer system prompt, a small `max_tokens`, and prompt caching for the system prompt where the provider supports it.
8. **Fast model by default:** pick the vision model by measured time-to-first-token, not by benchmark score. Keep a "smart" model as a setting.
9. **Local fallbacks** (OS TTS) take over if a cloud stage is slow, so the user is never left in silence.

**Instrumentation:** each interaction logs one structured line with key-down → recording start, key-up → final transcript, final transcript → first LLM token, first token → first audio, key-up → first audio (**headline metric**), and total.

**Targets** (revise after Phase 0):

| Metric | Target p50 | Target p95 |
|---|---|---|
| key-down → recording start | < 50 ms | < 100 ms |
| key-up → final transcript | < 300 ms | < 600 ms |
| key-up → first audio (headline) | < 1.2 s | < 2.0 s |
| key-up → dot starts moving (when pointing) | < 1.2 s | < 2.0 s |

**Benchmark:** `pnpm bench` replays a fixed set of recorded questions and screenshots through the real providers and reports p50/p95 per stage. In Phase 0 we also measure the original's pipeline shape (full response, then TTS) with the same providers, so "faster than official" is a number. A PR that makes the headline p50 more than 10% worse needs a stated reason.

## 4. Phases

Every phase ends with something runnable on the Windows laptop and a short demo checklist in its PR.

### Phase 0: Reference spike and risk check (on the laptop)
1. Run tekram/clicky-windows (Electron) and emreyilmaz46/clicky_windows (WPF) on the ASUS; note what works.
2. Spike the three risky pieces in a throwaway Electron app: `uiohook-napi` hold-to-talk on Windows, click-through overlay on each monitor with mixed DPI, and `desktopCapturer` time-to-image at native resolution.
3. Record findings and a reuse/adapt/rewrite table in `docs/reference-findings.md`.

Exit: the three risks are proven or we switch to the Tauri or WPF fallback before writing real code.

### Phase 1: Skeleton and core (mostly cloud-buildable)
- pnpm workspace, TS strict, ESLint/Prettier, Vitest, electron-vite app that launches to tray.
- CI on `windows-latest`: install, lint, typecheck, test, package (unsigned).
- `packages/core`: state machine, streaming POINT parser (tested with every split point), coordinate mapping (negative origins, mixed DPI, downscale), prompt builder ported from the original Clicky prompt, latency recorder, provider interfaces.
- Credential store over `safeStorage`; settings window to enter keys and pick providers.

### Phase 2: End-to-end MVP loop (laptop)
- Hold-to-talk with configurable key, Esc cancels.
- Mic → AssemblyAI streaming STT.
- Capture the cursor's display (option: all displays), downscale, JPEG in memory only.
- OpenAI-compatible streaming vision chat (OpenRouter), then Anthropic.
- Speed path from 3.3 from day one: capture and pre-warm at key-down, force STT finalisation on key-up, POINT-first prompt, sentence-chunked streaming TTS (ElevenLabs WebSocket); OS TTS fallback.
- Latency logging and a first `pnpm bench`.
- Overlay: cursor-follow dot, listening/thinking indicator, fly-to-target with label.

Exit (blueprint acceptance + speed): hold a key, ask about the screen, hear a grounded answer with key-up → first audio under the 3.3 targets, see the dot point at the right place, on the laptop display and an external display if available.

### Phase 3: Reliability and latency
Per-stage timeouts, retries only for idempotent calls, visible error states, mic/network loss, invalid output or coordinates, display changes mid-interaction (re-read topology before pointing). Tune against the speed targets in 3.3 using `pnpm bench`. Optional snapping of POINT targets to the nearest UI Automation element on Windows. Integration tests with fake providers.

### Phase 4: Privacy and security
Visible capture indicator, nothing persisted by default, app exclusion list, `docs/privacy.md` listing what each provider receives, secret-redacting logger, optional local STT (whisper.cpp) with the caveat that screenshots still go to the cloud model.

### Phase 5: macOS and Linux (X11)
Implement `platform/darwin` (Screen Recording + Accessibility permission flow) and `platform/linux` (X11). Add a macOS CI job. Wayland stays unsupported unless portals mature.

### Phase 6: Advanced features (post-MVP, blueprint §13)
Conversation history, app-specific guidance, tutorials, more providers, local models, computer-use actions behind explicit confirmation. Each gets a short spec first.

### Phase 7: Release
Installer and auto-update, code-signing decision, README, demo video, architecture doc, known limitations, `THIRD_PARTY_NOTICES.md`.

## 5. Reference implementations (checked 2026-10-10, all MIT)

| Repo | Use it for |
|---|---|
| farzaa/clicky (Swift) | System prompt, POINT grammar and parser, overlay feel, Cloudflare Worker shape. |
| tekram/clicky-windows (Electron/TS) | Provider interfaces (Anthropic/OpenAI/OpenRouter; AssemblyAI/OpenAI/local Whisper; ElevenLabs/OpenAI/SAPI), display↔capture-source matching, tray. Its hotkey is toggle-only and mic streaming is unfinished. |
| emreyilmaz46/clicky_windows (C#/WPF) | Overlay animation details, AssemblyAI streaming flow, Windows coordinate handling. |

Anything copied keeps its MIT notice. Don't imply endorsement by the original authors (blueprint §15).

## 6. Open questions for the owner

1. Which API keys do you have: Anthropic, OpenRouter, OpenAI, AssemblyAI, ElevenLabs?
2. Laptop: Windows 10 or 11, x64 or ARM? External monitor?
3. Personal tool or distributed? Distributed means a key proxy (Cloudflare Worker), signing, auto-update and a privacy policy.
4. Pointing precision: prompt-only POINT tags first, then UI Automation snapping (default), or Anthropic computer-use for precision (Anthropic-only)?

## 7. Known limitations (planned)

- Clicky can't hook or overlay apps running as administrator unless it also runs elevated (Windows UIPI). We won't run elevated.
- DRM-protected content captures as black.
- Wayland unsupported.
