# Official Clicky, feature by feature (source teardown)

Read on 2026-10-12 from the open-source repo **github.com/farzaa/clicky** (macOS, Swift, MIT; about 8,000 lines in `leanring-buddy/`). Also checked the two Windows ports, **emreyilmaz46/clicky_windows** (C#) and **tekram/clicky-windows** (Electron). Our side was read from branch `claude/laptop-draw`, the current laptop build.

The repo is the open-source version. The paid HeyClicky app adds agents, dictation, skills and a notch; those are covered in `research/founder-videos-breakdown.md` and are not repeated here.

Legend: ✅ we have it · 🟡 partial or different · ❌ missing · ⛔ deliberately skipped

## 1. Hold-to-talk loop (`CompanionManager.swift`, `GlobalPushToTalkShortcutMonitor.swift`)

| What the official app does | Ours | Gap |
|---|---|---|
| Ctrl+Option via a listen-only CGEvent tap. On key-down it cancels the previous answer, stops the voice, clears any pointing, and closes the menu panel so the panel isn't in the screenshot. | ✅ uiohook on Right Ctrl (changeable). A new press interrupts everything. | None. |
| A quick tap with no speech still clears the overlay; there's a guard for the start task racing the release. | ✅ | None. |
| A state machine: idle → listening → processing → responding. The spinner stays up until the **first audio actually plays**. | ✅ A richer machine (transcribing, thinking, speaking, cancelled, error). | None. |
| **Waits for the whole Claude answer before speaking** (`analyzeImageStreaming`, `onTextChunk` ignored, then one ElevenLabs call). | ✅ Ours is faster: it streams sentence by sentence. | We're ahead. |
| Conversation history: the last 10 exchanges, with POINT tags stripped. | ✅ Recent-context toggle, the same idea. | None. |
| On any failure it speaks a fixed line with macOS system TTS ("I'm all out of credits…"). | 🟡 We show an amber bubble with the reason, and the Windows voice backs up a slow cloud voice. | Fine as is. |

## 2. Screen capture (`CompanionScreenCaptureUtility.swift`)

| Official | Ours | Gap |
|---|---|---|
| Every display, with the cursor display first. JPEG quality 0.8, long edge 1280. | ✅ All displays by default, cursor display first, long edge configurable. | None. |
| Each image is labelled "screen 1 of 2, cursor is on this screen (primary focus)" plus its pixel size. | ✅ The prompt lists `screenN: WxH (the cursor is on this screen)`. | None. |
| **Clicky's own windows are excluded from the screenshot** (`SCContentFilter(excludingWindows: ownAppWindows)`), so the model never sees the panel, bubbles or cursor. | ❌ The notch, task strip, orb, label bubbles and drawings can all end up in the screenshot. | **Build** (P3). |

## 3. The prompt (`companionVoiceResponseSystemPrompt`)

| Official | Ours | Gap |
|---|---|---|
| Defaults to 1–2 sentences, **but "if the user asks you to explain more, go deeper, or elaborate, go all out, with no length limit"**. | ❌ We always cap at 1–3 sentences, so "explain this in detail" gets three sentences. | **Build** (P1). |
| "Don't end with yes/no questions like 'want me to explain more?'. Plant a seed instead: something bigger they could try next." | ❌ | **Build** (P1). |
| "Don't read code out verbatim; describe what it does." "Never say simply or just." "You can help with anything: coding, writing, general knowledge." | 🟡 We have no code rule, and our "never guess facts" rule pushes general questions toward the agent. | **Build** the code rule and the general-knowledge line (P1). |
| Pointing: "err on the side of pointing", with worked examples and `[POINT:x,y:label:screenN]` placed at the **end**. | ✅ Same grammar. Ours puts the tag **first** (faster) and uses 0–1000 positions (more accurate across models). | We're ahead. |

## 4. Pointing precision (`ElementLocationDetector.swift`, and clicky_windows)

| Official | Ours | Gap |
|---|---|---|
| A second pass sends the screenshot to Claude's **Computer Use tool** (`computer_20251124`) at the recommended resolution closest to the display's aspect ratio (1024×768, 1280×800 or 1366×768), then scales back. This is in the repo but **not wired up** (dead code); clicky_windows ships it. | 🟡 Agent clicks are snapped to the real control with UI Automation (`Locate`). **Answer pointing is not**: the triangle lands wherever the model guessed. | **Build** (P1): snap the answer's POINT to the UI Automation control that matches its label, near the guessed spot. It's local and takes about 20–100 ms, so there's no extra model call and no extra cost. |

## 5. The cursor buddy (`OverlayWindow.swift`)

| Official | Ours | Gap |
|---|---|---|
| A 16 pt equilateral blue triangle, rotated −35°, sitting +35/+25 pt from the mouse. It follows with a spring (response 0.2, damping 0.6) at 60 fps. | ✅ A rounded triangle about 1 cm from the pointer, with spring trailing; size and colour can be changed. | None. |
| While listening, the triangle **becomes** a 5-bar waveform driven by the mic level. While thinking, it becomes a spinner. They cross-fade. | 🟡 The triangle stays, spins with a light tracing it, and the waveform sits beside it. | A style choice; keep ours (closer to the newer HeyClicky). |
| Flight: a quadratic Bézier arcing up (height `min(dist·0.2, 80)`), smoothstep easing, duration `dist/800` clamped to 0.6–1.4 s. The tip faces along the tangent, it grows to 1.3× mid-flight and the glow brightens. | ✅ Same curve family, tangent heading and mid-flight scale (1.35×). | None. |
| On arrival the label bubble **types itself in** at 30–60 ms per character, popping from 0.5× to 1× with a bright glow that settles. With no label it uses a random "right here!" / "found it!". | 🟡 Our bubble appears all at once. | **Build** (P2), small. |
| Holds 3 s after the text finishes, fades, then flies back. **On the way back, moving the mouse more than 100 px cancels the return**, so the buddy snaps to you. The outbound flight can't be interrupted. | 🟡 We return too, but moving the mouse doesn't cut the return short. | **Build** (P2), small. |
| Only one buddy across all displays. | ✅ | None. |

## 6. First run and onboarding (`CompanionPanelView`, `CompanionManager`, `OverlayWindow`)

| Official | Ours | Gap |
|---|---|---|
| A panel with an email field and a Start button, plus four permission rows that update live (polled every 1.5 s). | ✅ A setup wizard with key tests and a microphone check. | None (Windows has fewer permissions). |
| On Start: the cursor fades in over 2 s and **types "hey! i'm clicky"** next to the mouse. | ❌ | **Build** (P2). |
| An intro video plays next to the cursor, with music. At 40 s **Clicky looks at your screen and flies to one specific thing in the middle 60 % of it, with a quirky 3–6 word comment** (a separate prompt that asks for no quoting and no edges). | ❌ | **Build** the look-around moment (P2). ⛔ Skip the video and music: they're Farza's assets. |
| After that, it types "press control + option and introduce yourself", which clears itself after 10 s. | 🟡 The wizard has a "Try it now" button. | **Build** the overlay prompt (P2). |
| "Watch onboarding again" link. | ❌ | **Build**: a tray item "Say hi again" (P2). |

## 7. Menu bar panel (`MenuBarPanelManager`, `CompanionPanelView`)

| Official | Ours | Gap |
|---|---|---|
| A triangle menu-bar icon opens a dark floating panel (non-activating, closes on an outside click). It has status, a Sonnet/Opus picker, the speech-to-text provider, "DM me feedback", Quit and "Watch onboarding again". | ✅ Tray plus a full dashboard (models, voices, history, saved actions, settings). | Only the replay item is missing (above). |
| **"Show Clicky" off = transient cursor**: no buddy on screen until you press the key. It fades in for that interaction, then fades out 1 s after the voice and pointing finish. | ❌ We only have Pause, which also turns the key off. | **Build** (P2). |

## 8. Speech in and out

| Official | Ours | Gap |
|---|---|---|
| AssemblyAI v3 streaming (`u3-rt-pro`), `ForceEndpoint` on release, a 2.8 s fallback, and the partial transcript is delivered if the socket dies. One shared URLSession (otherwise "socket is not connected" after quick re-presses). OpenAI upload and Apple Speech as fallbacks. | ✅ AssemblyAI streaming with ForceEndpoint and an adaptive wait, plus local, OpenAI and audio-to-model options. | None. |
| **Key terms** (product names) are sent to the recogniser, with a hook for contextual ones. | ✅ (owned by the laptop thread). | None. |
| ElevenLabs `eleven_flash_v2_5` through the Worker. | ✅ Plus a streaming WebSocket voice and local voices. | We're ahead. |
| TLS warm-up: a HEAD request to the API host at start. | ✅ We pre-warm connections at key-down. | None. |

## 9. Distribution and plumbing

| Official | Ours | Gap |
|---|---|---|
| **Sparkle auto-update** (`appcast.xml`, `scripts/release.sh`, which signs, notarises and builds a DMG). | ❌ Each laptop build is installed by hand. | **Later** (P4): electron-updater from GitHub Releases. It needs a release flow decision from Priyansh. |
| A Cloudflare Worker holds the keys. | ✅ Our own keys, held in safeStorage. | We're ahead (no proxy hop). |
| PostHog analytics, and email capture to FormSpark. | ⛔ | Skip, for privacy. |

## Build order

- **P1 (this PR)**: snap answer pointing to the real control; prompt parity (elaborate on request, plant a seed, code rule, help with anything).
- **P2 (this PR)**: the label types in with a pop; moving the mouse cancels the return flight; the "meet Clicky" first run (welcome line, look-around comment, "hold Right Ctrl and introduce yourself") plus a "Say hi again" tray item; the "Show Clicky" setting for the transient cursor.
- **P3 (done)**: keep Clicky's own windows out of its screenshots (setting *Keep Clicky out of screenshots*, on by default).
- **P4**: auto-update. This needs Priyansh to decide how releases are published.

## HeyClicky 1.0.53, the shipped app (static pass, 2026-10-12)

From the laptop's static pass over the DMG (`research/heyclicky/static-pass-2026-10-12.md`). REA's own tools were blocked on the laptop, so this comes from the plist, the bundle layout and the bundled agent instructions.

| HeyClicky | Ours | Status |
|---|---|---|
| Computer use acts on accessibility-tree element tokens (Cua Driver) and screenshots only check the result. | UI Automation retargets clicks and snaps answer pointing. Agent steps still act on screenshot positions. | **Being built** in the laptop thread: a UIA element snapshot with numbered elements. |
| The agent picks the most direct route: connected apps, then the web, then the shell, and the screen last. | Opens URLs and files directly, and has file listing and moving. No web lookups without the browser, and no app connectors. | Web lookups are a next step. Connectors (Gmail, Linear, Jira and so on) are a larger decision. |
| "The request is the approval": it confirms only before deleting, overwriting, sending email or spending money. It never claims what didn't happen. | The agent rules already ask before buying, deleting, submitting forms or installing (`packages/core/src/agent.ts`). There is per-step approval plus Allow all. | Same intent. None. |
| Dated notes per helper; the newest fact wins and what the user says now beats everything. | Skills' "Learned" lists, shortest-route lessons and remembered corrections. | Partly. Adding dates and newest-wins would be a small change in the skill and lesson stores. |
| Sound cues: agent start, done, close, needs-you; text open, receive and send. | Key-down and key-up cues. | **Built**: a "needs your OK" cue when a task waits for approval. No "done" sound, because it would sound the same when a task fails. |
| Clicky's windows are filtered out of its captures. | They could appear in screenshots. | **Built**: content protection on the cursor, bubbles, task bar and orb (a setting, on by default). |
| Sparkle auto-update, checking hourly. | Installed by hand. | Needs Priyansh's decision on how releases are published. |
| Embedded Codex runtime, a model catalogue and a worker API that holds keys. | OpenRouter and Anthropic, with the user's own keys in safeStorage. | We're ahead on privacy. |
