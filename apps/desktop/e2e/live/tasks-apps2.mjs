// New use cases (16 Oct): more of the apps on this laptop, each a real everyday task. Clicky does
// the work; scripts only set up and check. Files the tasks make are removed afterwards.
const said = (r, re) => re.test(r.answer);
const desk = "[Environment]::GetFolderPath('Desktop')";
const docs = "[Environment]::GetFolderPath('MyDocuments')";
const pics = "[Environment]::GetFolderPath('MyPictures')";

export const APPS2 = [
  {
    id: 'NU01',
    say: 'Clicky, open Sticky Notes and make a note that says buy milk and dates.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => said(r, /note|buy milk/i) && /buy milk/i.test(`${r.typed} ${r.rawLog}`),
  },
  {
    id: 'NU02',
    say: 'Clicky, delete the sticky note that says buy milk and dates.',
    maxMinutes: 4,
    allow: /sticky|note|delet/i,
    check: "'n/a'",
    pass: (_o, r) => said(r, /deleted|removed|gone/i),
  },
  {
    id: 'NU03',
    say: 'Clicky, use Character Map to copy the euro sign.',
    maxMinutes: 4,
    // The console mangles €: compare the character code (8364).
    check: "((Get-Clipboard) -join '').ToCharArray() | ForEach-Object { [int]$_ }",
    pass: (out) => out.split(/\s+/).includes('8364'),
  },
  {
    id: 'NU04',
    say: 'Clicky, in Notepad write a short haiku about Dubai and save it on my Desktop as dubai-haiku.txt.',
    maxMinutes: 5,
    check: `$f = Join-Path (${desk}) 'dubai-haiku.txt'; if (Test-Path $f) { (Get-Content $f | Where-Object { $_.Trim() }).Count } else { 'missing' }`,
    pass: (out) => Number(out.trim()) >= 3,
    cleanup: [`Remove-Item (Join-Path (${desk}) 'dubai-haiku.txt') -ErrorAction SilentlyContinue`],
  },
  {
    id: 'NU05',
    say: 'Clicky, open Git Bash and tell me which branch my clickey project is on.',
    maxMinutes: 4,
    check: 'git -C "$env:USERPROFILE\\OneDrive\\Desktop\\clickey" branch --show-current',
    pass: (out, r) => !!out.trim() && r.answer.includes(out.trim()),
  },
  {
    id: 'NU06',
    say: 'Clicky, open Copilot and ask it for a one-line joke about computers.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => r.answer.length > 25 && !said(r, /couldn't|can't|unable|stopped/i),
  },
  {
    id: 'NU07',
    say: 'Clicky, which Ollama models do I have installed?',
    maxMinutes: 4,
    check: "$m = ollama list 2>$null | Select-Object -Skip 1 | ForEach-Object { ($_ -split '\\s+')[0] }; if ($m) { $m -join '|' } else { 'none' }; exit 0",
    pass: (out, r) => out === 'none' ? said(r, /no models|none/i) : out.split('|').some((m) => r.answer.toLowerCase().includes(m.split(':')[0].toLowerCase())),
  },
  {
    id: 'NU08',
    say: 'Clicky, open the Microsoft Store and tell me which of my apps have updates waiting.',
    maxMinutes: 5,
    check: "'n/a'",
    pass: (_o, r) => r.answer.length > 20 && !said(r, /couldn't|can't|unable|stopped/i),
  },
  {
    id: 'NU09',
    say: 'Clicky, open Settings and tell me how much storage my temporary files are using.',
    maxMinutes: 5,
    check: "'n/a'",
    pass: (_o, r) => /\d+(?:\.\d+)?\s*(?:GB|MB|KB)/i.test(r.answer),
  },
  {
    id: 'NU10',
    say: 'Clicky, make a folder called Clicky Notes in my Documents with a text file called ideas.txt listing three app ideas.',
    maxMinutes: 6,
    check: `$f = Join-Path (${docs}) 'Clicky Notes\\ideas.txt'; if (Test-Path $f) { (Get-Content $f | Where-Object { $_.Trim() }).Count } else { 'missing' }`,
    pass: (out) => Number(out.trim()) >= 3,
    cleanup: [`Remove-Item (Join-Path (${docs}) 'Clicky Notes') -Recurse -Force -ErrorAction SilentlyContinue`],
  },
  {
    id: 'NU11',
    say: 'Clicky, open WSL Settings and tell me how much memory WSL is allowed to use.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => /\d+\s*(?:GB|MB)|half|50 ?%|default/i.test(r.answer),
  },
  {
    id: 'NU12',
    say: 'Clicky, take a screenshot of my screen with the Snipping Tool and save it in my Pictures folder as clicky-shot.',
    maxMinutes: 5,
    check: `$f = Get-ChildItem (${pics}) -Recurse -Filter 'clicky-shot*' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($f) { $f.FullName } else { 'missing' }`,
    pass: (out) => out.trim() !== 'missing',
    cleanup: [`Get-ChildItem (${pics}) -Recurse -Filter 'clicky-shot*' -ErrorAction SilentlyContinue | Remove-Item -ErrorAction SilentlyContinue`],
  },
  {
    id: 'NU13',
    say: 'Clicky, open MyASUS and tell me how healthy my battery is.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => /\d+\s*%|good|healthy|normal|cycle/i.test(r.answer),
  },
  {
    id: 'NU14',
    say: 'Clicky, open Phone Link and tell me whether my phone is connected.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => said(r, /connected|not connected|no phone|set up|pair/i),
  },
];
