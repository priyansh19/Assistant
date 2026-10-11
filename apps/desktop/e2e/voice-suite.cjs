/* eslint-disable @typescript-eslint/no-require-imports -- a plain CommonJS script run directly by Electron */
// End-to-end voice suite: drives the real Clicky pipeline the way a user does.
//
//   spoken prompt (Piper voice, on this PC) → fed in place of the microphone → Moonshine
//   speech-to-text → the real answer model → what Clicky says, points at, draws and does.
//
// Mouse and keyboard actions are recorded, not performed, unless a scenario lists them in "live"
// (only "open", which launches an app or website). Clicky's voice is captured as text, not played.
// The overlay is hidden so nothing appears on the user's screen.
//
// Run (from apps/desktop, after `electron-vite build`):
//   electron e2e/voice-suite.cjs --user-data <copy of %APPDATA%\Clicky> --models <models dir> [--only 04]
//
// The stress suite (--suite stress, scenarios in e2e/stress) runs long real-life agent tasks with
// every action performed for real ("live": "all"). Risky steps are approved only where a scenario
// says so ("approveRisky", used for a throwaway sandbox repo); otherwise they are declined.
process.env.CLICKY_HIDE_OVERLAY = '1';
process.env.CLICKY_ENGINE = 'inproc';
process.env.CLICKY_TEST_HOOKS = '1';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const userData = arg('--user-data');
const modelsDir = arg('--models');
const only = arg('--only');
const suite = arg('--suite') ?? 'scenarios';
const { execSync } = require('child_process');
if (!userData || !modelsDir) {
  console.error('usage: electron e2e/voice-suite.cjs --user-data <dir> --models <dir> [--only NN]');
  process.exit(2);
}
app.setPath('userData', userData);

const scenariosDir = path.join(__dirname, suite === 'stress' ? 'stress' : 'scenarios');
const outDir = path.join(userData, suite === 'stress' ? 'stress-report' : 'e2e-report');
fs.mkdirSync(outDir, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => fs.appendFileSync(path.join(outDir, 'run.log'), `${new Date().toISOString().slice(11, 23)} ${m}\n`);

// The settings the suite needs: on-device speech in, agent mode ready, nothing spoken aloud.
const settingsFile = path.join(userData, 'settings.json');
const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
Object.assign(settings, {
  onboardingDone: true,
  sttProvider: 'local',
  localSttModel: 'moonshine-tiny',
  ttsProvider: 'system',
  agentEnabled: true,
  agentConsentAt: settings.agentConsentAt || Date.now(),
  agentRulesVersion: 1,
  dictationKey: 'RightAlt',
  cueSound: 'off',
  captureAllDisplays: true,
});
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 1));
fs.mkdirSync(path.join(userData, 'models'), { recursive: true });
for (const d of ['sherpa-onnx-moonshine-tiny-en-int8', 'vits-piper-en_US-lessac-medium']) {
  const dst = path.join(userData, 'models', d);
  if (!fs.existsSync(dst)) fs.cpSync(path.join(modelsDir, d), dst, { recursive: true });
}

/** float PCM16 bytes at `rate` → Int16Array at 16 kHz, with optional noise and silence padding. */
function toMic(pcmBytes, rate, noise) {
  const src = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 2);
  const outLen = Math.floor((src.length * 16000) / rate);
  const pad = 16000 * 0.3;
  const out = new Int16Array(outLen + 2 * pad);
  for (let i = 0; i < outLen; i++) {
    const pos = (i * rate) / 16000;
    const a = src[Math.floor(pos)] ?? 0;
    const b = src[Math.min(src.length - 1, Math.floor(pos) + 1)] ?? 0;
    out[pad + i] = a + (b - a) * (pos - Math.floor(pos));
  }
  if (noise)
    for (let i = 0; i < out.length; i++)
      out[i] = Math.max(-32768, Math.min(32767, out[i] + (Math.random() * 2 - 1) * noise * 32767));
  return out;
}

