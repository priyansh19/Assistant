// Tonight's suite (owner's brief, 13 Oct): drawing that people recognise, and harder multi-step
// tasks a personal assistant should manage. Drawing tasks take a screenshot (shot) for review and
// pass on Clicky's own drawn-and-checked log lines; the reviewer still looks at every picture.
const has = (r, re) => re.test(r.rawLog);
const sketched = (r) => /sketch of ".*" drawn: (\d+) marks/.test(r.rawLog);
const checkedOk = (r) => /sketch check \d: looks right|from a drawing that passed before/.test(r.rawLog);
const desk = "[Environment]::GetFolderPath('Desktop')";

export const TONIGHT = [
  // ---- Drawing anything, precisely.
  ...[
    ['DW01', 'Clicky, draw a bird.'],
    ['DW02', 'Clicky, draw a right-angled triangle.'],
    ['DW03', 'Clicky, draw a parrot.'],
    ['DW04', 'Clicky, draw a cat.'],
    ['DW05', 'Clicky, draw a bicycle.'],
    ['DW06', 'Clicky, draw a house with a tree next to it.'],
    ['DW07', 'Clicky, draw an owl.'],
    ['DW08', 'Clicky, draw a sailing boat on the sea.'],
    ['DW09', 'Clicky, draw a coffee cup.'],
    ['DW10', 'Clicky, draw an equilateral triangle inside a circle.'],
  ].map(([id, say]) => ({
    id,
    say,
    maxMinutes: 4,
    shot: true,
    check: "'n/a'",
    pass: (_o, r) => sketched(r) && checkedOk(r),
    noCursorRule: true,
  })),
  {
    id: 'DW11',
    say: 'Clicky, explain the Pythagoras theorem and draw it on my screen.',
    maxMinutes: 3,
    shot: true,
    check: "'n/a'",
    // A real triangle (a closed path through 3 corners) and the formula written out.
    pass: (_o, r) =>
      /overlay draw path on display \S+ at (\S+ ){3}\S+ /.test(r.rawLog) && /overlay draw text .*[²2]/.test(r.rawLog),
    noCursorRule: true,
  },
  {
    id: 'DW12',
    say: 'Clicky, what is a right angle?',
    then: 'Clicky, draw it.',
    maxMinutes: 3,
    shot: true,
    check: "'n/a'",
    pass: (_o, r) => /overlay draw (path|box)/.test(r.rawLog),
    noCursorRule: true,
  },

  // ---- Harder, multi-step: a personal assistant that knows this PC.
  {
    id: 'CX01',
    say: 'Clicky, look at my Downloads folder and tell me the three biggest files.',
    maxMinutes: 3,
    check:
      "(Get-ChildItem ([Environment]::GetFolderPath('UserProfile') + '\\Downloads') -File | Sort-Object Length -Descending | Select-Object -First 3 | ForEach-Object { $_.BaseName }) -join '|'",
    pass: (out, r) =>
      out
        .split('|')
        .filter(Boolean)
        .filter((n) => r.answer.toLowerCase().includes(n.toLowerCase().slice(0, 10))).length >= 2,
    noCursorRule: true,
  },
  {
    id: 'CX02',
    say: 'Clicky, make a folder called Trip Plan on my Desktop and put a note in it with a packing list for Dubai.',
    maxMinutes: 5,
    check: `$d = Join-Path (${desk}) 'Trip Plan'; if (Test-Path $d) { (Get-ChildItem $d -File | Select-Object -First 1 | Get-Content -Raw) } else { 'missing' }`,
    pass: (out) => out !== 'missing' && /sunscreen|sunglasses|passport|clothes|charger/i.test(out),
    cleanup: [
      `Remove-Item (Join-Path (${desk}) 'Trip Plan') -Recurse -Force -ErrorAction SilentlyContinue`,
      'Close-TestNotepads',
    ],
  },
  {
    id: 'CX03',
    say: 'Clicky, open my most recent résumé and tell me what job title it puts at the top.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => has(r, /looked for files named/) && /engineer|developer|lead|architect|manager/i.test(r.answer),
  },
  {
    id: 'CX04',
    say: 'Clicky, find the PowerToys page in the Microsoft Store and tell me its rating.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => /\b[1-5](?:\.\d)?\b.*(?:star|rating|out of)|rating/i.test(r.answer),
  },
  {
    id: 'CX05',
    say: 'Clicky, check the weather in Dubai tomorrow and write it in a new Notepad note.',
    setup: ['Protect-OpenWindows'],
    maxMinutes: 5,
    check: '[LiveWin]::Front()',
    pass: (out, r) => /notepad/i.test(out) && /°|degrees|sunny|clear|hot|humid|cloud/i.test(r.typed + r.answer),
    cleanup: ['Close-TestNotepads', 'Unprotect-Windows'],
  },
  {
    id: 'CX06',
    say: 'Clicky, open the clickey project in VS Code.',
    maxMinutes: 3,
    check: '[LiveWin]::Front()',
    pass: (out) => /clickey/i.test(out) && /visual studio code/i.test(out),
  },
  {
    id: 'CX07',
    say: 'Clicky, which of my open windows has unsaved work?',
    setup: ['Protect-OpenWindows', "New-UnsavedNotepad 'half-written note'"],
    maxMinutes: 2,
    check: "'n/a'",
    pass: (_o, r) => /notepad/i.test(r.answer),
    cleanup: ['Close-TestNotepads', 'Unprotect-Windows'],
    noCursorRule: true,
  },
  {
    id: 'CX08',
    say: 'Clicky, compare the price of AirPods Pro on Amazon India and Flipkart and tell me which is cheaper.',
    maxMinutes: 8,
    check: "'n/a'",
    pass: (_o, r) => /₹|rs\.?|rupees/i.test(r.answer) && /amazon|flipkart/i.test(r.answer),
  },
  {
    id: 'CX09',
    say: 'Clicky, find three senior AI engineer jobs in Dubai on LinkedIn and put them in a sheet.',
    maxMinutes: 10,
    check: "'n/a'",
    pass: (_o, r) => r.sheets.some((s) => s.rows >= 3),
  },
  {
    id: 'CX10',
    say: 'Clicky, tell me what I was working on in VS Code and which file is open.',
    maxMinutes: 2,
    check: "(Get-AppWindows | Where-Object { $_ -like 'code|*' } | Select-Object -First 1)",
    pass: (out, r) => {
      const file = (out.split('|')[1] ?? '').split(' - ')[0]?.trim() ?? '';
      return !!file && r.answer.toLowerCase().includes(file.toLowerCase().slice(0, 12));
    },
    noCursorRule: true,
  },
];
