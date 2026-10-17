# Feature parity: our Clicky (Windows) vs the official Clicky

Checked 2026-10-11 against two sources: the open-source app (github.com/farzaa/clicky README) and the hosted product page (heyclicky.com). The README says new development is now private, so the hosted app may have features neither page describes.

**Short answer:** we match everything the open-source Clicky does, and as of 2026-10-11 also the three features from the newer paid app that were missing: agents, dictation and drawing on the screen. On top of that we have a settings app, memory, saved actions, on-device speech and faster answers.

Like the official app, ours teaches by talking and pointing. It does not click or type for you.

A source-level teardown of the open-source app, feature by feature, is in [official-clicky-teardown.md](official-clicky-teardown.md) (2026-10-12).
REA (Reverse Engineer Anything) results for our own build are in [rea-findings.md](rea-findings.md).

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
| **Agents**: "heyclicky agent" does tasks for you | ✅ | ✅ | Start a question with "Agent". Clicky clicks, types, presses shortcuts and scrolls, flying the cursor to each target first. Sending, buying, deleting and similar steps wait for your hold key (or every step, if you choose). Esc or Stop in the notch ends it, it never types passwords, and it checks every step worked. |
| **Dictation** into any app | ✅ | ✅ | Hold the dictation key (Right Alt by default) and talk; the words are typed where the text cursor is. It uses the on-device speech model when available and is never saved to history. |
| Draws on your screen | ✅ | ✅ | Besides the pointer, answers can draw up to three arrows, boxes and circles with labels. Asked to draw ("draw a smiley", "underline the total", "write hello"), Clicky sketches up to twelve marks: freehand lines, highlights and handwriting too. The triangle is the pen and draws each mark in turn; they fade about 20 seconds later. The tray's "Show me a drawing" plays a built-in example. Drawing inside apps such as Paint is an agent task with a drag (pen stroke) action. |
| Wake word ("heyclicky agent") | ✅ | 🟡 | Saying "agent" starts agent mode, but only while the hold key is down. There's no always-listening wake word. |
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

## Suggested next steps

1. **Always-listening wake word**: "hey Clicky" without holding a key, using a small on-device keyword model.
2. **Agent memory**: save a finished agent task as a saved action, so it can be repeated with one click.
