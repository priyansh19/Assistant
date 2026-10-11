// The live suite: drives the installed Clicky exactly as a person does, on the real screen.
// For each task it sets the PC up, speaks the prompt through the speakers while holding the real
// hold-to-talk key, lets Clicky work at its normal pace (allowing or declining risky steps as the
// task says), then checks the result and reads what Clicky heard, said and did from its own logs.
//
//   node e2e/live/live-runner.mjs [--only W01,F02] [--out <dir>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BATCH3 } from './tasks-batch3.mjs';
import { TASKS as BASE } from './tasks.mjs';

const TASKS = [...BASE, ...BATCH3];

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? undefined : process.argv[i + 1];
};
const only = arg('--only')?.split(',');
const outDir = arg('--out') ?? path.join(os.tmpdir(), 'clicky-live');
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
for (const t of TASKS.filter((x) => (!only || only.includes(x.id)) && (destructive || !x.destructive))) {
  say(`--- ${t.id}: ${t.say}`);
  for (const s of t.setup ?? []) say(`setup: ${ps(s).slice(0, 200)}`);
  const wav = path.join(outDir, `${t.id}.wav`);
  ps(`New-SpokenWav '${t.say.replace(/'/g, "''")}' '${wav}'`);
  const before = history()[0]?.id;
  const offset = fs.statSync(logFile).size;
  const t0 = Date.now();
  ps(`Invoke-Spoken '${wav}'`);
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
      const ok = t.allow instanceof RegExp ? t.allow.test(asks.at(-1)) : t.allow === 'allow';
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
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  r.checkOut = ps(t.check);
  r.pass = !!entry && entry.outcome !== 'timeout' && t.pass(r.checkOut, r);
  say(
    `${r.pass ? 'PASS' : 'FAIL'} ${t.id} in ${r.seconds}s | heard: ${r.heard} | said: ${r.answer.slice(0, 160)} | check: ${r.checkOut.slice(0, 120)}`,
  );
  results.push(r);
  // Step counts per task over time (the shortest-route review is a standing rule for every run).
  fs.appendFileSync(
    path.join(outDir, '..', 'live-steps.jsonl'),
    JSON.stringify({ id: t.id, at: new Date().toISOString(), pass: r.pass, steps: r.steps.length, route: r.route }) +
      String.fromCharCode(10),
  );
  for (const s of t.cleanup ?? []) ps(s);
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 1));
  await wait(3000);
}
const passed = results.filter((r) => r.pass).length;
say(`=== ${passed} / ${results.length} passed`);
