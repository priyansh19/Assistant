# Clicky

A desktop AI companion: hold a key, ask about what's on your screen, hear the answer, and see it point at the right spot. Inspired by [farzaa/clicky](https://github.com/farzaa/clicky) for macOS; not affiliated with its authors.

Built with Electron + TypeScript using a cross-platform architecture, delivered Windows-first.

- Development plan and stack decision: [docs/development-plan.md](docs/development-plan.md)
- Contributor and agent guide: [AGENTS.md](AGENTS.md)

## Build the installer to share (Windows)

```
corepack enable
pnpm install
pnpm dist
```

`pnpm dist` first downloads everything the installer carries (an open-source AI model with its llama.cpp server, on-device speech recognition and voices; see `apps/desktop/bundle.json`), checks each file's SHA-256, then writes `apps/desktop/release/Clicky-Setup-<version>.exe` (about 1.9 GB). Whoever installs it can ask a first question without an account, a key or a download. The first run of a new bundle entry with no recorded checksum needs `pnpm fetch-bundle -- --pin`.

The previous Assistant code is still available in the git history.
