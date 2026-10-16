// The live suite: drives the installed Clicky exactly as a person does, on the real screen.
// For each task it sets the PC up, speaks the prompt through the speakers while holding the real
// hold-to-talk key, lets Clicky work at its normal pace (allowing or declining risky steps as the
// task says), then checks the result and reads what Clicky heard, said and did from its own logs.
//
//   node e2e/live/live-runner.mjs [--only W01,F02] [--out <dir>]
//
// Model comparison: --model <OpenRouter id> --freeze <dir> runs every task with that agent model,
// starting each from the same learned state (lessons, skills, notes, agents.md copied into <dir>
// on first use and put back before each task, with Clicky restarted), so no run learns from another.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BATCH3, UNDERSTANDING } from './tasks-batch3.mjs';
import { DRAWING } from './tasks-drawing.mjs';
import { SCREEN } from './tasks-screen.mjs';
import { TONIGHT } from './tasks-tonight.mjs';
import { APPS } from './tasks-apps.mjs';
import { APPS2 } from './tasks-apps2.mjs';
import { APPS3 } from './tasks-apps3.mjs';
import { TASKS as BASE } from './tasks.mjs';

// --nameless: the same tasks without saying the name ("make a folder…" instead of "Clicky, make…").
const stripName = (t) => t.replace(/^\s*(?:hey\s+)?click(?:y|ey)[,.!]?\s*/i, '').replace(/^./, (c) => c.toUpperCase());
const TASKS = [
  ...BASE,
  ...BATCH3,
  ...UNDERSTANDING,
  ...DRAWING,
  ...SCREEN,
  ...TONIGHT,
  ...APPS,
  ...APPS2,
  ...APPS3,
].map((t) =>
  process.argv.includes('--nameless')
    ? { ...t, say: stripName(t.say), ...(t.then ? { then: stripName(t.then) } : {}) }
    : t,
);

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? undefined : process.argv[i + 1];
};
const only = arg('--only')?.split(',');
const outDir = arg('--out') ?? path.join(os.tmpdir(), 'clicky-live');
const model = arg('--model');
const freeze = arg('--freeze');
const userData = path.join(process.env.APPDATA, 'Clicky');
const STATE = ['agent-lessons.json', 'notes.json', 'agents.md', 'skills'];
fs.mkdirSync(outDir, { recursive: true });
const appData = process.env.APPDATA;
const logFile = path.join(appData, 'Clicky', 'logs', 'clicky.log');
const historyFile = path.join(appData, 'Clicky', 'history.json');
const winPs = path.join(here, 'win.ps1');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
  console.log(line);
  fs.appendFileSync(path.join(outDir, 'live.log'), `${line}\n`);
};

function ps(script, timeout = 120_000) {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `. '${winPs}'; ${script}`],
      {
        encoding: 'utf8',
        timeout,
        windowsHide: true,
      },
    ).trim();
  } catch (e) {
    return `ERROR ${String(e.stderr || e.message).slice(0, 300)}`;
  }
}

const history = () => {
  try {
    return JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  } catch {
    return [];
  }
};
const logFrom = (offset) => {
  const fd = fs.openSync(logFile, 'r');
  const size = fs.fstatSync(fd).size;
  const buf = Buffer.alloc(Math.max(0, size - offset));
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  return buf.toString('utf8');
};

const results = [];
// Tasks that close or minimise windows touch the user's own apps: only with --destructive, when
// the user said the PC is free for it.
const destructive = process.argv.includes('--destructive');
// --typed: requests go to Clicky as a file (Clicky started with CLICKY_TEST_HOOKS=1) instead of out loud,
// for runs at night with the volume down. Everything after hearing the request is the same.
const typedAsks = process.argv.includes('--typed');
const ask = (text, wavPath) => {
  if (typedAsks) fs.writeFileSync(path.join(userData, 'test-ask.txt'), text);
  else ps(`Invoke-Spoken '${wavPath}'`);
};
/** Put the frozen learned state back, set the agent model and restart Clicky. */
async function freshClicky() {
  if (!freeze) return;
  ps('Get-Process Clicky -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 2');
  if (!fs.existsSync(freeze)) {
    fs.mkdirSync(freeze, { recursive: true });
    for (const f of STATE)
      if (fs.existsSync(path.join(userData, f)))
        fs.cpSync(path.join(userData, f), path.join(freeze, f), { recursive: true });
    if (fs.existsSync(path.join(userData, 'settings.json')))
      fs.copyFileSync(path.join(userData, 'settings.json'), path.join(freeze, 'settings.original.json'));
  }
  for (const f of STATE) {
    fs.rmSync(path.join(userData, f), { recursive: true, force: true });
    if (fs.existsSync(path.join(freeze, f)))
      fs.cpSync(path.join(freeze, f), path.join(userData, f), { recursive: true });
  }
  const settingsFile = path.join(userData, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.agentModel = model ?? '';
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 1));
  ps(`$env:CLICKY_TEST_HOOKS = '1'; Start-Process "$env:LOCALAPPDATA\\Programs\\clicky\\Clicky.exe"; Start-Sleep 12`);
}

