# Testing Clicky on the laptop

Clicky 0.1.0 is installed (Start menu and Desktop shortcut "Clicky"). To reinstall from source: `corepack pnpm@10.23.0 install && corepack pnpm@10.23.0 dist`, then run `apps/desktop/release/Clicky-Setup-0.1.0.exe`. Windows may show "Windows protected your PC" because the build isn't code-signed: click **More info → Run anyway**.

## 1. First run (about 5 minutes)

1. Open **Clicky** from the Start menu. The setup wizard opens.
2. **Choose your AI services.** Recommended: Claude + AssemblyAI + ElevenLabs. Fastest to set up: "Just OpenAI" (one key).
3. **Add your keys.** Paste each key and press Save; each is checked straight away. A red *Rejected* means the key, credit or model is wrong, and the message says which.
4. **Microphone.** Press *Test microphone* and talk; the bar should move. If Windows blocks it: Settings → Privacy & security → Microphone → allow desktop apps.
5. **Talk key and voice.** Hold Right Ctrl: the wizard should say it was detected (no Right Ctrl on your keyboard? pick another key). Press *Play sample* to hear the voice.
6. **You're all set → Try it now.** Clicky hides the window, looks at your screen, answers out loud, points, and the window comes back with the answer.

## 2. Voice questions

- Hold **Right Ctrl**, ask "What am I looking at?", let go. Watch the triangle: waveform while you talk, spinning while it thinks, then it flies to what it's talking about with a label.
- Ask "Where is the Start button?" or open an app and ask "How do I save this as PDF?".
- Follow-up: "And where's the other one?" should use the previous answer.
- **Esc** stops an answer. A quick tap of the key is ignored.

## 3. Things worth checking

| Check | Expected |
|---|---|
| Speed | Home shows *Last response* and *Typical response* (key up → first word). |
| History | Every question appears with answer, what was pointed at and timing. *Save as action* works. |
| Actions | Run a saved action from Actions or the tray menu (right-click the tray icon → Run action). |
| Second screen | Detach the keyboard (Zenbook Duo lower screen) and ask about something on it; the triangle should point on the right screen. Turn on *Include all displays* in General if needed. |
| Errors | Remove a key and ask: the overlay says keys are missing and Clicky opens on API keys. |
| Pause | Tray → Pause Clicky: the key is ignored and the triangle dims. |

## 4. If something goes wrong

About → **Copy diagnostics** puts version, settings, which keys are saved (never the keys) and recent errors/timings on the clipboard. About → **Open log folder** shows the logs.

## Notes

- Default answer model: `claude-opus-5-5` at low effort. For faster answers try `claude-haiku-5-5` in AI and voice → Model, and compare *Typical response* on Home.
- *Keep the microphone ready* (General) is on by default so listening starts instantly; Windows shows the mic as in use while Clicky runs. See `docs/privacy.md`.
