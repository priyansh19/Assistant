# Privacy: what Clicky sends and stores

Clicky is a personal tool that calls AI providers directly with your own API keys. There is no Clicky server.

## When Clicky listens and looks

- **Microphone:** audio is only forwarded while you hold the hold-to-talk key. With *Keep the microphone ready* on (the default), the device stays open between presses so listening starts instantly; frames are kept in a ~200 ms in-memory ring buffer and discarded unless you press the key. Windows shows the microphone as in use while this is on. Turn it off in General > Microphone to open the device only while the key is held (the start of each question may be clipped).
- **Screen:** a capture stream opens when you press the key and closes as soon as one frame is taken after you let go. Typed questions and saved actions take one frame when you run them.
- The triangle cursor is always visible, and it shows a waveform while Clicky is listening.

## What each provider receives

| Provider | Receives | When |
|---|---|---|
| AssemblyAI (speech to text) | Your voice audio (16 kHz mono PCM) while the key is held | Each voice question |
| OpenAI (speech to text, if chosen) | A WAV of your voice question | Each voice question, after you let go |
| Anthropic / OpenAI / OpenRouter (answer model) | The screenshot(s) as JPEG (default 1280 px long edge; only the screen your cursor is on unless *Include all displays* is on), your question text, a short system prompt describing the screenshots, and, if *Follow-up questions* is on, the last few questions and answers from the past 10 minutes | Each question |
| ElevenLabs / OpenAI (voice, if chosen) | The answer text, sentence by sentence | Each answer |
| Windows voice | Nothing leaves the PC | Each answer |

Key checks in the dashboard call each provider's key or model endpoint; they send no screenshots or audio.

## What is stored on this PC

All under `%APPDATA%\Clicky\`:

| File | Contents |
|---|---|
| `credentials.json` | API keys, encrypted with Windows DPAPI for your user account (Electron `safeStorage`). Never stored in plaintext; if encryption is unavailable, keys are not saved. |
| `settings.json` | Your settings. No secrets. |
| `history.json` | Text-only history: question, answer, what was pointed at, timing. Turn off with *Remember history*; clear from the History page. |
| `actions.json` | Saved actions (name + question). |
| `logs/clicky.log`, `logs/latency.jsonl` | Diagnostics and per-question timing. Strings that look like API keys are masked. No audio, images, questions or answers are logged. |

Screenshots and audio are never written to disk.
