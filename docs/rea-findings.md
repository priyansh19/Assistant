# REA pass over our build (2026-10-12)

REA ("Reverse Engineer Anything", npm `rea-agents` 6.4.0, github.com/morluto/rea, MIT) was run on our
own Electron build with `rea analyze-javascript-application` against `apps/desktop/out` from
`claude/laptop-draw` plus this branch. It reads the bundled JavaScript without running it.

## What it found

| Area | Result | Action |
|---|---|---|
| Window hardening | All 5 windows (dashboard, overlay, strip, orb, audio worker) set `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, each with its own preload. | None. |
| IPC sender checks | 9 main-process handlers; REA saw no sender validation on the task strip (Pause, Stop, **Allow**, **Allow all**) or the Allow-all orb. Dashboard and worker already check the sender. | **Fixed**: strip and orb handlers now ignore messages from any window but their own, so no other renderer can grant Allow all. |
| Utility process | One `utilityProcess` (the engine), entry resolved. No native add-ons in the bundle (`uiohook-napi` is loaded from node_modules). | None. |
| Network endpoints | OpenRouter models list plus the Anthropic SDK's full endpoint table. | None. |
| Bundle size | The engine chunk is about 940 KB, mostly the Anthropic SDK. | Not changed. It's parsed once when the engine starts, not on the key path. |

## The official app

The closed HeyClicky build (the DMG on github.com/farzaa/clicky-releases) is the target where REA
adds the most: `inspect-plist`, `inspect-macho`, `demangle-swift`, `decode-interface-builder` and
`inspect-asset-catalog` work without Hopper, and Ghidra gives pseudocode. The cloud session can't
download it (GitHub release downloads are blocked from there), so that pass runs where the DMG can
be fetched. The open-source app was already read line by line in
[`official-clicky-teardown.md`](official-clicky-teardown.md).
