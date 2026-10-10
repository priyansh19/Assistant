# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, etc.) and humans working in this repository.

## Project

**Clicky** is a desktop AI companion. Hold a key, ask a question about what's on screen, hear a spoken answer, and watch an overlay dot point at the relevant UI element. It is a port of the interaction model of [farzaa/clicky](https://github.com/farzaa/clicky) (macOS, MIT), not a copy of its code.

- Source of truth for scope and requirements: *Clicky for Windows — Product & Technical Blueprint* (2026-10-10).
- How we're building it: [`docs/development-plan.md`](docs/development-plan.md). Read it before starting work. Any deviation from the blueprint must be called out there with its reason.
- Platform strategy: cross-platform architecture, **Windows-first delivery**. Windows is the only platform built, tested and shipped until the MVP loop is solid. macOS and Linux (X11) come later. Wayland is out of scope.

Status: Phase 1. Phase 0 passed on the laptop (`docs/reference-findings.md`). The workspace, tray app, click-through overlay, hold-to-talk hook , the settings window with the encrypted key store, and the `core` logic (state machine, POINT parser, sentence chunker, coordinate mapping, prompt, latency recorder, provider interfaces) exist; providers and `pnpm bench` are still to come. Update this file when commands or layout change.

## Stack

Electron + TypeScript (strict), pnpm workspaces, electron-vite, Vitest, ESLint + Prettier, GitHub Actions on `windows-latest`. Key libraries: `uiohook-napi` (hold-to-talk key-up), `desktopCapturer` (capture), Electron `safeStorage` (secrets). Providers are pluggable: OpenAI-compatible/OpenRouter and Anthropic for vision chat, AssemblyAI for STT, ElevenLabs and OS TTS for speech.

## Layout

```
packages/core/        pure TS: state machine, POINT stream parser, coordinate mapping,
                      prompt builder, provider interfaces, latency recorder
packages/providers/   LLM / STT / TTS clients implementing core interfaces
apps/desktop/         Electron app
  src/main/           lifecycle, tray, hotkey hook, capture, overlay manager, orchestrator
  src/preload/        minimal typed contextBridge APIs
  src/renderer/       overlay, settings, hidden audio worker
  src/platform/       ALL OS-specific code: win32/, darwin/, linux/
docs/                 plan, architecture, privacy, findings
```

## Commands (target)

```
corepack enable     # once per machine, or prefix commands with `corepack pnpm@10.23.0`
pnpm install        # also downloads the Electron binary (apps/desktop postinstall)
pnpm dev            # run the Electron app in dev mode (Windows laptop)
pnpm test           # Vitest, all packages
pnpm lint           # ESLint
pnpm typecheck      # tsc --noEmit across workspaces
pnpm bench          # latency benchmark against real providers (needs keys)
pnpm package        # unsigned Windows build
```

Run `pnpm lint && pnpm typecheck && pnpm test` before every push.

## Architecture rules

1. `packages/core` imports nothing from Electron, Node OS modules, or the network. It must be unit-testable on any machine.
2. OS-specific code lives only under `apps/desktop/src/platform/<os>/` behind an interface. No `process.platform` checks elsewhere.
3. Providers implement interfaces from `core`. Never hard-code a single vendor into the orchestrator (blueprint §9).
4. The interaction is an explicit state machine: `Idle → Listening → Transcribing → Thinking → Speaking → Idle`, plus `Cancelled` and `Error`. Every interaction carries an id and an `AbortController`. No failed or partial request may look successful.
5. Keep the `[POINT:x,y:label:screenN]` / `[POINT:none]` protocol. Parse it from the stream, never speak tag text, and validate coordinates after mapping (screen index, bounds, DPI, negative origins).
6. **Speed is a release gate:** Clicky must start answering faster than the official macOS Clicky. Stream everything end to end (STT partials → LLM tokens → sentence chunks → streaming TTS → playback), capture and pre-warm connections at key-down, never wait for a full LLM response before speaking, and log the per-stage latencies from `docs/development-plan.md` §3.3. Run `pnpm bench` for changes on the interaction path; a regression of more than 10% on key-up → first audio needs a stated reason.
7. Renderer windows: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Expose the smallest possible preload API.

## Privacy and security (non-negotiable)

- API keys are stored only via `safeStorage`; never in plaintext files, logs, renderer memory, or commits.
- Screenshots and audio stay in memory and are discarded after the interaction unless the user enables debug capture.
- Capture happens only while the user holds the key; the overlay shows when capture is active.
- The logger redacts secrets and never logs raw audio or image data.
- `docs/privacy.md` must list what each provider receives; update it when adding a provider.

## Conventions

- TypeScript strict, no `any` without a comment explaining why. Prefer small pure functions in `core`.
- Tests next to code as `*.test.ts`. Every `core` change needs tests; parser and coordinate code need edge-case tests (split streams, negative origins, mixed DPI, out-of-bounds).
- Provider tests use recorded or fake streams, never live API calls in CI.
- User-facing text is English.
- Copying code from reference repos (all MIT) is allowed: keep the license notice and record it in `THIRD_PARTY_NOTICES.md`.

## Git and PRs

- Default branch: `master`. Work on a branch and open a PR; don't push to `master`.
- One phase step per PR where practical. PR descriptions include a short demo/verification checklist, and say which parts were verified on Windows hardware versus only in CI.
- Keep `docs/development-plan.md` and this file in sync with reality when a decision changes.

## Where things run

Development, manual testing and demos happen on a Windows laptop. Cloud/CI agents can build, lint, typecheck and run `core`/`providers` tests, but anything involving the hotkey hook, microphone, capture, overlay or audio output must be verified on Windows hardware before it's called done.
