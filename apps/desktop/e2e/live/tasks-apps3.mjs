// Third batch of use cases (16 Oct): harder multi-step work across developer tools and everyday
// apps. Setup and checks are scripts; Clicky does the rest. Anything created is removed afterwards.
const said = (r, re) => re.test(r.answer);
const desk = "[Environment]::GetFolderPath('Desktop')";
const clickey = '"$env:USERPROFILE\\OneDrive\\Desktop\\clickey"';

export const APPS3 = [
  {
    id: 'NU15',
    say: 'Clicky, in VS Code make a file hello.js on my Desktop that prints today’s date, run it in the terminal and tell me what it printed.',
    maxMinutes: 6,
    check: "'n/a'",
    pass: (_o, r) => /2026/.test(r.answer),
    cleanup: [`Remove-Item (Join-Path (${desk}) 'hello.js') -ErrorAction SilentlyContinue`],
  },
  {
    id: 'NU16',
    say: 'Clicky, open Terminal and tell me which Docker images I have.',
    maxMinutes: 4,
    check: "$i = docker images --format '{{.Repository}}' 2>$null; if ($i) { $i -join '|' } else { 'none' }; exit 0",
    pass: (out, r) =>
      out === 'none'
        ? said(r, /no (docker )?images|none/i)
        : out.split('|').some((i) => r.answer.toLowerCase().includes(i.split('/').pop().toLowerCase())),
  },
  {
    id: 'NU17',
    say: 'Clicky, use Terminal to show the last three commits in my clickey project and tell me what they were.',
    maxMinutes: 4,
    check: `git -C ${clickey} log -3 --format=%s`,
    pass: (out, r) =>
      out
        .split('\n')
        .filter(Boolean)
        .filter((c) => r.answer.toLowerCase().includes(c.toLowerCase().slice(0, 18))).length >= 2,
  },
  {
    id: 'NU18',
    say: 'Clicky, open the Python documentation on list comprehensions and tell me the first example it gives.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => /squares|x\s*\*\*\s*2|range\(10\)/i.test(r.answer),
  },
  {
    id: 'NU19',
    say: 'Clicky, open Microsoft Edge and search Bing for the population of Dubai.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => said(r, /million/i),
  },
  {
    id: 'NU20',
    say: 'Clicky, use the Calculator in programmer mode to convert 255 to hexadecimal.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => /\bFF\b/i.test(r.answer),
  },
  {
    id: 'NU21',
    say: 'Clicky, open Settings and tell me which version of Windows I have.',
    maxMinutes: 4,
    check: "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').DisplayVersion",
    pass: (out, r) => r.answer.includes(out.trim()),
  },
  {
    id: 'NU22',
    say: 'Clicky, open File Explorer and show me the AppData folder in my user folder.',
    maxMinutes: 4,
    check: '[LiveWin]::Front()',
    pass: (out) => /appdata/i.test(out),
  },
  {
    id: 'NU23',
    say: 'Clicky, in PowerShell make a folder called clicky-test on my Desktop and tell me what is inside it.',
    maxMinutes: 4,
    check: `if (Test-Path (Join-Path (${desk}) 'clicky-test')) { 'made' } else { 'missing' }`,
    pass: (out, r) => out.trim() === 'made' && said(r, /empty|nothing|no (files|items)/i),
    cleanup: [`Remove-Item (Join-Path (${desk}) 'clicky-test') -Recurse -Force -ErrorAction SilentlyContinue`],
  },
  {
    id: 'NU24',
    say: 'Clicky, open the Weather app and switch it to Dubai.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => said(r, /dubai/i) && !said(r, /couldn't|can't|unable/i),
  },
];