// With --only, tasks run in the order given.
const queue = (only ? only.map((id) => TASKS.find((x) => x.id === id)).filter(Boolean) : TASKS).filter(
  (x) => destructive || !x.destructive,
);
for (const t of queue) {
  // The owner may be using the laptop (and Clicky) too: start a task only after 30 s with no mouse
  // or keyboard, so a test never talks over them (round 1 on 16 Oct did).
  ps(`& '${path.join(here, 'wait-idle.ps1')}' -Seconds 30 -MaxMinutes 600 | Out-Null`, 11 * 3600_000);
  // Never run the laptop flat: stop when it's on battery and low (round 1 died at 5% overnight).
  const [charge = '100', status = '2'] = ps(
    '$b = Get-CimInstance Win32_Battery; "$($b.EstimatedChargeRemaining) $($b.BatteryStatus)"',
  )
    .trim()
    .split(' ');
  if (status === '1' && Number(charge) < 25 && !process.argv.includes('--low-battery-ok')) {
    say(`stopping: on battery at ${charge}%`);
    break;
  }
  await freshClicky();
  say(`--- ${t.id}: ${t.say}${model ? ` [model ${model}]` : ''}`);
  ps('Save-WindowSnapshot');
  for (const s of t.setup ?? []) say(`setup: ${ps(s).slice(0, 200)}`);
  const wav = path.join(outDir, `${t.id}.wav`);
  if (!typedAsks) ps(`New-SpokenWav '${t.say.replace(/'/g, "''")}' '${wav}'`);
  const before = history()[0]?.id;
  const offset = fs.statSync(logFile).size;
  const t0 = Date.now();
  // An administrator window in front (Task Manager) hides the hold key from Clicky.
  if (/taskmgr|administrator|teamviewer/i.test(ps('[LiveWin]::Front()'))) ps('[LiveWin]::FocusNormal()');
  ask(t.say, wav);
  // Wait for the answer or task to finish (a new history entry), answering any "allow?" prompts.
  let entry = null;
  let answered = 0;
  const limit = (t.maxMinutes ?? 3) * 60_000;
  while (Date.now() - t0 < limit) {
    await wait(1500);
    const log = logFrom(offset);
    const asks = log.match(/asking to allow: .*/g) ?? [];
    if (asks.length > answered) {
      answered = asks.length;
      // Allow only what the task scopes it to (e.g. the Notepads it opened itself).
      // Without the name, Clicky asks "Do this for you?" first: a person who asked would say yes.
      const offer = /asking to allow: Do this for you/.test(asks.at(-1));
      const ok = offer || (t.allow instanceof RegExp ? t.allow.test(asks.at(-1)) : t.allow === 'allow');
      say(`${asks.at(-1)} -> ${ok ? 'allow' : 'leave it (declined)'}`);
      if (ok) {
        await wait(800);
        ps('Invoke-Tap');
      }
    }
    const h = history()[0];
    if (h && h.id !== before && h.at >= t0 - 1000) {
      entry = h;
      break;
    }
  }
  if (!entry) {
    // Out of time: stop the run with Esc so the next task starts clean, and keep its record.
    say('timed out; pressing Esc');
    ps('Invoke-Tap 0x1B');
    for (let i = 0; i < 20 && !entry; i++) {
      await wait(1000);
      const h = history()[0];
      if (h && h.id !== before && h.at >= t0 - 1000) entry = { ...h, outcome: 'timeout' };
    }
  }
  // A screenshot while the marks are still up, for review.
  if (entry && t.shot) {
    const png = path.join(outDir, `${t.id}.png`);
    ps(
      `Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); (New-Object System.Drawing.Bitmap $bmp, 1100, ([int](1100 * $b.Height / $b.Width))).Save('${png}')`,
    );
  }
  // A follow-up prompt (`then`), spoken once the first one is done.
  if (entry && t.then) {
    await wait(3000);
    const wav2 = path.join(outDir, `${t.id}-then.wav`);
    if (!typedAsks) ps(`New-SpokenWav '${t.then.replace(/'/g, "''")}' '${wav2}'`);
    const first = entry;
    entry = null;
    say(`follow-up: ${t.then}`);
    ask(t.then, wav2);
    for (const t1 = Date.now(); Date.now() - t1 < limit;) {
      await wait(1500);
      const h = history()[0];
      if (h && h.id !== first.id && h.at > first.at) {
        entry = h;
        break;
      }
    }
  }
  // Clicky may carry on by itself ("I can't see that on screen" starts a run that goes and looks):
  // follow it to its end so the next task doesn't start on top of it.
  await wait(2500);
  if (entry && /finding it out/.test(logFrom(offset))) {
    say('Clicky is going to find it out; following that run');
    const first = entry;
    while (Date.now() - t0 < limit * 2) {
      await wait(1500);
      const h = history()[0];
      if (h && h.id !== first.id && h.at > first.at) {
        entry = { ...h, question: first.question };
        break;
      }
    }
  }
  // The step review (shortest route) is logged a few seconds after the run ends.
  for (let i = 0; i < 20 && !/agent step review/.test(logFrom(offset)); i++) await wait(1000);
  const log = logFrom(offset);
  const steps = (log.match(/agent step \d+: .*/g) ?? []).map((l) => l.slice(0, 200));
  const typed = (log.match(/agent step \d+: typed "([^"]*)/g) ?? []).join(' ');
  const sheets = [...log.matchAll(/agent saved a sheet: (.+) \((\d+) rows\)/g)].map((m) => ({
    path: m[1],
    rows: Number(m[2]),
  }));
  const points = (log.match(/overlay point on display .*/g) ?? []).map((l) => l.slice(0, 200));
  const r = {
    id: t.id,
    say: t.say,
    heard: entry?.question ?? '',
    answer: entry?.answer ?? '',
    outcome: entry?.outcome ?? 'timeout',
    detail: entry?.detail ?? '',
    steps,
    typed,
    sheets,
    points,
    reviews: (log.match(/agent (recovering|review): .*/g) ?? []).map((l) => l.slice(0, 300)),
    route: (log.match(/agent step review: .*/) ?? [''])[0].slice(0, 500),
    rawLog: log.slice(-20000),
    seconds: Math.round((Date.now() - t0) / 1000),
    model: model ?? 'default',
    checksWorked: (log.match(/agent check: .* worked$/gm) ?? []).length,
    checksFailed: (log.match(/agent check: .* failed$/gm) ?? []).length,
    stepFailures: (log.match(/agent step failed: /g) ?? []).length,
    retries: (log.match(/agent step retry \d/g) ?? []).length,
    rateLimited: (log.match(/429|rate.?limit/gi) ?? []).length,
    recoveries: (log.match(/agent recovering/g) ?? []).length,
    stepTimes: [...log.matchAll(/^(\S+) INFO agent step \d+:/gm)].map((m) => Date.parse(m[1])),
  };
  // Hard rule: Clicky's cursor goes to everything it opens, clicks, types into or closes. Every step
  // that touches the screen needs a cursor move (an overlay point or a "cursor to" line) to match.
  // A step that failed before acting (no such control) needs no cursor move.
  const acting =
    r.steps.filter(
      (x) => !/: (noted|listed|found \d+ files|looked for files|saved|waited|moved \d+|copied \d+)/.test(x),
    ).length - (log.match(/agent step failed: /g) ?? []).length;
  r.cursorMoves = (log.match(/overlay point on display|cursor to "/g) ?? []).length;
  r.cursorOk = r.cursorMoves >= acting;
  r.checkOut = ps(t.check);
  r.pass = !!entry && entry.outcome !== 'timeout' && t.pass(r.checkOut, r) && (t.noCursorRule || r.cursorOk);
  say(
    `${r.pass ? 'PASS' : 'FAIL'} ${t.id} in ${r.seconds}s | cursor ${r.cursorMoves}/${acting} | heard: ${r.heard} | said: ${r.answer.slice(0, 160)} | check: ${r.checkOut.slice(0, 120)}`,
  );
  results.push(r);
  // Step counts per task over time (the shortest-route review is a standing rule for every run).
  fs.appendFileSync(
    path.join(outDir, '..', 'live-steps.jsonl'),
    JSON.stringify({ id: t.id, at: new Date().toISOString(), pass: r.pass, steps: r.steps.length, route: r.route }) +
      String.fromCharCode(10),
  );
  for (const s of t.cleanup ?? []) ps(s);
  // Whatever the task opened is closed, so windows don't pile up on the owner's screen.
  fs.writeFileSync(path.join(os.tmpdir(), 'clicky-task-log.txt'), log);
  if (!t.keepWindows) say(ps('Close-NewWindows').trim());
  // …and the tab it opened in Comet (the newest one, still in front).
  if (!t.keepWindows && /opened https?:\/\/\S+ in Comet$/m.test(log)) say(`tab: ${ps("Close-FrontTab '.'").trim()}`);
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 1));
  await wait(3000);
}
const passed = results.filter((r) => r.pass).length;
say(`=== ${passed} / ${results.length} passed`);
