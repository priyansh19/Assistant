// Batch 3 of the live catalogue: files, documents, sheets and reads that don't close anything.
const docs = "[Environment]::GetFolderPath('MyDocuments')";
const desk = "[Environment]::GetFolderPath('Desktop')";
const test = `(Join-Path (${docs}) 'ClickyTest')`;
const fresh = (sub) =>
  `$d = Join-Path ${test} '${sub}'; Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $d | Out-Null`;

export const BATCH3 = [
  {
    id: 'F05',
    say: 'Clicky, find the biggest file in the Clicky test sizes folder in my documents and tell me its name.',
    setup: [
      `${fresh('sizes')}; 1..12 | ForEach-Object { Set-Content (Join-Path $d "file$_.txt") ('x' * ($_ * 300)) }; Set-Content (Join-Path $d 'giant-notes.txt') ('y' * 90000)`,
    ],
    maxMinutes: 4,
    check: "'giant'",
    pass: (_o, r) => /giant/i.test(r.answer),
  },
  {
    id: 'F12',
    say: 'Clicky, make a text file on my desktop listing every folder in the Clicky test folders folder in my documents.',
    setup: [
      `${fresh('folders')}; 'alpha','bravo','charlie','delta','echo' | ForEach-Object { New-Item -ItemType Directory (Join-Path $d $_) | Out-Null }`,
    ],
    maxMinutes: 6,
    check: `Get-ChildItem (${desk}) -Filter *.txt | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content -Raw`,
    pass: (out) => ['alpha', 'bravo', 'charlie', 'delta', 'echo'].every((w) => out.toLowerCase().includes(w)),
  },
  {
    id: 'F04',
    say: 'Clicky, move all the PDFs in the Clicky test downloads folder in my documents into a new folder called PDFs inside it.',
    setup: [
      `${fresh('downloads')}; 1..4 | ForEach-Object { Set-Content (Join-Path $d "invoice$_.pdf") 'pdf' }; 1..3 | ForEach-Object { Set-Content (Join-Path $d "note$_.txt") 'txt' }`,
    ],
    maxMinutes: 6,
    check: `$d = Join-Path ${test} 'downloads'; "$((Get-ChildItem (Join-Path $d 'PDFs') -Filter *.pdf -ErrorAction SilentlyContinue).Count) $((Get-ChildItem $d -Filter *.txt).Count)"`,
    pass: (out) => out.trim() === '4 3',
  },
  {
    id: 'D02',
    say: 'Clicky, save this note to my desktop as groceries.',
    setup: [
      `Remove-Item (Join-Path (${desk}) 'groceries.txt') -ErrorAction SilentlyContinue; $f = Join-Path $env:TEMP 'clicky-note.txt'; Set-Content $f 'apples, rice, coffee'; Start-Process notepad.exe $f; Start-Sleep 2`,
    ],
    cleanup: [`Remove-Item (Join-Path (${desk}) 'groceries.txt') -ErrorAction SilentlyContinue`],
    maxMinutes: 5,
    check: `Get-Content (Join-Path (${desk}) 'groceries.txt') -Raw -ErrorAction SilentlyContinue`,
    pass: (out) => /apples/i.test(out),
  },
  {
    id: 'D04',
    say: 'Clicky, open example.com, then copy the heading of that page into a new note.',
    maxMinutes: 5,
    check: "'n/a'",
    pass: (_o, r) => /example domain/i.test(r.typed) || /example domain/i.test(r.answer),
  },
  {
    id: 'G01',
    say: 'Clicky, how many issues are open on my clicky sandbox repository on GitHub?',
    maxMinutes: 4,
    check:
      '$env:GH_TOKEN=(gh auth token --user priyansh19); gh issue list -R priyansh19/clicky-sandbox --state open --json number --jq length',
    pass: (out, r) => {
      const n = Number(out.trim());
      const words = ['no', 'zero', 'none', 'one', 'two', 'three'];
      return new RegExp(`\\b(${n}|${words[n] ?? n}${n === 0 ? '|no open|none' : ''})\\b`, 'i').test(r.answer);
    },
  },
  {
    id: 'B12',
    say: 'Clicky, look up the weather for Dubai for the next three days and tell me which day is warmest.',
    maxMinutes: 5,
    check: "'n/a'",
    pass: (_o, r) => /(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)/i.test(r.answer),
  },
  {
    id: 'S02',
    say: 'Clicky, put the names and sizes of the files in the Clicky test sizes folder in my documents into a spreadsheet.',
    maxMinutes: 8,
    check: "'n/a'",
    pass: (_o, r) => r.sheets.some((s) => s.rows >= 13),
  },
  {
    id: 'X07',
    say: 'Clicky, tell me which app is using the most memory right now.',
    maxMinutes: 5,
    check: "(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 3).ProcessName -join ','",
    pass: (out, r) =>
      out.split(',').some(
        (p) =>
          p &&
          r.answer.toLowerCase().includes(
            p
              .toLowerCase()
              .replace(/\.exe$/, '')
              .slice(0, 5),
          ),
      ),
  },
  {
    id: 'C03',
    say: 'Clicky, if there are any PDFs in the Clicky test empty folder in my documents, move them to Documents, otherwise tell me there are not any.',
    setup: [`${fresh('empty')}; Set-Content (Join-Path $d 'readme.txt') 'nothing here'`],
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => /(no|not any|aren'?t any|none|zero) (pdf|pdfs)|no pdfs|aren't any|there are no/i.test(r.answer),
  },
  {
    id: 'F07',
    say: 'Clicky, sort everything in the Clicky test messy folder in my documents into folders by file type.',
    setup: [
      `${fresh('messy')}; foreach ($e in 'txt','pdf','jpg','csv','docx') { 1..4 | ForEach-Object { Set-Content (Join-Path $d "item$_.$e") 'x' } }`,
    ],
    maxMinutes: 10,
    check: `$d = Join-Path ${test} 'messy'; "$((Get-ChildItem $d -File).Count) $((Get-ChildItem $d -Directory).Count) $((Get-ChildItem $d -Recurse -File).Count)"`,
    pass: (out) => {
      const [loose, dirs, all] = out.trim().split(' ').map(Number);
      return loose === 0 && dirs >= 5 && all === 20;
    },
  },
  {
    id: 'B05',
    say: 'Clicky, compare the price of the AirPods Pro on Amazon and on Best Buy and tell me which is cheaper.',
    maxMinutes: 8,
    check: "'n/a'",
    pass: (_o, r) => /amazon/i.test(r.answer) && /best ?buy/i.test(r.answer) && /\d/.test(r.answer),
  },
  {
    id: 'S03',
    say: 'Clicky, list the title and price of the first 20 laptops on Amazon in a sheet.',
    maxMinutes: 15,
    check: "'n/a'",
    pass: (_o, r) => r.sheets.some((x) => x.rows >= 20),
  },
];

// Understanding: casual, real-life phrasing (fillers, short forms, "pull up", "jot down").
export const UNDERSTANDING = [
  {
    id: 'U01',
    say: 'Hey Clicky, can you, uh, make me a folder on the desktop called Taxes?',
    setup: [`Remove-Item (Join-Path (${desk}) 'Taxes') -Recurse -ErrorAction SilentlyContinue`],
    cleanup: [`Remove-Item (Join-Path (${desk}) 'Taxes') -Recurse -ErrorAction SilentlyContinue`],
    maxMinutes: 4,
    check: `Test-Path (Join-Path (${desk}) 'Taxes')`,
    pass: (out) => out.trim() === 'True',
  },
  {
    id: 'U02',
    say: 'Clicky, pull up my downloads.',
    maxMinutes: 3,
    check: '[LiveWin]::Front()',
    pass: (out) => /downloads/i.test(out),
  },
  {
    id: 'U03',
    say: 'Clicky, open up Notepad and jot down call mom at six.',
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => /call mom/i.test(r.typed),
  },
  {
    id: 'U04',
    say: "Clicky, what's the weather like in Dubai right now?",
    maxMinutes: 4,
    check: "'n/a'",
    pass: (_o, r) => /°|degrees|celsius/i.test(r.answer),
  },
  {
    id: 'U05',
    say: 'Clicky, take me to my GitHub repos.',
    maxMinutes: 3,
    check: '[LiveWin]::Front()',
    pass: (out) => /repositories|priyansh19/i.test(out),
  },
];

// Follow-ups reuse the tab Clicky opened.
UNDERSTANDING.push({
  id: 'T01',
  say: 'Clicky, open GitHub.',
  then: 'Clicky, now show me my notifications.',
  maxMinutes: 4,
  check: '[LiveWin]::Front()',
  pass: (out, r) => /notifications/i.test(out) && /reused the browser tab/.test(r.rawLog),
});
