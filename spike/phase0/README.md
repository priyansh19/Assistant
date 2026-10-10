# Phase 0 spike (throwaway)

Proves hold-to-talk, the click-through overlay and capture speed on real Windows hardware. Not part of the app; results are in [`docs/reference-findings.md`](../../docs/reference-findings.md).

```
npm install
node node_modules/electron/install.js   # if npm skipped Electron's download script
npm start                               # overlays + dot; hold Right Ctrl and the dot turns orange
```

Automated run (writes `results.json`):

```
# terminal 1
powershell -File inject-keys.ps1
# terminal 2
npm run auto                 # add  -- --stay  to keep overlays up, then run check-clickthrough.ps1
```

`bounds-test.js` (run with `electron . --bounds-test`) shows the Windows work-area clamp on first show.
