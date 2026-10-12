# Misunderstandings seen in live tests

Every case where what was said, what Clicky heard, and what it did didn't line up. The live tests speak through the speakers into the mic; the AssemblyAI transcripts are below exactly as Clicky received them.

| # | Said | Heard | What Clicky did | What it should have done | Cause |
|---|---|---|---|---|---|
| 1 | "Clicky, make a folder called Receipts on my desktop." | "Clicky. a folder called Receipts on my desktop." | Made the folder, but in the old C:\Users\gupta\Desktop | Make it on the OneDrive Desktop the user sees | Speech: dropped the verb. Paths: the model guessed the usual Desktop path (fixed: usual paths are now mapped to the real ones) |
| 2 | "Clicky, open example.com, then copy the heading…" | "Clicky. An example dot com. Then copy the heading…" | Got it right anyway | — | Speech: "open" heard as "an" |
| 3 | "Clicky, open Calculator, work out 18% of 2450…" | "Clicking. Open calculator…" | Answered as a plain question and claimed it had written a note (it hadn't) | Do the task | Name heard as "Clicking" (fixed). The answer model also claimed an action it can't do |
| 4 | "Clicky, open my GitHub notifications." | "Plicky, open my git hub notifications." | Opened them | — | Speech: name misheard ("Plicky" is now accepted) |
| 5 | "Clicky, which version of Windows is this?" | Correct | Guessed from the screen: "Windows (CRLF)" | Open Settings and read it | Answered from the screenshot instead of looking (fixed: if it can't see the answer, it goes and finds out) |
| 6 | "Clicky, close all my windows." (test meant: the 5 test Notepads) | Correct | Closed the user's real windows too (Claude, Explorer, Calculator, LinkedIn) | Literally correct, but the user didn't want that | No sense of which windows matter; nothing says "these are mine, leave them" |
| 7 | "Hey Clicky, can you, uh, … close the File Explorer?" (live use) | "Hey, Clicky, can you, uh," | Answered the fragment | Wait for the whole request | Turn ended at the pause and the rest was lost (key-up handling) |
| 8 | "Clicky, minimise this window." | Correct | Minimised the Claude window | Correct: Claude was in front, not the test Notepad | Not a mistake (test setup) |

## Patterns

- **Speech recognition drops or changes short words:** "make", "open", the name itself. Clicky's own vocabulary (its name, app names, folder names) isn't passed to AssemblyAI as key terms.
- **Answering without looking:** the answer model guesses facts that aren't on the screen, or claims it did things it can't do.
- **No idea of what matters to the user:** "all my windows" includes the apps the user is working in.
