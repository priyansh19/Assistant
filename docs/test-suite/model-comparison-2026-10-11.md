# Agent model comparison: 5 hardest safe tasks, live

Run live on the ASUS on 11 Oct 2026. The real hold key and the prompt were spoken through the speakers, and the visible cursor did the work. Only the agent-step model changed between runs. Before every task, Clicky was restarted from the same frozen learned state (lessons, skills, agents.md), so no run learned from another. Nothing that closes or minimises windows was in the set.

The free models the plan named (Qwen 2.5 VL 72B, Llama 4 Maverick, Mistral Small 3.2, Gemma 3 27B) are no longer free on OpenRouter. The free open-weight model used was **google/gemma-4-31b-it:free**.

## Summary

| Model | Passed | Step accuracy (checks that worked) | Median s/step | Spend for the 5 tasks | Problems |
|---|---|---|---|---|---|
| Gemma 4 31B (free) | 2 / 5 | 0–78%, low on long tasks | 9.9 | $0.13* | Tried to close an Amazon window it wasn't asked to close (declined). Scrolled one notch at a time. |
| Claude Haiku 5.5 (current) | 2 / 5 | 63–100% | 10.1 | $0.23 | Long tasks ran out of time (8–15 min caps). |
| Claude Sonnet 5.5 (reasoning) | 2 / 5 | 78–100% | 10.0 (17 s on B05) | $1.09 | **2 runs crashed in 1–3 steps**: its replies came back with no action in them, so the run stopped. |

\* The spend includes the answer model, step reviews and final checks, which also ran during Gemma's turn.

All three passed the same two tasks: C02 (Calculator, then 18% of 2450, then a note) and C03 (move PDFs, or say there are none). All three failed the same three:
- **F07, sort a messy folder by type:** no model managed it through File Explorer. Haiku made 2 of 5 folders in 53 steps. Gemma kept going back and forth between folders. Sonnet crashed.
- **B05, AirPods price on Amazon versus Best Buy:** every model ran out of time.
- **S03, 20 Amazon laptops into a sheet:** Haiku had collected rows after 83 steps when time ran out. Gemma noted 3 rows in 30 steps (one notch per scroll) before it stopped. Sonnet crashed.

## Decision rule

The rule from the plan: the free model is a viable default only if it is within 10 points of Haiku on pass rate and step accuracy, makes zero unintended actions and is no slower per step.

- **Gemma fails the rule.** Its step accuracy is much lower, and it tried an unintended close.
- **Sonnet isn't better here.** It crashed twice, and per task it costs about 5 times as much as Haiku.
- **Keep Haiku 5.5 as the agent default.**

## What this says

The hard tasks fail for all models alike, so the limit is how Clicky runs long tasks, not which model it uses:
1. **File sorting through Explorer's menus:** Clicky has no way to move many files at once.
2. **Comparing two shops:** Clicky has no plan of the sites it needs and no notes per site.
3. **Collecting 20 items:** the model scrolls tiny amounts and notes one row per step. It should note a whole screen of rows per step.
4. **Sonnet's empty replies:** a model whose reply carries no action ends the run. It should get a reminder of the format and try again.

These go into the next fixes.
