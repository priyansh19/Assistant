# HeyClicky 1.0.53: static pass over the shipped macOS app

**Source:** HeyClicky.dmg v1.0.53 (378 MB) from github.com/farzaa/clicky-releases, opened with 7-Zip on Windows. Nothing was installed or run.

**How the pass was done:** REA's tools (`npx rea-agents@6.4.0`) were blocked by this session's safety checks, because running a downloaded npm package needs a permission rule. This pass was done by hand instead:
- Info.plist was read with Python's plistlib.
- The bundle layout was listed.
- The bundled instruction files were read.

The REA outputs (Mach-O, nib and asset catalog) are still to do once that's allowed.

Keys and tokens in the plist (analytics, crash reporting, backend) are left out of this note.

## What the app is made of

- **Main binary:** `MacOS/HeyClicky`, about 85 MB, built with Xcode for macOS 14.2 and later. It's a menu-bar app (`LSUIElement`).
- **Computer use:** `Helpers/cua-driver`, about 66 MB, is the **Cua Driver**. HeyClicky supervises it as an embedded daemon and exposes it to its agent as a local MCP server named `computer-use`.
- **Agent runtime:** `Resources/CodexRuntime` holds an embedded Codex runtime. `ClickyCodexModelCatalog.json` lists the models. The plist points at a HeyClicky worker API and at the OpenAI and Anthropic APIs.
- **Integrations:** around 15 integration skills (Gmail, Google Docs, Outlook, Teams, Linear, Jira, HubSpot, Salesforce, ClickUp, Dropbox…) and app skills as Markdown (GitHub PR workflow, Notion, Obsidian, PowerPoint, Spotify, Maps, YouTube and others).
- **Sound and video:** separate cues for agent start, done, close and needs-you, plus text open, receive and send, skill up/down and a surprised sound. Voice previews come in about 14 styles. There are onboarding and paywall intro videos.
- **Updates:** Sparkle auto-update checks hourly. Sign-in uses the `clicky://` and `heyclicky://` URL schemes.

## How its agent works (from the bundled instructions, paraphrased)

1. **Each helper has its own folder and notes.** A named Clicky helper has a working folder whose AGENTS.md is its identity and dated notes. Durable facts (accounts, preferences, decisions) go into those notes with the date, never secrets. The newest dated fact wins, and what the user says now beats everything.
2. **Act, and only ask when needed.** It works out the intent and acts. It asks only when the result depends on something only the user knows, and then does the parts that don't depend on the answer first and asks one bundled set of questions.
3. **The most direct route first:**
   - the user's own data through connected apps;
   - outside facts from the web;
   - files through the shell;
   - **screen control only when nothing else can do it.**
4. **The request is the approval.** It does the writes it was asked for without asking again. It confirms only before deleting, overwriting what it wasn't asked to change, sending email (always drafted first) or spending money.
5. **Never claim what didn't happen**, and never invent facts, files or prices.
6. **Computer use goes through an accessibility snapshot, not screenshots.** The cua-driver skill:
   - snapshots the window's accessibility (AX) tree;
   - acts on **element tokens**, not pixel coordinates, in the background (no visible agent cursor);
   - checks each action's reported effect and snapshots again.

   There is a "fast lane", `drive_until`, that runs the snapshot, decide, act loop by itself at about 0.5 s a step from a one-sentence goal and a deny list. Input tools need the user's per-turn consent, shown as an Allow / Not now card.
7. **Deliverables** go in `output/` and checks happen before it says done: open it, render it, recompute.
8. **Final message:** the result first, plain and warm, no mention of tools, and a question only when the user must choose.

## What this means for our Clicky (Windows)

- **Biggest gap: accessibility-first actions.** We act on screenshot coordinates, and that is where most misses come from. On Windows, the equivalent of their AX snapshot is a **UI Automation tree snapshot** of the window in front. That means a numbered list of the buttons, edits, menu items and links with their names and bounds, and actions by element number (`click_element 12`, `set_value 7 "text"`). Screenshots would stay for checking and for anything UIA can't reach. We already have UIA for `locate` (click retargeting) and the answer snap.
- **Direct routes before the screen:** this matches our new `list_files` and `move_files` (shell-like file work) and opening URLs directly. Next would be web lookups without driving the browser.
- **Per-helper notes with dates:** close to our skills' "Learned" lists and the shortest-route lessons. Theirs are dated and newest-wins, which is worth copying.
- **Consent:** theirs is per turn (Allow / Not now card), ours is per risky step plus Allow all. Similar intent.
