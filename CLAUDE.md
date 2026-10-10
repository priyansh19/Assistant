# CLAUDE.md

@AGENTS.md

## Claude Code notes

- `AGENTS.md` (imported above) is the canonical guide; put shared guidance there, not here. This file is only for Claude-specific notes.
- Read `docs/development-plan.md` before planning or implementing. When your change alters a decision in it, update it in the same PR.
- In cloud sessions you can't exercise the hotkey hook, mic, screen capture, overlay or audio. Write the code and the tests you can run, then say plainly in the PR what still needs checking on the Windows laptop.
- Don't add model identifiers or session links to code, comments or docs.
- Prefer extending `packages/core` with pure, tested logic over putting logic in Electron main-process code.
