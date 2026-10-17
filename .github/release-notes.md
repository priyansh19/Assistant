## Clicky {{VERSION}}

Hold a key, ask about what's on your screen, hear the answer and watch Clicky point at it.

### Downloads

| System | File |
|---|---|
| Windows 10/11 (x64) | `Clicky-Setup-{{VERSION}}.exe` |
| macOS (Apple Silicon) | `Clicky-{{VERSION}}-mac-arm64.dmg` |
| Linux (x64, X11) | `Clicky-{{VERSION}}-linux-x86_64.AppImage` or `Clicky-{{VERSION}}-linux-amd64.deb` |

### These builds are not code-signed

There are no signing certificates yet, so Windows and macOS warn before the first launch. The files come straight from this repository's release workflow.

**Windows.** If SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**. If your browser blocks the download, choose **Keep** (Edge: the `...` menu next to the download).

**macOS.** The app is ad-hoc signed, not notarized. Open the `.dmg` and drag Clicky to Applications. On first launch macOS says it can't verify the developer:
1. Right-click (or Control-click) Clicky in Applications and choose **Open**, then **Open** again. On macOS 15 and later, instead open **System Settings > Privacy & Security**, scroll down and click **Open Anyway** next to Clicky.
2. If macOS still says the app "is damaged and can't be opened", run this in Terminal once and open it again:
   `xattr -cr /Applications/Clicky.app`
3. Allow **Microphone**, **Screen Recording** and **Accessibility** for Clicky when asked (System Settings > Privacy & Security). Clicky needs Accessibility to notice the hold-to-talk key.
4. On a Mac the default talk key is **Right Command** (the "Right Ctrl" setting). Right Option, Caps Lock and the F-keys work too.

**Linux.** AppImage: `chmod +x Clicky-*.AppImage` and run it. Debian/Ubuntu: `sudo apt install ./Clicky-*-linux-amd64.deb`. Clicky needs an X11 session; Wayland is not supported.

### Known limitations

- Windows is the main platform. macOS and Linux are newer and less tested; agent mode (Clicky clicking and typing for you) is Windows only for now.
- Windows: works straight after install with no account and no keys. The installer (~1.9 GB) carries an open-source AI model, speech recognition and a voice that run on your PC. For faster answers, add an OpenRouter key in the setup wizard or in AI and voice.
- macOS and Linux: bring your own API keys in the setup wizard (the built-in AI is Windows only for now). Keys are stored with the OS keychain (DPAPI, Keychain, libsecret).
