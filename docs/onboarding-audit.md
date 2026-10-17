# Onboarding audit: what a new user had to do on their own

Date: 2026-10-17. Question: after someone downloads `Clicky-Setup.exe` from a link, what must they do by hand before Clicky answers, and what can the installer do for them instead?

## Before this change

| # | Step the user had to do | Why | Now |
|---|---|---|---|
| 1 | Create accounts with Anthropic, AssemblyAI and ElevenLabs, add billing, copy three API keys | The defaults for a fresh profile were Claude + AssemblyAI + ElevenLabs; skipping the wizard left Clicky unable to answer | **Removed.** A fresh install uses the built-in AI (Qwen3-VL 2B, run by llama.cpp on the PC), on-device speech recognition (Moonshine Tiny) and an on-device voice (Piper Lessac). No account, no key. An OpenRouter key is optional, for faster answers |
| 2 | Wait for ~175 MB of speech models to download during setup (and have a working connection to GitHub) | The on-device models were downloaded on first use | **Removed.** Moonshine Tiny and two voices (Lessac, Ryan) ship inside the installer and are used straight from the install folder |
| 3 | Install Ollama and pull a vision model to run Clicky without a cloud service | The only offline answer model was an external Ollama install | **Removed.** The installer carries llama.cpp's server and the model; Clicky starts it on 127.0.0.1 when it is the answer model and stops it otherwise |
| 4 | Install the Visual C++ Redistributable if the model server won't start | llama.cpp's Windows build links the Microsoft C++ runtime | **Removed.** The build copies `msvcp140.dll`, `vcruntime140.dll` and `vcruntime140_1.dll` next to the server (app-local deployment). If it still fails to start, the dashboard says why |
| 5 | Pick a combination of AI services in the wizard and understand what each costs | Six presets, all needing keys | **Simplified.** "Free and offline" is first and already selected; the keys page is skipped when nothing needs a key |
| 6 | Click past SmartScreen ("Windows protected your PC": More info, Run anyway) | The installer isn't code-signed | **Still needed.** Needs a code-signing certificate (an EV certificate removes the warning at once; a standard one builds reputation over time). Steps are in the release notes |
| 7 | Allow desktop apps to use the microphone if Windows privacy settings block it | Windows setting, off on some managed PCs | **Still needed**, but the wizard's microphone test detects it and says exactly which switch to turn on |
| 8 | Pick another talk key on laptops without Right Ctrl | Hardware | Already handled by the wizard (it waits for the key and suggests another) |
| 9 | Find Clicky in the tray overflow (^) | Windows hides new tray icons | Already handled: the wizard says where it is, and the Start menu shortcut reopens the dashboard |
| 10 | Turn on "Start with Windows" | Off by default | Still a choice on the wizard's last page (left off by default so nothing auto-starts without asking) |

## What the installer now carries

Listed in `apps/desktop/bundle.json` and fetched by `pnpm fetch-bundle` (also run by `pnpm dist` and the release workflow), each file checked against its SHA-256:

| Component | License | Size |
|---|---|---|
| llama.cpp server, Vulkan build (GPU if present, else CPU) | MIT | ~50 MB |
| Qwen3-VL 2B Instruct, Q4_K_M | Apache-2.0 | 1.11 GB |
| Qwen3-VL 2B vision encoder (mmproj), Q8_0 | Apache-2.0 | 0.45 GB |
| Moonshine Tiny int8 (speech to text) | MIT | ~110 MB |
| Piper voices Lessac and Ryan (medium) | see each voice's model card | ~130 MB |

Total about 1.94 GB of files (the llama.cpp folder is ~95 MB unpacked); the setup .exe ends up close to that after compression.

## Why not every model

NSIS (the installer format) keeps offsets in 32 bits, so a single setup .exe cannot pass 2 GiB. The built-in AI alone is 1.56 GB. The extras, Parakeet v3 (487 MB, better accuracy and 25 languages) and four more voices (~270 MB), would take the installer to about 2.6 GB, so they stay one-click downloads in Clicky > AI and voice. `pnpm fetch-bundle --all` includes them, but then the files have to be shipped as a folder (or zip) next to a smaller setup rather than one .exe.

## Trade-offs to know

- **Speed.** The built-in model on a laptop takes a few seconds per answer, slower than the speed release gate (key-up → first audio p50 < 1.2 s) that the OpenRouter default meets. It is the zero-setup start; "Fastest: OpenRouter" in the wizard and AI and voice is one key away.
- **Pointing.** A 2B model points less accurately than the cloud models. Answers and voice are fine; expect more misses on small controls.
- **Memory.** The server holds about 2 GB of RAM while it is the answer model; switching to another provider stops it.
- **Agent mode** still needs OpenRouter (Claude Haiku 5.5 steps); it stays off until the user sets it up.

## Still to verify on Windows hardware

Nothing in this change has run on Windows yet (cloud sessions can't): `pnpm fetch-bundle` (and `--pin` for the llama.cpp zip, whose SHA-256 isn't recorded yet), `pnpm dist`, installer size under 2 GiB, a clean install on a PC with no Clicky data, the built-in AI starting and answering with a screenshot, its first-answer latency, and uninstall.