const norm = (s) => String(s ?? '').toLowerCase();
const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 60_000, shell: 'powershell.exe' }).trim();
  } catch (e) {
    return `ERROR ${String(e.stderr || e.message).slice(0, 300)}`;
  }
};

function evaluate(sc, r) {
  const e = sc.expect ?? {};
  const fails = [];
  const heard = norm(r.heard);
  for (const w of e.heard ?? []) if (!heard.includes(norm(w))) fails.push(`heard "${r.heard}" (missing "${w}")`);
  if (e.answered && !r.answer) fails.push(`no answer (${r.outcome ?? 'no outcome'}${r.detail ? `: ${r.detail}` : ''})`);
  if (e.pointed && !r.points.length) fails.push('the triangle did not point at anything');
  if (e.allScreens && r.screensSent < r.displays) fails.push(`sent ${r.screensSent} of ${r.displays} screens`);
  // Doing nothing is right when the thing is already open (an earlier run opened it).
  const alreadyOpen = e.actionsOrSaid && norm(r.said.join(' ')).includes(norm(e.actionsOrSaid));
  for (const want of alreadyOpen ? [] : (e.actions ?? [])) {
    const hit = r.actions.find(
      (a) =>
        a.kind === want.kind &&
        (!want.app || norm(a.app).includes(norm(want.app))) &&
        (!want.url || norm(a.url).includes(norm(want.url))) &&
        (!want.text || norm(a.text).includes(norm(want.text))),
    );
    if (!hit) fails.push(`no ${want.kind} action like ${JSON.stringify(want)}`);
  }
  // Any one of several ways is fine (typing into the site's search, or opening the results URL).
  if (
    e.anyAction &&
    !e.anyAction.some((want) =>
      r.actions.some(
        (a) =>
          a.kind === want.kind &&
          (!want.url || norm(a.url).includes(norm(want.url))) &&
          (!want.text || norm(a.text).includes(norm(want.text))),
      ),
    )
  )
    fails.push(`none of ${JSON.stringify(e.anyAction)}`);
  if (e.noStartMenu && r.actions.some((a) => a.kind === 'keys' && a.keys.length === 1 && a.keys[0] === 'win'))
    fails.push('opened the Start menu');
  if (e.noActions && r.actions.some((a) => a.kind !== 'keys' || a.keys[0] !== 'mask'))
    fails.push(`acted: ${JSON.stringify(r.actions)}`);
  const typed = norm(r.typed);
  for (const w of e.typed ?? []) if (!typed.includes(norm(w))) fails.push(`typed "${r.typed}" (missing "${w}")`);
  for (const w of e.notTyped ?? [])
    if (typed.includes(norm(w))) fails.push(`typed "${r.typed}" (should not contain "${w}")`);
  if (e.typedAny && !r.typed.trim()) fails.push('typed nothing');
  if (e.noTyping && r.typed.trim()) fails.push(`typed "${r.typed}"`);
  const said = norm(r.said.join(' '));
  for (const w of e.said ?? []) if (!said.includes(norm(w))) fails.push(`said "${r.said.join(' ')}" (missing "${w}")`);
  if (e.saidAny && !e.saidAny.some((x) => said.includes(norm(x))))
    fails.push(`said "${r.said.join(' ')}" (none of ${e.saidAny.join(', ')})`);
  if (e.agentDone && r.outcome !== 'answered')
    fails.push(`agent did not finish (${r.timedOut ? 'timed out' : r.detail || r.outcome || 'no outcome'})`);
  if (e.askedRisky && !r.asked.length) fails.push('never asked before a risky step');
  if (e.notAsked && r.asked.length) fails.push(`asked: ${r.asked.join('; ')}`);
  if (e.sheet) {
    const ok = r.sheets.find((x) => x.rows >= (e.sheet.minRows ?? 1) && fs.existsSync(x.path));
    if (!ok) fails.push(`no spreadsheet with ${e.sheet.minRows ?? 1}+ rows (${JSON.stringify(r.sheets)})`);
  }
  for (const v of e.verify ?? []) {
    const out = r.verified[v.cmd] ?? '';
    const bad =
      (v.contains !== undefined && !norm(out).includes(norm(v.contains))) ||
      (v.equals !== undefined && out !== v.equals) ||
      (v.inSaid && (!out || out.startsWith('ERROR') || !said.includes(norm(out))));
    if (bad) fails.push(`check "${v.name}" failed: ${out.slice(0, 200)}`);
  }
  for (const w of e.remembered ?? [])
    if (!r.notes.some((n) => norm(n).includes(norm(w)))) fails.push(`not remembered: ${w}`);
  return fails;
}

