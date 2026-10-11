# Stress suite: long real-life tasks, 11 Oct 2026

Fifteen tasks run live on the ASUS: real clicks, typing and scrolling in Comet, GitHub, LinkedIn,
Notepad, Calculator, File Explorer, Settings, YouTube and Amazon. Every task goes through the real
pipeline and the real agent model. Risky steps are approved only for the throwaway repo
`priyansh19/clicky-sandbox`; everywhere else they are declined. LinkedIn is read only.

Scenarios live in `apps/desktop/e2e/stress/`. Run them with:

```
electron e2e/voice-suite.cjs --suite stress --user-data <copy of %APPDATA%\Clicky> --models <models dir> [--only 04]
```

## Before and after

| # | Task | Before | After |
|---|---|---|---|
| 01 | Comet → GitHub → sandbox repo → find pending PRs → merge them all | FAIL | **PASS**: merged both PRs, asking before each Merge and Confirm |
| 02 | How many PRs are open on Assistant (read only) | FAIL | **PASS** |
| 03 | LinkedIn feed → jobs that fit me → Excel sheet | FAIL | **PASS**: 3 job posts saved to an .xlsx |
| 04 | LinkedIn job search → top five → Excel sheet | FAIL | **PASS**: 5 jobs (title, company, location) |
| 05 | Temperatures in three cities → spreadsheet | FAIL | **PASS** |
| 06 | Title of the latest merged PR | PASS | PASS |
| 07 | Notepad: write a list, save it to the desktop | FAIL | **PASS** |
| 08 | Calculator → Notepad (carry a result between apps) | PASS | PASS |
| 09 | Newest file in Downloads | PASS | PASS |
| 10 | Which Windows version (Settings) | PASS | PASS |
| 11 | Two tabs in Comet, switch back, read the heading | FAIL | **PASS** |
| 12 | YouTube search | PASS* | PASS |
| 13 | Spoken: open my GitHub notifications | PASS | PASS |
| 14 | Deleting a file asks first | PASS | PASS (declined, file kept) |
| 15 | Amazon: search and read a price | PASS | PASS |

**Before: 8 of 15. After: 15 of 15.** (*12 first failed on test wording: Clicky opened the
YouTube results page directly, which is a correct way to search.) The full after-run passed 11;
04, 07, 09 and 14 passed on a rerun once the last two fixes below were in.

## What broke, and the fix

1. **Empty agent replies (killed 6 tasks).** Claude Haiku 5.5 and Qwen think by default on
   OpenRouter and spent the whole 400-token budget thinking, so replies came back empty or cut off
   mid-JSON. Thinking is now off by default; agent steps get a separate thinking budget, room for
   longer replies, and retry a failed model call twice.
2. **No memory across pages.** The LinkedIn feed task scrolled 36 times and never saved anything.
   The agent now has a `note` action (facts or table rows that come back every step) and a
   `save_sheet` action that writes a real .xlsx to `Documents\Clicky` (checked with openpyxl).
   After ten scrolls with nothing noted, it is told to wrap up with what it has.
3. **The mouse helper failed to start.** Its script had grown past Windows' 32,767-character
   command-line limit (`spawn ENAMETOOLONG`), so nothing could be clicked or launched. It now runs
   from a temp file. This would have broken the installed app on the next build.
4. **Hyphens dropped from requests.** "clicky-shopping.txt" reached the agent as "clicky
   shopping.txt" because the name-matching split on hyphens. The request now passes through exactly.
5. **Folders opened behind other windows,** so the agent couldn't see them. Folders now open
   through the helper, which brings the window to the front.
6. **Garbled multi-line typing in Notepad.** Line breaks were sent in the same burst as text and
   arrived first. They are now sent on their own.
7. **Merging and applying for jobs** now count as risky steps that need the user's OK.

## Clicky's own context: agents.md and skills

- `%APPDATA%\Clicky\agents.md` is Clicky's briefing, added to every agent run: what it is for,
  how to read screenshots (trust the new screenshot, wait for loading, close popups, scroll for
  more), how to work through long tasks (part by part, note as you go, save once at the end), and
  the safety rules.
- `%APPDATA%\Clicky\skills\*.md` are task skills: GitHub pull requests, LinkedIn jobs, sheets and
  Excel files, browsing in Comet, files and folders. A skill joins a run when its trigger words
  appear in the task. After a run that works, it gets a line under "Learned from runs that
  worked" (the newest eight are kept), so skills improve with use.
- Both are plain Markdown: edit them, add new skills, or delete them. Changes are picked up
  without a restart.

## Still to watch

- Opening an .xlsx on a PC without Excel shows the file in File Explorer instead.
- Some tasks take 1–3 minutes (the PR merge took 24 steps), because each step is one model call
  on fresh screenshots.
