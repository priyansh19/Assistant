// Live tasks from the multi-step catalogue (test-suite/multistep-catalogue.md): what to say, how
// to set the PC up, and how to check the result. Checks are PowerShell (with win.ps1 loaded); each
// `check` returns text that `pass` judges. `allow` says whether to allow risky steps when asked.
const docs = "[Environment]::GetFolderPath('MyDocuments')";
const desk = "[Environment]::GetFolderPath('Desktop')";
const test = `(Join-Path (${docs}) 'ClickyTest')`;
const notepads = (n) =>
  Array.from({ length: n }, () => 'Start-Process notepad; Start-Sleep -Milliseconds 700').join('; ');

export const TASKS = [
  {
    id: 'W01',
    say: 'Clicky, minimise this window.',
    setup: [
      "Start-Process notepad; Start-Sleep 2; [LiveWin]::Front() | Set-Content (Join-Path $env:TEMP 'clicky-w01.txt')",
    ],
    check:
      "$t = Get-Content (Join-Path $env:TEMP 'clicky-w01.txt'); (Get-AppWindows | Where-Object { $_.Split('|')[1] -eq $t } | Select-Object -First 1)",
    pass: (out) => out.endsWith('|min'),
  },
  {
    id: 'W03',
    say: 'Clicky, close all my windows.',
    setup: [notepads(5), 'Start-Sleep 1'],
    allow: 'allow',
    maxMinutes: 6,
    check: "(Get-AppWindows | Where-Object { $_ -like 'notepad|*' }).Count",
    pass: (out) => out.trim() === '0' || out.trim() === '',
  },
  {
    id: 'W10',
    say: 'Clicky, close all windows.',
    setup: ['(New-Object -ComObject Shell.Application).MinimizeAll(); Start-Sleep 1'],
    allow: 'decline',
    check: "(Get-AppWindows | Where-Object { $_ -notlike '*|min' }).Count",
    pass: (out, r) => !/shut ?down/i.test(r.answer),
  },
  {
    id: 'W11',
    say: 'Clicky, open Calculator and Notepad and make Notepad full screen.',
    maxMinutes: 4,
    check:
      "(Get-AppWindows | Where-Object { $_ -like 'notepad|*' } | Select-Object -First 1); (Get-AppWindows | Where-Object { $_ -like '*calc*' }).Count",
    pass: (out) => /\|max/.test(out.split('\n')[0] ?? '') && Number(out.split('\n')[1]) >= 1,
  },
  {
    id: 'W12',
    say: 'Clicky, bring back all my minimised windows.',
    setup: [notepads(4), '(New-Object -ComObject Shell.Application).MinimizeAll(); Start-Sleep 1'],
    maxMinutes: 5,
    check: "(Get-AppWindows | Where-Object { $_ -like 'notepad|*|min' }).Count",
    pass: (out) => out.trim() === '0',
  },
  {
    id: 'F01',
    say: 'Clicky, open my Downloads folder.',
    check: '[LiveWin]::Front()',
    pass: (out) => /downloads/i.test(out),
  },
  {
    id: 'F02',
    say: 'Clicky, make a folder called Receipts on my desktop.',
    setup: [`Remove-Item (Join-Path (${desk}) 'Receipts') -Recurse -ErrorAction SilentlyContinue`],
    cleanup: [`Remove-Item (Join-Path (${desk}) 'Receipts') -Recurse -ErrorAction SilentlyContinue`],
    maxMinutes: 4,
    check: `Test-Path (Join-Path (${desk}) 'Receipts')`,
    pass: (out) => out.trim() === 'True',
  },
  {
    id: 'F08',
    say: 'Clicky, copy the report file from the Clicky test folder in my documents to my desktop.',
    setup: [
      `New-Item -ItemType Directory -Force ${test} | Out-Null; Set-Content (Join-Path ${test} 'report.txt') 'Quarterly report'`,
      `Remove-Item (Join-Path (${desk}) 'report.txt') -ErrorAction SilentlyContinue`,
    ],
    cleanup: [`Remove-Item (Join-Path (${desk}) 'report.txt') -ErrorAction SilentlyContinue`],
    maxMinutes: 5,
    check: `(Test-Path (Join-Path (${desk}) 'report.txt')).ToString() + ' ' + (Test-Path (Join-Path ${test} 'report.txt'))`,
    pass: (out) => out.trim() === 'True True',
  },
  {
    id: 'B01',
    say: 'Clicky, open YouTube.',
    check: '[LiveWin]::Front()',
    pass: (out) => /youtube/i.test(out),
  },
  {
    id: 'B02',
    say: 'Clicky, search Amazon for a USB-C hub and tell me the first price.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_out, r) => /\d/.test(r.answer) && /(aed|dhs|dirham|\$|₹|rs|price)/i.test(r.answer),
  },
  {
    id: 'B08',
    say: 'Clicky, go to Wikipedia and open the article about the Taj Mahal.',
    maxMinutes: 4,
    check: '[LiveWin]::Front()',
    pass: (out) => /taj mahal/i.test(out),
  },
  {
    id: 'D01',
    say: 'Clicky, open Notepad and write a shopping list with milk, eggs and bread.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_out, r) => ['milk', 'eggs', 'bread'].every((w) => r.typed.toLowerCase().includes(w)),
  },
  {
    id: 'X01',
    say: 'Clicky, which version of Windows is this?',
    check: "'n/a'",
    pass: (_out, r) => /windows 11/i.test(r.answer),
  },
  {
    id: 'X03',
    say: 'Clicky, how much space is left on my C drive?',
    maxMinutes: 4,
    check: '[math]::Round((Get-PSDrive C).Free / 1GB)',
    pass: (out, r) => {
      const real = Number(out.trim());
      const said = [...r.answer.matchAll(/(\d+(?:\.\d+)?)\s*(?:gb|gigabytes)/gi)].map((m) => Number(m[1]));
      return said.some((n) => Math.abs(n - real) <= 2);
    },
  },
  {
    id: 'C02',
    say: 'Clicky, open Calculator, work out 18 percent of 2450, and write the answer in a new note.',
    maxMinutes: 5,
    check: "'n/a'",
    pass: (_out, r) => r.typed.includes('441'),
  },
  {
    id: 'G05',
    say: 'Clicky, open the newest pull request on my clicky sandbox repository on GitHub and tell me who opened it.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_out, r) => /priyansh/i.test(r.answer),
  },
  {
    id: 'S01',
    say: 'Clicky, make a sheet of the temperatures in Delhi, London and New York.',
    maxMinutes: 8,
    check: "'n/a'",
    pass: (_out, r) => r.sheets.some((s) => s.rows >= 3),
  },
];
