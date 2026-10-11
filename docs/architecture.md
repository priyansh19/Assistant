# Clicky architecture

Status: approved by the owner on 2026-10-11 and being built in four steps (section 9). Written against the Phase 2 code (PR #8). Section 9 says which steps have landed.

Goal (owner, 2026-10-11): the fastest personal AI assistant cursor. Speed is the organising principle: every boundary below exists to take work off the key-up → first audio path. "Personal" also settles plan §6 question 3: no key proxy, the app calls providers directly with locally stored keys, which removes a network hop.

## 1. Summary

The current code works and its pure logic is in good shape (state machine, POINT parser, chunker, coordinate mapping, all tested in `packages/core`). What holds latency back is the shape of the system around it:

1. **The Electron main process is on every hot path.** Mic frames go worker → main → STT socket (50 IPC messages a second), TTS audio goes main → worker, and the hold-key hook runs in main. Anything that blocks main (a `desktopCapturer.getSources` call is 200–300 ms, window moves, settings/history writes) delays key-down, audio and playback.
2. **The answer path is strictly sequential after key-up.** Mic tail → STT finalise → LLM request (image uploaded only now) → wait for a full sentence → one new HTTP request per sentence for TTS → playback. Every stage waits for the one before it to finish its first output.
3. **One large orchestrator class** (`packages/core/src/orchestrator.ts`, 549 lines) owns stage wiring, timeouts, error mapping, history and latency marks together, so each speed trick means editing the same function.
4. **Errors are strings.** `describeError` regex-matches messages, which is how "An API key was rejected" appeared for an OpenRouter management key without naming the provider.

The redesign separates a **control plane** (main: windows, tray, settings, keys) from a **data plane** (a dedicated engine process plus the media renderer, connected directly by MessagePorts), rebuilds the orchestrator as a **pipeline of small streaming stages** driven by a **typed event log**, and adds **speculative and overlapped execution** so the stages after key-up run in parallel instead of one after another.

## 2. Honest latency floor

"Milliseconds" is reachable for *feedback*, not for the spoken answer.

- **Instant feedback (< 50 ms):** the cursor switching to a "thinking" state and an optional short earcon on key-up. Both are local, so this can be near-instant.
- **Spoken answer:** a cloud vision model has to receive the question, read the image and produce its first words, and the voice service has to produce its first audio. That is at least two to three network round trips plus model time. From Italy to US endpoints a round trip alone is roughly 100–150 ms. A realistic target with the redesign is **key-up → first audio p50 ≈ 0.5–0.9 s**, against the plan's 1.2 s gate and an estimated 3–5 s for the official Clicky.

The numbers below are estimates from the code's structure and published provider figures, not measurements. Step 1 of the migration (section 9) adds the tracing that turns them into real before/after numbers on the laptop.

| Stage after key-up | Today (est.) | Redesign (est.) | What changes |
|---|---|---|---|
| Mic tail before stopping | 80 ms | 0–30 ms | Stop on VAD silence or a short tail; frames already streaming |
| STT finalise (ForceEndpoint) | 200–400 ms | 0–150 ms on the critical path | Speculative LLM start on the stable partial (6.3) |
| LLM time to first token, with image | 1,000–2,500 ms (Opus 5.5) | 300–600 ms | Fast model by default, image cached during speech (6.4) |
| Tokens until the first speakable chunk | 150–400 ms | 50–150 ms | Eager first clause instead of full sentence (6.5) |
| TTS time to first byte | 200–400 ms (new HTTP request) | 80–200 ms | Persistent streaming socket opened at key-down (6.6) |
| Hand-off to playback | 20–50 ms + main-process jitter | 5–20 ms | Engine → media renderer over a direct port (4) |
| **Key-up → first audio** | **≈ 1.7–3.8 s** | **≈ 0.5–0.9 s** | |

## 3. Design principles

1. **Control plane and data plane are separate.** Main never touches an audio frame, a token or an image.
2. **Everything streams, nothing waits for "done".** Each stage consumes the first item of its input and emits its first output as early as possible.
3. **Start work before you know you need it; cancel it cheaply.** Speculation is allowed wherever a wrong guess can be aborted and costs only money, never correctness.
4. **One source of truth per kind of state.** Interaction state lives in the engine's state machine; app settings live in main; neither is mirrored by hand.
5. **Events, not callbacks, for observability.** Every stage emits timestamped events. Latency, logs, the overlay and history are consumers of the same log.
6. **Typed failures with an owner.** Every error says which stage and which provider failed, and what kind of failure it is. User-facing text is derived from that, never from regexes.
7. **Pure core, thin adapters.** Pipeline logic stays in `packages/core` and is tested without Electron (AGENTS.md rule 1).
8. **Measured, not assumed.** No speed change merges without trace numbers, and a regression of more than 10% on key-up → first audio needs a stated reason (AGENTS.md rule 6).

## 4. Process model

```
                      ┌──────────────────────────────────────────┐
                      │  MAIN (control plane)                     │
                      │  lifecycle · tray · windows · settings    │
                      │  credential store (safeStorage) · supervisor
                      └──────┬───────────────┬──────────────┬─────┘
             settings+keys   │  port setup    │ port setup   │ IPC (non-hot)
             (snapshot)      │                │              │
   ┌─────────────────────────▼──┐   ┌─────────▼───────────┐  ┌▼──────────────┐
   │ ENGINE  (utilityProcess)   │   │ MEDIA (hidden,      │  │ DASHBOARD     │
   │ hold-key hook (uiohook)    │◄─►│ sandboxed renderer) │  │ renderer      │
   │ state machine · pipeline   │ P1│ mic worklet         │  └───────────────┘
   │ providers (STT/LLM/TTS)    │   │ capture stream+JPEG │
   │ trace recorder             │   │ audio playback      │
   └─────────────┬──────────────┘   └─────────────────────┘
                 │ P2 (MessagePort, one per display)
         ┌───────▼─────────┐
         │ OVERLAY renderers│  cursor · thinking state · fly-to-point
         └─────────────────┘
```

- **Main** creates the other processes, hands each pair a `MessageChannelMain` port, then stays out of the way. It keeps the credential store (safeStorage only works in main) and sends the engine a settings + keys snapshot on start and on change. Keys go to the engine (a Node process, not a renderer), so the rule "keys never reach a renderer" still holds.
- **Engine** is an Electron `utilityProcess`: Node, no window, its own event loop. It owns the hold-key hook, the interaction state machine, the pipeline and all provider connections. Because nothing else runs there, key events and socket reads never queue behind window work.
- **On-device speech** (Moonshine/Parakeet STT and Piper voices through `sherpa-onnx-node`) runs in the engine, so model inference never shares an event loop with windows. Main only downloads and removes models (`main/local-speech/store.ts`) and tells the engine the models folder; the engine reads it with `engine/local-speech/files.ts`.
- **Media renderer** is the current hidden worker, unchanged in what it does: mic, capture, playback, offline voice. It talks to the engine over port **P1** with transferable `ArrayBuffer`s (zero-copy), not through main.
- **Overlay renderers** get state and point events from the engine. As built, these go through main (one extra hop, off the audio path) because main owns the overlay windows and the cursor position; a direct port **P2** is the next step if the trace shows main delaying the pointer.
- **Dashboard** keeps talking to main over normal IPC. Typed questions and saved actions are forwarded to the engine as commands.
- **Supervisor:** main restarts the engine or media process if one dies, re-sends the snapshot and re-wires the ports; the running interaction ends in a visible error, never a stuck state.

Risk to check on the laptop first: `uiohook-napi` inside a `utilityProcess`. As built, if the engine process fails to start within 5 s or crashes more than twice in a minute, the same `Engine` runs inside main over the old worker channel for the rest of the session (log line "running the engine inside the main process"). `CLICKY_ENGINE=inproc` forces that mode. Mic levels for the overlay waveform still go through main; mic frames and audio don't. Also check `sherpa-onnx-node` loads in the engine process (log line "local STT failed to load" if not).

## 5. Module boundaries

```
packages/core/                 pure TS, no Electron/Node-OS/network
  domain/      interaction machine, events, errors (typed), settings model
  pipeline/    stage interfaces, PipelineRunner, budgets, speculation policy
  stages/      point parser, chunker (eager first clause), coordinate mapping, prompt
  trace/       event log, latency derivation, percentiles (replaces latency.ts)
  ports.ts     MicPort, CapturePort, AudioSinkPort, OverlayPort, ClockPort
packages/providers/            adapters implementing core provider interfaces
  stt/ assemblyai, openai-batch        llm/ anthropic, openai-compatible
  tts/ elevenlabs-ws, openai, (os voice lives in media)
  net/ shared keep-alive dispatcher, SSE, WebSocket helpers, error classifier
apps/desktop/src/
  main/        control plane only: lifecycle, tray, windows, stores, supervisor
  engine/      NEW: utilityProcess entry, composition root wiring core + providers
  renderer/    media/ (was worker/), overlay/, dashboard/
  shared/      versioned channel contracts: engine↔main, engine↔media, engine↔overlay
  platform/    win32/ darwin/ linux/ (hold-key hook, overlay fitting, later UIA snapping)
```

Dependency rule: `renderer`, `main` and `engine` may import `shared` and `core` types; only `engine` imports `providers`; nothing imports `main`.

## 6. The streaming pipeline

### 6.1 Stages

Each stage is a small class in `core` with one job, an input stream, an output stream and its own timing events:

```
AudioIn ─► SttStage ─► TranscriptGate ─► AnswerStage(LLM) ─► PointSplitter ─┬─► OverlayOut
                                ▲                                         └─► Chunker ─► TtsStage ─► AudioOut
CaptureStage ─► ImageStage ─────┘ (image ready, optionally pre-cached)
```

`PipelineRunner` connects stages, gives every stage the interaction's `AbortSignal`, applies per-stage budgets and records events. The orchestrator shrinks to: map key and command events to the state machine, start or cancel a runner, and persist history from the event log.

### 6.2 Key-down: do everything that doesn't depend on the question

On key-down, in parallel: start streaming mic frames (warm mic, pre-roll already exists), open the STT socket (spare token already exists), grab and JPEG-encode a frame of the cursor's display, open the TTS streaming socket, warm the LLM connection, and (6.4) send the image ahead.

### 6.3 Speculative answer start

AssemblyAI streams partial transcripts while the user talks. At key-up the latest partial is usually the final text. The `TranscriptGate` starts the LLM request on the partial immediately, sends ForceEndpoint in parallel, and compares when the final arrives. If the final only differs by punctuation or casing, the speculative request continues. If it differs in words, the request is aborted and restarted with the final text, which costs no more time than today. Audio from a speculative answer is held (not played) until the final transcript confirms it, so the user never hears an answer to the wrong question.

As built: there is no separate `TranscriptGate` or machine sub-state. At key-up the orchestrator starts `runAnswer` on the interim transcript with a `confirm` promise and its own abort signal (`pipeline/speculation.ts`). The request goes out and its stream is pulled once, then the runner waits; trace marks go into a `HeldTrace` and are written to the real trace, with their original times, only on a hit. Comparison ignores case and punctuation. A guess is only made when the interim transcript has at least three words and hasn't changed for 250 ms before key-up (the user had stopped talking), since otherwise the final text almost always adds words.

### 6.4 Image sent ahead

The screenshot is ready at key-down, long before the question. Two options, chosen per provider:

- **Anthropic prompt-cache warm-up:** while the user is still talking, send the system prompt and image with a cache breakpoint and `max_tokens: 0` (prefill only, no output). The real request at key-up hits the cache, so the model only processes the question text, which cuts time to first token. It costs one extra small request per question, so it's a setting (on by default for voice).
- **Other providers:** keep the pre-encoded image and request body ready so key-up only appends the question.

As built: the cache only hits if the warm-up and the question share a byte-identical prefix, so with warm-up on the screenshot is taken 300 ms after key-down (after the tap threshold, so a tap sends nothing, and after the Clicky window has moved away) and the answer reuses that same screenshot instead of taking a new one at key-up. The context turns are fixed at key-down for the same reason. The breakpoint goes on the last image; the question follows it. Without warm-up no image is marked cacheable, so ordinary questions don't pay the cache-write price. The newest Claude models cache prefixes of 512 tokens or more; one 1280 px screenshot is well above that.

### 6.5 Eager first chunk

The chunker releases the first speakable clause (a comma, colon or about eight words) instead of waiting for a full sentence, then reverts to sentence chunks for natural prosody. The POINT-first prompt and parser stay as they are. As built: a clause break counts once the chunk has three words ("So," alone is too clipped); with no break the chunk ends after eight words. A sentence end that comes first still wins.

### 6.6 Persistent TTS stream

Replace one HTTP request per sentence with one streaming socket per interaction (ElevenLabs input streaming with a Flash model), opened at key-down. Text chunks go in as they arrive and audio comes back continuously. This reverses the Phase 2 deviation in plan §3.4, now that the pipeline makes it simpler to make robust. The per-sentence HTTP path stays as the fallback adapter.

As built: `ElevenLabsTts.prewarm` (called at key-down) opens `stream-input` with `auto_mode=true` and sends the key in the first message, never in the URL. `start` takes that socket if it's still open, or opens one, or falls back to HTTP if the socket won't open. Each chunk is sent with `flush: true` because it is already a whole clause or sentence. A policy close (1008) is reported as a key problem.

### 6.7 Hedged fallback

If the cloud voice hasn't produced audio within a budget (for example 700 ms after the first chunk was sent), the OS voice starts speaking the same text, and whichever starts first wins.

As built (`hedgedSpeech` in core): the budget is 1200 ms after the first chunk, so a normal cloud voice never trips it. Rather than racing both voices, the cloud voice is stopped and everything said so far is replayed into the Windows voice; once the cloud voice has started it is never switched, so no sentence is heard twice. A failure before first audio also switches. The trace records `voiceFallback`. The user is never left in silence (plan §3.3 point 9).

## 7. State management

- **Interaction state:** the existing `InteractionMachine` stays the single source of truth, inside the engine. It becomes a pure reducer over events (`keyDown`, `partial`, `transcriptFinal`, `firstToken`, `firstAudio`, `speechDone`, `fail`, `cancel`), so the same events drive the machine, the trace and the overlay. The machine gains a `speculating` sub-state for 6.3.
- **App state:** settings and credentials stay in main's stores. The engine receives an immutable, versioned snapshot and rebuilds provider instances only when the snapshot changes, not on every key press as today.
- **Per-interaction state:** lives in the runner and dies with it. Nothing from an old interaction can touch a new one, because every message on every port carries the interaction id and is dropped when it doesn't match.
- **UI state:** overlay and dashboard are pure views of events they receive; they hold no interaction logic.

## 8. Errors and observability

### 8.1 Typed errors

```ts
type FailureKind = 'auth' | 'wrong-key-type' | 'quota' | 'rate-limit' | 'network' | 'timeout'
                 | 'server' | 'bad-output' | 'device' | 'permission' | 'config';
class StageError extends Error { stage: Stage; provider?: string; kind: FailureKind; retryable: boolean }
```

Providers classify their own HTTP status and error bodies into a `FailureKind` (the OpenRouter "User not found" case becomes `wrong-key-type`). One table maps `(stage, provider, kind)` to the sentence the user sees, for example "OpenRouter rejected the key: it's a management key, not an API key."

### 8.2 Policies per stage

- **Budgets** instead of one global timeout: each stage has a time-to-first-output and an idle budget.
- **Retries** only where the call is idempotent and before any output reached the user (STT connect, LLM request before the first token).
- **Circuit breaker:** a provider that fails three times in a row is skipped in favour of its fallback for a minute, and the dashboard shows why.
- **No silent success:** a runner that ends without first audio or with an empty answer always ends in `error` (keeps AGENTS.md rule 4).

### 8.3 Trace

Every event carries the interaction id, stage, a monotonic timestamp from the engine's clock, and small metadata (bytes, token count, provider). Never transcript text, audio or images. From the event log the engine derives the plan §3.3 latency line, appends it to a local JSONL ring buffer (last 500 interactions), and the dashboard shows p50/p95 per stage. `pnpm bench` replays recorded audio and screenshots through the same runner and prints the same table, so laptop numbers and benchmark numbers are comparable.

## 9. Migration plan

Each step is one PR, keeps the app working, and is measured with the trace from step 1.

1. **Trace and typed errors** (landed). Event log, `StageError`, provider error classifiers, latency table in the dashboard. No behaviour change; this produces the real "before" numbers.
2. **Pipeline stages** (landed). Split the orchestrator into stages and a runner in `core`, with the existing behaviour and tests carried over. Still in main.
3. **Engine process and direct ports** (landed; needs the laptop check). Move the runner, providers and hold-key hook into a `utilityProcess`; wire media and overlay ports. Needs laptop verification of the hook.
4. **Speed features** (landed; needs the laptop check with real keys). Persistent TTS socket, eager first clause, image cache warm-up, speculative answer start, hedged fallback. Each is a setting under AI and voice > Speed (all on by default), so its effect shows up in the trace on its own. How each was built is noted under 6.3 to 6.7.

## 10. Working alongside Phase 2 fixes

Quick latency and reliability fixes keep landing on the Phase 2 branch (default model, screenshot size, key errors, local speech providers). The redesign builds on that branch and merges its later changes in. New providers plug in behind the core interfaces and need no orchestrator changes. Step 3, and anything involving the hook, mic, capture or audio, needs a check on the Windows laptop before it's called done.

## 11. Decisions

1. Architecture and four-step migration: approved (2026-10-11).
2. Image cache warm-up: on by default for voice questions, with a setting to turn it off.
3. Speculative answer start: on by default, with a setting to turn it off.