app.whenReady().then(async () => {
  const results = [];
  try {
    await wait(5000);
    const { controller: c, history } = globalThis.__clicky;
    const engine = c.engine.inproc;
    if (!engine) throw new Error('engine did not start in-process');
    const { screen } = require('electron');

    // Recorders.
    let cur = null;
    const origRun = c.input.run.bind(c.input);
    c.input.run = async (a) => {
      cur?.actions.push(a.kind === 'click' ? { kind: 'click', target: a.target, at: a.at.global } : a);
      if (cur && a.kind === 'type') cur.typed += a.text;
      if (cur && (cur.live === 'all' || (cur.live ?? []).includes(a.kind))) return origRun(a);
    };
    if (suite !== 'stress') {
      c.input.writeContext = async () => ({
        app: { process: 'notepad', title: 'Untitled - Notepad' },
        selection: null,
      });
      c.input.caret = async () => null;
    }
    // Risky agent steps: allowed only for scenarios that say so (a sandbox), otherwise declined.
    engine.orchestrator.deps.confirm = async (text) => {
      cur?.asked.push(text);
      log(`asked: ${text} -> ${cur?.approve ? 'allow' : 'decline'}`);
      return !!cur?.approve;
    };
    const origLog = engine.orchestrator.deps.log;
    engine.orchestrator.deps.log = (m) => {
      if (cur && /^agent /.test(m)) cur.steps.push(m.slice(0, 300));
      const sheet = /^agent saved a sheet: (.+) \((\d+) rows\)$/.exec(m);
      if (cur && sheet) cur.sheets.push({ path: sheet[1], rows: Number(sheet[2]) });
      origLog?.(m);
    };
    const origPost = engine.opts.post;
    engine.opts.post = (m) => {
      if (cur && m.type === 'overlay' && m.overlay.op === 'point') cur.points.push(m.overlay.label);
      if (cur && m.type === 'overlay' && m.overlay.op === 'draw') cur.draws.push(m.overlay.shape.kind);
      origPost(m);
    };
    const recorder = {
      id: 'recorder',
      create() {
        let first = null;
        let resolve;
        const done = new Promise((r) => (resolve = r));
        return {
          say(s) {
            cur?.said.push(s);
            if (first) {
              const f = first;
              first = null;
              f();
            }
          },
          end: () => setTimeout(resolve, 5),
          done,
          onFirstAudio(fn) {
            first = fn;
          },
          stop: () => resolve(),
        };
      },
    };
    // Clicky's voice is captured as text, never played (survives config-driven provider rebuilds).
    engine.speech = () => recorder;
    const origTake = engine.orchestrator.deps.capture.take;
    engine.orchestrator.deps.capture.take = async (signal) => {
      const s = await origTake(signal);
      if (cur) cur.screensSent = s.images.length;
      return s;
    };
    let pcm = new Int16Array(0);
    engine.orchestrator.deps.mic = {
      async start(onFrame) {
        // Feed the prompt as 20 ms frames, a little faster than real time.
        const frame = 320;
        (async () => {
          for (let i = 0; i < pcm.length; i += frame) {
            onFrame(pcm.subarray(i, i + frame));
            if ((i / frame) % 10 === 0) await wait(10);
          }
        })();
      },
      stop() {},
    };

    const local = engine.localSpeech().engine;
    const voice = { kind: 'voice', id: 'en_US-lessac', dir: 'vits-piper-en_US-lessac-medium' };
    const files = fs
      .readdirSync(scenariosDir)
      .filter((f) => f.endsWith('.json') && (!only || f.startsWith(only)))
      .sort();
    for (const f of files) {
      const sc = JSON.parse(fs.readFileSync(path.join(scenariosDir, f), 'utf8'));
      log(`--- ${f}: ${sc.name}`);
      const t0 = Date.now();
      const before = history.list()[0]?.id;
      for (const cmd of sc.setup ?? []) log(`setup: ${cmd} -> ${sh(cmd).slice(0, 200)}`);
      cur = {
        live: sc.live,
        approve: !!sc.approveRisky,
        asked: [],
        steps: [],
        sheets: [],
        verified: {},
        actions: [],
        typed: '',
        said: [],
        points: [],
        draws: [],
        screensSent: 0,
        displays: screen.getAllDisplays().length,
      };
      const resting = () => ['idle', 'cancelled', 'error'].includes(engine.orchestrator.state);
      if (sc.typed) {
        // Typed like the dashboard box: no speech-to-text in the way of a long instruction.
        void engine.orchestrator.ask(sc.say, 'typed');
        await wait(500);
      } else {
        const tts = await local.synthesize(voice, sc.say, 1);
        pcm = toMic(tts.pcm, tts.sampleRate, sc.noise);
        if (sc.key === 'dictate') engine.dictateDown();
        else engine.keyDown();
        await wait((pcm.length / 16000) * 1000 * 0.6 + 400);
        engine.orchestrator.keyUp();
      }
      // Wait for the interaction (and any agent run) to finish.
      for (let i = 0; i < (sc.maxMinutes ?? 3) * 600 && !resting(); i++) await wait(100);
      if (!resting()) {
        log('timed out; cancelling');
        cur.timedOut = true;
        engine.orchestrator.cancel('suite timeout');
        await wait(1500);
      }
      for (const v of sc.expect?.verify ?? []) cur.verified[v.cmd] = sh(v.cmd);
      await wait(400);
      const entry = history.list()[0];
      const fresh = entry && entry.id !== before ? entry : null;
      const r = {
        file: f,
        name: sc.name,
        heard: fresh?.question ?? '',
        answer: fresh?.answer ?? '',
        outcome: fresh?.outcome,
        detail: fresh?.detail,
        ...cur,
        notes: c.lessons.notes(),
        ms: Date.now() - t0,
      };
      // Dictation isn't kept in history: take what was heard from the log line instead.
      if (!r.heard && sc.key === 'dictate') r.heard = r.typed;
      r.fails = evaluate(sc, r);
      r.pass = r.fails.length === 0;
      log(
        JSON.stringify({
          heard: r.heard,
          said: r.said,
          points: r.points,
          actions: r.actions,
          typed: r.typed,
          asked: r.asked,
          sheets: r.sheets,
          verified: r.verified,
          fails: r.fails,
        }),
      );
      results.push(r);
      for (const cmd of sc.cleanup ?? []) log(`cleanup: ${cmd} -> ${sh(cmd).slice(0, 200)}`);
      await wait(800);
    }
  } catch (e) {
    log('suite error ' + (e.stack || e));
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 1));
  const row = (r) =>
    `| ${r.file.slice(0, 2)} | ${r.name} | ${r.pass ? 'PASS' : 'FAIL'} | ${(r.heard || '–').replace(/\|/g, '/')} | ${(r.fails.join('; ') || '').replace(/\|/g, '/')} | ${r.steps.filter((x) => x.startsWith('agent step')).length} | ${(r.ms / 1000).toFixed(1)} s |`;
  fs.writeFileSync(
    path.join(outDir, 'report.md'),
    [
      '| # | Scenario | Result | Heard | Why it failed | Steps | Time |',
      '|---|---|---|---|---|---|---|',
      ...results.map(row),
    ].join('\n') + '\n',
  );
  app.quit();
});
require(path.join(__dirname, '..', 'out', 'main', 'index.js'));
