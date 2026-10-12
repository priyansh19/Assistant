// Drawing tasks from test-suite/drawing-catalogue.md that can be checked from Clicky's own log
// ("overlay draw <kind> on display … at <points>") plus a screenshot for review. Overlay tasks run
// on a clear desktop (every window minimised first, restored after).
const clear = '(New-Object -ComObject Shell.Application).MinimizeAll(); Start-Sleep 1';
const restore = '(New-Object -ComObject Shell.Application).UndoMinimizeALL()';
const marks = (r, kind) => (r.rawLog.match(new RegExp(`overlay draw ${kind ?? '\\w+'} on display`, 'g')) ?? []).length;
const overlay = (id, say, pass) => ({
  id,
  say,
  setup: [clear],
  cleanup: [restore],
  shot: true,
  maxMinutes: 2,
  check: "'n/a'",
  pass,
});

export const DRAWING = [
  overlay('DR01', 'Clicky, circle the Recycle Bin.', (_o, r) => marks(r, 'circle') + marks(r, 'box') >= 1),
  overlay('DR02', 'Clicky, put a box around the taskbar.', (_o, r) => marks(r, 'box') + marks(r, 'highlight') >= 1),
  overlay('DR03', 'Clicky, draw an arrow to the Wi-Fi icon.', (_o, r) => marks(r, 'arrow') >= 1),
  overlay('DR09', 'Clicky, circle the clock.', (_o, r) => marks(r, 'circle') + marks(r, 'box') >= 1),
  overlay('DR18', 'Clicky, draw a smiley face on my screen.', (_o, r) => marks(r) >= 3 && marks(r) <= 12),
  overlay('DR19', 'Clicky, draw a star.', (_o, r) => marks(r, 'path') >= 1),
  overlay('DR20', 'Clicky, draw a house.', (_o, r) => marks(r) >= 2),
  overlay('DR21', 'Clicky, draw a heart.', (_o, r) => marks(r, 'path') >= 1),
  overlay('DR22', 'Clicky, draw a sun in the top right corner.', (_o, r) => marks(r) >= 3),
  overlay('DR23', 'Clicky, write Hello Priyansh in the middle of the screen.', (_o, r) =>
    /overlay draw text[^\n]*hello priyansh/i.test(r.rawLog),
  ),
  overlay(
    'DR24',
    'Clicky, draw a simple flowchart: Start, then Check, then Done.',
    (_o, r) => marks(r, 'box') >= 3 && marks(r, 'arrow') >= 2,
  ),
  overlay('DR25', 'Clicky, draw a big arrow pointing down.', (_o, r) => marks(r, 'arrow') >= 1),
  overlay('DR26', 'Clicky, draw a tree.', (_o, r) => marks(r) >= 2),
  overlay('DR27', 'Clicky, draw a cat.', (_o, r) => marks(r) >= 3 && marks(r) <= 12),
  overlay('DR28', 'Clicky, draw a circle, a square and a triangle in a row.', (_o, r) => marks(r) >= 3),
  overlay('DR33', 'Clicky, draw a 3 by 3 grid across the screen.', (_o, r) => marks(r) >= 4),
  overlay(
    'DR38',
    'Clicky, box the very top left corner of the screen.',
    (_o, r) => marks(r, 'box') + marks(r, 'highlight') >= 1,
  ),
  overlay(
    'DRS2',
    'Clicky, draw a star and tell me what you drew.',
    (_o, r) => marks(r) >= 1 && !/\[|PATH|TEXT|\d{2,},\d{2,}/.test(r.answer),
  ),
  overlay('DRS3', 'Clicky, can you draw on my screen?', (_o, r) => marks(r) >= 1 && !/can'?t|cannot/i.test(r.answer)),
  {
    id: 'DR42',
    cleanup: ['Close-TestPaint'],
    say: 'Clicky, open Paint and draw a straight line.',
    shot: true,
    maxMinutes: 5,
    check: "'n/a'",
    pass: (_o, r) => /dragged/.test(r.rawLog) && r.outcome === 'answered',
  },
  {
    id: 'DR44',
    cleanup: ['Close-TestPaint'],
    say: 'Clicky, draw a circle in Paint using the ellipse tool.',
    shot: true,
    maxMinutes: 5,
    check: "'n/a'",
    pass: (_o, r) => /dragged/.test(r.rawLog) && r.outcome === 'answered',
  },
  {
    id: 'DR47',
    cleanup: ['Close-TestPaint'],
    say: 'Clicky, write my name in Paint with the text tool.',
    shot: true,
    maxMinutes: 5,
    check: "'n/a'",
    pass: (_o, r) => /typed "priyansh/i.test(r.rawLog),
  },
];

// PR #18 checks: the pointer snaps to the real control; long answers when asked.
DRAWING.push(
  {
    id: 'PR18a',
    say: 'Clicky, where is the File menu?',
    setup: ['Start-Process notepad.exe; Start-Sleep 3'],
    shot: true,
    maxMinutes: 2,
    check: "'n/a'",
    pass: (_o, r) => /snapped to the control/.test(r.rawLog),
  },
  {
    id: 'PR18b',
    say: 'Clicky, where is the address bar?',
    setup: ["Start-Process 'https://example.com'; Start-Sleep 4"],
    shot: true,
    maxMinutes: 2,
    check: "'n/a'",
    pass: (_o, r) => /snapped to the control/.test(r.rawLog),
  },
  {
    id: 'PR18c',
    say: 'Clicky, explain how pivot tables work in detail.',
    maxMinutes: 3,
    check: "'n/a'",
    pass: (_o, r) => r.answer.split(/[.!?]\s/).length >= 6,
  },
);
