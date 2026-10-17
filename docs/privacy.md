# Privacy: what Clicky sends and stores

Clicky is a personal tool that calls AI providers directly with your own API keys. There is no Clicky server.

## When Clicky listens and looks

- **Microphone:** audio is only forwarded while you hold the hold-to-talk key. With *Keep the microphone ready* on (the default), the device stays open between presses so listening starts instantly; frames are kept in a ~200 ms in-memory ring buffer and discarded unless you press the key. Windows shows the microphone as in use while this is on. Turn it off in General > Microphone to open the device only while the key is held (the start of each question may be clipped).
- **Screen:** a capture stream opens when you press the key and closes as soon as one frame is taken after you let go. Typed questions and saved actions take one frame when you run them.
- The triangle cursor is always visible, and it shows a waveform while Clicky is listening.

## What each provider receives

| Provider | Receives | When |
|---|---|---|
| AssemblyAI (speech to text) | Your voice audio (16 kHz mono PCM) while the hold key or the dictation key is held | Each voice question or dictation |
| OpenAI (speech to text, if chosen) | A WAV of your voice question | Each voice question, after you let go |
| Anthropic / OpenAI / OpenRouter (answer model) | The screenshot(s) as JPEG (default 1280 px long edge; only the screen your cursor is on unless *Include all displays* is on), your question text, a short system prompt describing the screenshots, and, if *Follow-up questions* is on, the last few questions and answers from the past 10 minutes | Each question. During a guided walkthrough, also after each of your clicks on the ringed target: Clicky takes a fresh screenshot (without the key held, with the ring and cursor showing) and asks for the next step, at most 8 times per walkthrough. A hard question ("think it through", "pros and cons") goes to the stronger model of the same provider set in *Hard-question model*. With *Answer as you let go* on, the question may be sent twice: first as heard so far, then as finally transcribed if the words differ (the first request is cancelled). With *Send the screen early* on (Claude only), the screenshot, system prompt and recent turns are sent about 0.3 s after you press the key, while you are still holding it, and Anthropic keeps them in its prompt cache for a few minutes |
| ElevenLabs / OpenAI (voice, if chosen) | The answer text, phrase by phrase. With ElevenLabs a voice connection opens when you press the key; your key is sent in its first message, not in the address. With *Spoken beats* on, a fixed list of short lines ("On it.", "Let me think.") is sent once to be pre-rendered; it holds nothing about you or your screen | Each answer; the beat lines at launch and when settings change. With *Keep the voice path warm* on, a spare connection is kept open for 10 minutes after you last used Clicky |
| Windows voice | Nothing leaves the PC | Each answer |

**Agent mode** (off until you turn it on and accept its rules; a request starting with the assistant's name, such as "Clickey, open VS Code") sends the answer model a new screenshot before each step, with the task and the steps taken so far, for each step while the task runs (no fixed step limit; a high safety ceiling stops runaway loops). Clicky then clicks and types on this PC itself; nothing about those actions goes to any other service. **Dictation** sends your voice only to the speech-to-text service (or keeps it on the PC with on-device speech). The words are typed where your text cursor is, and nothing goes to the answer model or into history.

**Write mode** (an instruction spoken with the dictation key, such as "reply to this") sends the answer model a screenshot, your instruction and any text you had selected. Clicky reads the selection by pressing Ctrl+C and then puts your clipboard back exactly as it was (it skips this in terminals). Clicky only types the result where your cursor is; it never sends or submits anything.

**Writes like me** (style learning) learns how you write from text you wrote that is visible in write-mode screenshots, summarised by the answer model as part of those same requests, and from your plain dictation, kept as short examples. It is never collected in excluded apps (password managers by default), and you can view, edit or clear it in the dashboard.

**Playbooks** you write are added to the prompt sent to the answer model, so it receives their text with each question.

**OpenRouter** uses free models (names ending in `:free`) by default, and falls back to another free model in the list if one is busy. Free models on OpenRouter may be run by providers that log or train on prompts, including screenshots; pick a paid model in Settings if that matters for what is on your screen.

**Helpers** (named Clickys you make on the Helpers page) add their job, standing preferences and recent notes to the agent prompt when you ask one of them for something, so the answer model receives that text with each step of that task. Notes that look like keys, passwords, PINs or card numbers are refused and never written.

**Routines** run an agent task on a schedule, only while you are away from the mouse and the PC is online. Each run sends the same things as any agent task.

**Custom connectors** (MCP servers you add) receive the keys you give them: as environment variables for a local server, or as request headers for a remote one. When you press Check, Clicky connects and asks the server for its list of tools; nothing else is sent. Clicky does not yet call connector tools during tasks.

Key checks in the dashboard call each provider's key or model endpoint; they send no screenshots or audio.

## What is stored on this PC

All under `%APPDATA%\Clicky\`:

| File | Contents |
|---|---|
| `credentials.json` | API keys, encrypted with Windows DPAPI for your user account (Electron `safeStorage`). Never stored in plaintext; if encryption is unavailable, keys are not saved. The main process decrypts them and passes them in memory to Clicky's engine process (a background Node process that calls the providers); they never reach a window. |
| `settings.json` | Your settings. No secrets. |
| `history.json` | Text-only history: question, answer, what was pointed at, timing. Turn off with *Remember history*; clear from the History page. |
| `actions.json` | Saved actions (name + question). |
| `style.json` | What *Writes like me* has learned about your writing: a short text summary and a few example sentences. Clear it from the dashboard. |
| `playbooks\` | Your playbooks, one text file each. |
| `clickys.json` | Your helpers: name, job and when each was made. Their notes and preferences live in `Documents\Clicky\<Name>\AGENTS.md`, next to their `output` and `tmp` folders. Removing a helper never deletes its folder. |
| `routines.json` | Your routines: what to do, how often, and the last run's short result. |
| `connectors.json`, `connector-secrets.json` | Custom connectors by name, address or command. Their keys are in the second file, encrypted with DPAPI like your API keys; the dashboard only ever shows which keys are saved, never their values. Changing a connector's address or command clears its saved keys. |
| `logs/clicky.log`, `logs/latency.jsonl` | Diagnostics and per-question timing per stage, plus which provider and model answered and, on failure, which stage and provider failed. Strings that look like API keys are masked. No audio, images, questions or answers are logged. |

Screenshots and audio are never written to disk. Clicky's own windows (its cursor, bubbles, task bar and orb) are kept out of every screenshot while *Keep Clicky out of screenshots* is on (the default). This uses Windows' capture exclusion, so they don't appear in screen recordings or screen sharing either.
