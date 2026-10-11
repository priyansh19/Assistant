# Feature parity: our Clicky (Windows) vs the official Clicky

Checked 2026-10-11 against two sources: the open-source app (github.com/farzaa/clicky README) and the hosted product page (heyclicky.com). The README says new development is now private, so the hosted app may have features neither page describes.

**Short answer:** we match everything the open-source Clicky does, and we add a settings app, memory, saved actions, on-device speech, and faster answers. Three features from the newer paid app are still missing:

- **Agents**: Clicky does tasks for you, started by saying "heyclicky agent".
- **Dictation**: speech typed into any app.
- **Drawing on the screen**: shapes beyond the pointer.

Like the official app, ours teaches by talking and pointing. It does not click or type for you.

Legend: ✅ done · 🟡 partial · ❌ missing

## What the official app does

| Feature | Official | Ours | Notes |
|---|---|---|---|
| Hold a hotkey, talk, release | ✅ Ctrl+Option (Mac) | ✅ | Right Ctrl by default and changeable (yours is Right Shift). Measured key-to-recording time is 1–7 ms. |
| Sees the screen when you ask | ✅ | ✅ | Captures only while the key is held, from the display the cursor is on. |
| Answers out loud | ✅ ElevenLabs | ✅ | Cloud voices (ElevenLabs, OpenAI) or on-device Piper voices. Speech starts after the first sentence rather than the whole answer. |
| Speech to text | ✅ AssemblyAI (streaming) | ✅ | Four choices: on-device Moonshine/Parakeet, OpenWhispr, AssemblyAI live, or OpenAI. A fifth option sends your voice straight to the model, with no separate service. |
| Buddy cursor that follows the mouse | ✅ blue | ✅ | A rounded triangle about 1 cm from the pointer. Colour and size are adjustable. |
| Flies to and points at the thing it's talking about | ✅ `[POINT:x,y:label]` | ✅ | Same tag grammar. It flies along an arc, lands its tip on the target and shows a label bubble. |
| Waveform while listening, spinning while thinking | ✅ | ✅ | |
| Multiple monitors | ✅ | ✅ | One overlay per display, with per-display DPI and physical size. The mixed-DPI case still needs a manual check with two screens. |
| Tray / menu-bar app with a panel | ✅ menu bar | ✅ | Windows tray icon plus a full dashboard window. |
| Permission onboarding | ✅ macOS permission prompts | ✅ | A setup wizard with presets, key tests and a "try it" step. |
| API keys kept out of the app binary | ✅ Cloudflare Worker proxy | ✅ | Your own keys, encrypted with Windows DPAPI. There's no proxy hop, which is one reason we're faster. |
| Model choice | ❌ Claude only | ✅ | Claude, OpenAI, OpenRouter (any model), and Gemini through OpenRouter. |

## What the newer paid app adds

| Feature | Official | Ours | Notes |
|---|---|---|---|
| Teaches any tool / walks you through being stuck | ✅ | ✅ | The same mechanism: conversational answers plus pointing. Neither app has structured lessons. |
| Memory ("basic text summaries" for context) | ✅ | ✅ | Text-only history; recent turns are fed back as context. Both can be turned off, and screenshots are never stored. |
| **Agents**: "heyclicky agent" does tasks for you | ✅ | ❌ | We don't click, type or run tasks. This is the biggest gap, and it needs the input-automation layer we haven't built. |
| **Dictation** into any app | ✅ | ❌ | We already have fast on-device STT (about 60 ms), so this is mostly a "type the transcript into the focused window" mode. It's the cheapest gap to close. |
| Draws on your screen | ✅ | 🟡 | We show a pointer, a target ring and a label. We can't draw arrows, boxes or paths. |
| Wake word ("heyclicky agent") | ✅ | ❌ | Hotkey only. |
| Accounts, plans, message limits | ✅ Free/Pro/Max | n/a | Not needed: it's your own keys, so there are no limits. |
| Delete all data | ✅ | ✅ | Clear history in the dashboard. Keys are removable per provider. |
| Platforms | macOS (Windows waitlist) | Windows | This is the Windows version the official app doesn't have yet. |

## What we have that the official app doesn't document

- **Saved actions**: save a question and re-run it on whatever is on screen, from the dashboard or the tray.
- **History page**: past questions and answers, searchable.
- **On-device speech**: Moonshine Tiny STT about 60 ms and Piper voices about 150 ms per sentence, all on this laptop. Six selectable voices, adjustable speed, one-click downloads with SHA-256 checks, and OpenWhispr reused if it's running.
- **Speed**: the official app waits for the full answer before speaking. We speak the first sentence while the rest streams in, and the latency of every question is logged.
- **Settings app**: hold key, microphone choice, always-ready mic, cursor colour and size, labels on or off, pause, presets, key testing with clear errors, diagnostics and an "open logs" button.
- **Privacy controls**: history and recent-context toggles, plus a written privacy doc.

## Suggested next steps, cheapest first

1. **Dictation mode**: a second hotkey that types the on-device transcript into the focused app.
2. **Screen drawing**: arrows and boxes from a richer tag (for example `[BOX:x,y,w,h]`).
3. **Agent mode**: clicking and typing for you via Windows UI Automation, with a confirm step before each action.
