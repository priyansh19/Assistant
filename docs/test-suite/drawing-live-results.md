# Drawing suite: live results so far (12 Oct 2026)

Every run was live on the ASUS: the real hotkey, the prompt spoken through the speakers, and the visible cursor. Build: `claude/laptop-draw`, which is PR #16, PR #17 and PR #18 plus the fixes listed below. Each task has a screenshot from while its marks were still up.

| Task | Request | Result | Notes |
|---|---|---|---|
| D01 | Circle the Recycle Bin | PASS | |
| D02 | Put a box around the taskbar | PASS (run 3) | Run 2 sent it to the agent (fixed) |
| D03 | Draw an arrow to the Wi-Fi icon | PASS | Says when the icon is hidden in the tray |
| D09 | Circle the clock | PASS | |
| D18 | Draw a smiley face on my screen | PASS (run 5) | Earlier: V-shaped smile and a label on every part (fixed) |
| D19 | Draw a star | PASS | |
| D20 | Draw a house | PASS (run 4) | Run 2: "draw" heard as "brought" (key terms added) |
| D21 | Draw a heart | PASS | |
| D22 | Draw a sun in the top right corner | PASS (run 4) | "in the top right corner" was read as "in an app" (fixed) |
| D23 | Write Hello Priyansh in the middle of the screen | PASS (run 5) | It said "written" but drew nothing; now retried once |
| D24 | Flowchart: Start, then Check, then Done | PASS (run 4) | |
| D25 | Big arrow pointing down | PASS | |
| D26 | Draw a tree | PASS | |
| D27 | Draw a cat | PASS | |
| D28 | Circle, square, triangle in a row | PASS | |
| D33 | 3 by 3 grid across the screen | PASS | |
| D38 | Box the top-left corner of the screen | PASS (run 4) | Speech dropped "Box" once |
| DS2 | Draw a star and say what you drew | PASS | No tag text spoken |
| DS3 | Can you draw on my screen? | PASS (run 4) | It used to ask "what should I draw?" or open Paint |
| D42 | Open Paint and draw a straight line | PASS | |
| D44 | Circle in Paint with the ellipse tool | PASS | |
| D47 | Write my name in Paint with the text tool | PASS | |

**All 22 tasks run so far now pass.** The other 47 tasks in the catalogue haven't been run yet. Most need setups such as two monitors, display scaling, Excel, Outlook or Whiteboard.

## Bugs found and fixed

1. **On-screen drawings went to the agent.** "Put a box around the taskbar", "write … in the middle of the screen" and "can you draw on my screen?" opened Paint or dragged the mouse over the desktop. `onScreenDrawing()` now keeps them with the answer model and turns off task routing for them.
2. **The answer model claimed drawings it didn't make.** The cheapest model said "I've drawn a star" with no marks. Drawing requests now use the agent model, skip speculation, and are retried once if nothing was drawn.
3. **Weak sketches.** A smile came out as a V and every part had a label. The prompt now asks for circles for round things and smoother paths, and labels are removed from the parts of a sketch.
4. **Haiku replied in tool-call markup** instead of JSON, which ended the run. Those replies are now read too.
5. **A screenshot timeout ended a Paint run.** It is now retried once.
6. **The triangle didn't follow the stroke after pointing.** Fixed in PR #17 (d73dd98).

## Test-environment notes

- Paint windows left open by the Paint tasks pulled later on-screen drawings into Paint. They now close after each Paint task (Don't save).
- After the drawing tasks, run the Paint cleanup (`Close-TestPaint` in `e2e/live/win.ps1`).
