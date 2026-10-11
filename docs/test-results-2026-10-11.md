# Clicky full test suite, 11 Oct 2026

The build tested is master after PR #14, the same build that is now installed on the ASUS.

## Code checks

| Check | Result |
|---|---|
| Typecheck (core, providers, desktop) | Pass |
| Lint | Pass, 0 problems |
| Unit tests | **232 / 232 pass** (22 files) |
| In-app smoke tests (hidden overlay) | Pass. Covered: write mode with streaming, "shorter" and undo; tidied lists; a pointed answer with drawings; an agent run with the notch |

## Voice suite (spoken prompts, real pipeline)

Each prompt is spoken by the on-device Piper voice and fed in place of the microphone. On-device Moonshine speech-to-text transcribes it, and the real answer model (your OpenRouter key) replies. The suite checks what Clicky heard, what it said, where it pointed and what it did. Clicks and typing are recorded but not performed; only "open" actions really launch, where a scenario asks for it. Scenarios live in `apps/desktop/e2e/scenarios/`.

**Final run: 11 / 13 pass.** Run 1 passed 9 / 13; the failures it found are fixed.

| # | Scenario | Result | Clicky heard | Notes |
|---|---|---|---|---|
| 01 | Point: where is the Start button | PASS | Where is the start button? | |
| 02 | Explain: what am I looking at | PASS | What am I looking at right now? | |
| 03 | Both screens | PASS | What is on my other screen? | Every display was sent |
| 04 | Open an installed app (Notepad) | FAIL, test wording | Plicky, open note-pad. | Clicky handled it correctly. The test expected "notepad" without a hyphen; fixed after the run |
| 05 | Open a website (default browser) | PASS | Clicky, open the website example.com | |
| 06 | Multi-step: open Notepad and type | PASS | Clicky, open notepad and type hello world. | Notepad opened for real; typing recorded |
| 07 | Right Alt dictation is verbatim | PASS | How are you doing today? | Typed exactly, with no AI reply |
| 08 | Right Alt "write a thank-you note" | PASS | Write a short thank you note to Sam for the help. | Run 1 heard "Right a…" and typed it; now fixed |
| 09 | "Hey Clicky." alone | FAIL, speech model | (nothing) | The small Moonshine model returns empty text for a clip this short |
| 10 | "Hi Clicky" on Right Alt | PASS | (nothing) | Nothing typed |
| 11 | "Remember Comet is on my taskbar" | PASS | Clicky, remember that Comet is on my taskbar. | Saved and confirmed |
| 12 | Misheard name: "Click here, open Notepad" | PASS | Click here, open notepad. | |
| 13 | Noisy audio | PASS | Players the start button | Still understood as a Start-button question |

## Fixed because of this suite

- **The name, as heard:** "Plicky", "High-clicky" and "Click here" now count as the name. The verb "click" ("click the save button") does not.
- **"Write" heard as "right":** "Right a short note…" is treated as "Write a short note…", and the instruction is corrected before it goes to the model.
- **Misheard app names:** they now match the closest installed app ("note bed" opens Notepad).

## Known limits

- **Very short clips:** the on-device Moonshine Tiny model sometimes returns nothing for a two-word clip like "Hey Clicky.". Your live setup uses AssemblyAI, which wasn't part of this suite.
- **Screen descriptions:** the cheap answer model sometimes misdescribes the screen. For example, it said the Start button "is not visible" while still pointing at something. A stronger model in the model picker fixes that, at a higher cost.

## Run it again

From `apps/desktop`, after `electron-vite build`:

```
electron e2e/voice-suite.cjs --user-data <copy of %APPDATA%\Clicky> --models <folder with the Moonshine and Piper models>
```

The report is written to `<user-data>/e2e-report/report.md`.
