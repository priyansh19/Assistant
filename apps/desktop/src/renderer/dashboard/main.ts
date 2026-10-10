import {
  CURSOR_COLOR_HEX,
  CURSOR_COLORS,
  HOLD_KEY_LABELS,
  HOLD_KEYS,
  actionNameFrom,
  requiredCredentials,
  searchHistory,
  type CredentialId,
  type HistoryEntry,
  type SavedAction,
  type Settings,
} from '@clicky/core';
import type { DashboardApi } from '../../preload/dashboard';
import type { DashboardSnapshot } from '../../shared/ipc';

declare global {
  interface Window {
    clickyApp: DashboardApi;
  }
}

const api = window.clickyApp;

const KEY_INFO: Record<CredentialId, { name: string; desc: string; url: string }> = {
  anthropic: {
    name: 'Anthropic',
    desc: 'Claude models for answers.',
    url: 'https://console.anthropic.com/settings/keys',
  },
  openrouter: { name: 'OpenRouter', desc: 'One key for many models.', url: 'https://openrouter.ai/keys' },
  openai: {
    name: 'OpenAI',
    desc: 'GPT models, speech to text and voice.',
    url: 'https://platform.openai.com/api-keys',
  },
  assemblyai: { name: 'AssemblyAI', desc: 'Fast live speech to text.', url: 'https://www.assemblyai.com/dashboard' },
  elevenlabs: { name: 'ElevenLabs', desc: 'Natural voices.', url: 'https://elevenlabs.io/app/settings/api-keys' },
};

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`dashboard: #${id} missing`);
  return el as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; title?: string } = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.className) e.className = props.className;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.title) e.title = props.title;
  for (const c of children) e.append(c);
  return e;
}

function button(text: string, cls: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const b = el('button', { className: cls, text });
  b.type = 'button';
  b.addEventListener('click', () => void onClick());
  return b;
}

let snap: DashboardSnapshot;
let toastTimer: number | undefined;

function toast(text: string): void {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 1800);
}

function timeAgo(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(at).toLocaleDateString();
}

function seconds(ms: number | null): string {
  return ms === null ? '–' : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

// ----------------------------------------------------------------- navigation

let currentPage = 'home';
function showPage(page: string): void {
  if (!document.getElementById(`page-${page}`)) page = 'home';
  currentPage = page;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item'))
    b.classList.toggle('active', b.dataset['page'] === page);
  for (const s of document.querySelectorAll<HTMLElement>('.page'))
    s.classList.toggle('active', s.id === `page-${page}`);
  if (page !== 'general') void stopMicTest();
  document.querySelector('main')?.scrollTo(0, 0);
}

async function save(partial: Partial<Settings>, quiet = false): Promise<void> {
  snap = await api.update(partial);
  render();
  if (!quiet) toast('Saved');
}

// ----------------------------------------------------------------- settings controls

function bindSelect(id: keyof Settings, parse: (v: string) => unknown = (v) => v): void {
  const e = $<HTMLSelectElement>(id);
  e.addEventListener('change', () => void save({ [id]: parse(e.value) } as Partial<Settings>));
}
function bindToggle(id: keyof Settings): void {
  const e = $<HTMLInputElement>(id);
  e.addEventListener('change', () => void save({ [id]: e.checked } as Partial<Settings>));
}
function bindText(id: keyof Settings): void {
  const e = $<HTMLInputElement>(id);
  e.addEventListener('change', () => void save({ [id]: e.value } as Partial<Settings>));
}

function renderControls(s: Settings): void {
  const set = (id: string, v: string): void => {
    const e = $<HTMLInputElement | HTMLSelectElement>(id);
    if (document.activeElement !== e) e.value = v;
  };
  const check = (id: string, v: boolean): void => {
    $<HTMLInputElement>(id).checked = v;
  };
  set('holdKey', s.holdKey);
  check('paused', s.paused);
  check('launchAtLogin', s.launchAtLogin);
  check('captureAllDisplays', s.captureAllDisplays);
  const edge = $<HTMLSelectElement>('captureMaxEdge');
  if (![...edge.options].some((o) => o.value === String(s.captureMaxEdge))) {
    edge.add(new Option(`Custom (${s.captureMaxEdge} px)`, String(s.captureMaxEdge)));
  }
  edge.value = String(s.captureMaxEdge);
  check('rememberHistory', s.rememberHistory);
  check('useRecentContext', s.useRecentContext);
  set('micDeviceId', s.micDeviceId);
  check('micAlwaysReady', s.micAlwaysReady);
  set('cursorSize', s.cursorSize);
  check('showPointLabels', s.showPointLabels);
  set('chatProvider', s.chatProvider);
  set('chatModel', s.chatModel);
  $<HTMLInputElement>('chatModel').placeholder = snap.defaultModel;
  $('model-desc').textContent = `Leave empty to use ${snap.defaultModel}.`;
  set('sttProvider', s.sttProvider);
  set('ttsProvider', s.ttsProvider);
  set('ttsVoice', s.ttsVoice);
  $('ttsVoiceRow').hidden = s.ttsProvider !== 'elevenlabs';
  for (const sw of document.querySelectorAll<HTMLElement>('.swatch'))
    sw.classList.toggle('selected', sw.dataset['color'] === s.cursorColor);
  document.documentElement.style.setProperty('--cursor', CURSOR_COLOR_HEX[s.cursorColor]);
}

// ----------------------------------------------------------------- home

function renderHome(): void {
  const s = snap.settings;
  const card = $('status-card');
  const title = $('status-title');
  const desc = $('status-desc');
  const action = $<HTMLButtonElement>('status-action');
  const key = HOLD_KEY_LABELS[s.holdKey];
  card.className = 'card hero';
  action.hidden = true;
  action.onclick = null;
  const busy: Partial<Record<string, string>> = {
    listening: 'Listening…',
    transcribing: 'Got it, one moment…',
    thinking: 'Thinking…',
    speaking: 'Answering…',
  };
  if (snap.missing.length) {
    title.textContent = 'Almost ready';
    desc.textContent = `Add your ${snap.missing.map((id) => KEY_INFO[id].name).join(' and ')} key to start.`;
    action.hidden = false;
    action.textContent = 'Finish setup';
    action.onclick = () => openWizard();
  } else if (s.paused) {
    title.textContent = 'Paused';
    desc.textContent = `Clicky is ignoring ${key} until you resume.`;
    action.hidden = false;
    action.textContent = 'Resume';
    action.onclick = () => void save({ paused: false });
  } else if (busy[snap.state]) {
    card.classList.add('busy');
    title.textContent = busy[snap.state] ?? '';
    desc.textContent = 'Press Esc to stop.';
  } else {
    card.classList.add('ok');
    title.textContent = 'Ready';
    desc.textContent = `Hold ${key}, ask about anything on your screen, and let go.`;
  }
  $<HTMLButtonElement>('ask-btn').disabled = snap.missing.length > 0;
  $('stat-count').textContent = String(snap.stats.count);
  $('stat-last').textContent = seconds(snap.stats.lastMs);
  $('stat-p50').textContent = seconds(snap.stats.p50Ms);
  const recent = $('recent-list');
  recent.dataset['empty'] = `Nothing yet. Hold ${key} and ask “What am I looking at?”`;
  recent.replaceChildren(...snap.history.slice(0, 5).map((e) => historyItem(e, true)));
}

// ----------------------------------------------------------------- history

function historyItem(e: HistoryEntry, compact = false): HTMLElement {
  const meta = el('div', { className: 'item-meta' }, [
    el('span', { text: timeAgo(e.at), title: new Date(e.at).toLocaleString() }),
    el('span', { className: 'pill', text: e.source === 'voice' ? 'Voice' : e.source === 'typed' ? 'Typed' : 'Action' }),
  ]);
  if (e.outcome !== 'answered') {
    meta.append(
      el('span', {
        className: 'pill err',
        text: e.outcome === 'cancelled' ? 'Stopped' : 'Failed',
        title: e.detail ?? '',
      }),
    );
  }
  if (e.pointLabel) meta.append(el('span', { text: `Pointed at: ${e.pointLabel}` }));
  if (typeof e.keyUpToFirstAudioMs === 'number')
    meta.append(el('span', { text: `${seconds(e.keyUpToFirstAudioMs)} to answer` }));
  const main = el('div', { className: 'item-main' }, [
    el('div', { className: 'item-q', text: e.question || '(no question heard)' }),
    el('div', { className: 'item-a', text: e.answer || e.detail || '' }),
    meta,
  ]);
  const buttons = el('div', { className: 'item-buttons' });
  if (e.question) {
    buttons.append(
      button('Ask again', 'secondary small', () => api.ask(e.question)),
      button('Save as action', 'secondary small', async () => {
        const r = await api.saveAction({ name: actionNameFrom(e.question), question: e.question });
        toast(r.ok ? 'Saved to Actions' : r.reason);
      }),
    );
  }
  if (!compact) {
    buttons.append(
      button('Delete', 'secondary small', async () => {
        snap = await api.removeHistory(e.id);
        render();
      }),
    );
  }
  return el('div', { className: 'item' }, [main, buttons]);
}

function renderHistory(): void {
  const list = $('history-list');
  const q = $<HTMLInputElement>('history-search').value;
  list.dataset['empty'] = q
    ? 'No matches.'
    : snap.settings.rememberHistory
      ? 'No history yet.'
      : 'History is turned off in General > Memory.';
  list.replaceChildren(...searchHistory(snap.history, q).map((e) => historyItem(e)));
}

// ----------------------------------------------------------------- actions

function actionItem(a: SavedAction): HTMLElement {
  const meta = el('div', { className: 'item-meta' }, [
    el('span', { text: a.runCount ? `Run ${a.runCount} time${a.runCount === 1 ? '' : 's'}` : 'Never run' }),
  ]);
  if (a.lastRunAt) meta.append(el('span', { text: `Last ${timeAgo(a.lastRunAt)}` }));
  return el('div', { className: 'item' }, [
    el('div', { className: 'item-main' }, [
      el('div', { className: 'item-q', text: a.name }),
      el('div', { className: 'item-a', text: a.question }),
      meta,
    ]),
    el('div', { className: 'item-buttons' }, [
      button('Run', 'primary small', async () => {
        if (snap.missing.length) {
          toast('Add your API keys first.');
          return;
        }
        await api.runAction(a.id);
      }),
      button('Edit', 'secondary small', () => {
        $<HTMLInputElement>('action-id').value = a.id;
        $<HTMLInputElement>('action-name').value = a.name;
        $<HTMLInputElement>('action-question').value = a.question;
        $('action-save').textContent = 'Update action';
        $('action-cancel').hidden = false;
        $('action-question').focus();
      }),
      button('Delete', 'secondary small', async () => {
        snap = await api.removeAction(a.id);
        render();
      }),
    ]),
  ]);
}

function resetActionForm(): void {
  ($('action-form') as HTMLFormElement).reset();
  $<HTMLInputElement>('action-id').value = '';
  $('action-save').textContent = 'Save action';
  $('action-cancel').hidden = true;
  $('action-error').hidden = true;
}

function renderActions(): void {
  const list = $('actions-list');
  list.dataset['empty'] = 'No actions yet. Save one above, or from any question in History.';
  list.replaceChildren(...snap.actions.map(actionItem));
}

// ----------------------------------------------------------------- keys

function keyRow(id: CredentialId, needed: boolean, onSaved?: () => void): HTMLElement {
  const info = KEY_INFO[id];
  const saved = snap.keys[id];
  const status = el('span', {
    className: `status ${saved ? 'saved' : needed ? 'needed' : 'optional'}`,
    text: saved ? 'Saved' : needed ? 'Needed' : 'Optional',
  });
  const title = el('div', { className: 'title', text: info.name }, [status]);
  const getKey = el('button', { className: 'link', text: 'Get a key' });
  getKey.type = 'button';
  getKey.addEventListener('click', () => void api.openLink(info.url));
  const desc = el('div', { className: 'desc' }, [`${info.desc} `, getKey]);
  const feedback = el('div', { className: 'key-error' });
  feedback.hidden = true;
  const label = el('div', { className: 'label' }, [title, desc, feedback]);

  const input = el('input');
  input.type = 'password';
  input.placeholder = saved ? '•••••••••• (paste to replace)' : 'Paste key';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.disabled = !snap.encryptionAvailable;
  const saveBtn = button('Save', 'primary', async () => {
    saveBtn.disabled = true;
    const r = await api.setKey(id, input.value);
    input.value = '';
    if (!r.ok) {
      feedback.className = 'key-error';
      feedback.textContent = r.reason;
      feedback.hidden = false;
      return;
    }
    snap = r.snapshot;
    toast(`${info.name} key saved`);
    // Check it straight away so mistakes show up now, not on the first question.
    feedback.className = 'desc';
    feedback.textContent = 'Checking the key…';
    feedback.hidden = false;
    const t = await api.testKey(id);
    render();
    onSaved?.();
    showKeyResult(id, t.ok, t.message);
  });
  saveBtn.disabled = true;
  input.addEventListener('input', () => {
    saveBtn.disabled = input.value.trim() === '';
    feedback.hidden = true;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) saveBtn.click();
  });
  const controls = el('div', { className: 'key-actions' }, [input, saveBtn]);
  if (saved) {
    controls.append(
      button('Test', 'secondary', async () => {
        feedback.className = 'desc';
        feedback.textContent = 'Checking…';
        feedback.hidden = false;
        const t = await api.testKey(id);
        feedback.className = t.ok ? 'key-ok' : 'key-error';
        feedback.textContent = t.message;
      }),
      button('Remove', 'secondary', async () => {
        snap = await api.clearKey(id);
        render();
        onSaved?.();
        toast(`${info.name} key removed`);
      }),
    );
  }
  const row = el('div', { className: 'row key-row' }, [label, controls]);
  row.dataset['key'] = id;
  return row;
}

/** After a re-render, show the test result on the freshly built row(s). */
function showKeyResult(id: CredentialId, ok: boolean, message: string): void {
  for (const row of document.querySelectorAll<HTMLElement>(`.key-row[data-key="${id}"]`)) {
    const fb = row.querySelector<HTMLElement>('.label > div:last-child');
    if (!fb) continue;
    fb.className = ok ? 'key-ok' : 'key-error';
    fb.textContent = ok ? `✓ ${message}` : message;
    fb.hidden = false;
  }
}

function renderKeys(): void {
  const needed = new Set(requiredCredentials(snap.settings));
  const ids = (Object.keys(KEY_INFO) as CredentialId[]).sort((a, b) => Number(needed.has(b)) - Number(needed.has(a)));
  $('keys-list').replaceChildren(...ids.map((id) => keyRow(id, needed.has(id))));
  $('encryption-banner').hidden = snap.encryptionAvailable;
}

function renderMissing(): void {
  const m = snap.missing;
  $('missing-banner').hidden = m.length === 0 || !$('wizard').hidden;
  $('missing-text').textContent =
    `Add your ${m.map((id) => KEY_INFO[id].name).join(', ')} key${m.length > 1 ? 's' : ''}, or pick other providers in AI and voice.`;
  const badge = $('keys-badge');
  badge.hidden = m.length === 0;
  badge.textContent = String(m.length);
}

// ----------------------------------------------------------------- mic test

let micTesting = false;
async function startMicTest(target: {
  desc: HTMLElement;
  meter: HTMLElement;
  button: HTMLButtonElement;
}): Promise<void> {
  const r = await api.micTest(true);
  if (!r.ok) {
    target.desc.textContent = r.message;
    target.desc.className = 'key-error';
    return;
  }
  micTesting = true;
  activeMeter = target.meter;
  target.button.textContent = 'Stop';
  target.desc.className = 'desc';
  target.desc.textContent = 'Speak now. The bar should move when you talk.';
  void refreshMicDevices(); // labels become available once permission is granted
}
let activeMeter: HTMLElement | null = null;
async function stopMicTest(): Promise<void> {
  if (!micTesting) return;
  micTesting = false;
  await api.micTest(false);
  if (activeMeter) activeMeter.style.width = '0';
  activeMeter = null;
  const b = document.getElementById('mic-test');
  if (b) b.textContent = 'Test';
}
api.onMicLevel((level) => {
  if (activeMeter) activeMeter.style.width = `${Math.round(Math.min(1, level * 1.4) * 100)}%`;
});

async function refreshMicDevices(): Promise<void> {
  try {
    const devices = await api.micDevices();
    const sel = $<HTMLSelectElement>('micDeviceId');
    const current = snap.settings.micDeviceId;
    sel.replaceChildren(new Option('Windows default', ''), ...devices.map((d) => new Option(d.label, d.deviceId)));
    sel.value = devices.some((d) => d.deviceId === current) ? current : '';
  } catch {
    // worker not ready yet; keep the default option
  }
}

// ----------------------------------------------------------------- setup wizard

interface Preset {
  id: string;
  title: string;
  desc: string;
  settings: Pick<Settings, 'chatProvider' | 'sttProvider' | 'ttsProvider'>;
}

const PRESETS: Preset[] = [
  {
    id: 'best',
    title: 'Best experience (recommended)',
    desc: 'Claude answers, AssemblyAI hears you live, ElevenLabs speaks. Needs 3 keys.',
    settings: { chatProvider: 'anthropic', sttProvider: 'assemblyai', ttsProvider: 'elevenlabs' },
  },
  {
    id: 'fewer',
    title: 'Two keys, free voice',
    desc: 'Claude and AssemblyAI, with the built-in Windows voice.',
    settings: { chatProvider: 'anthropic', sttProvider: 'assemblyai', ttsProvider: 'system' },
  },
  {
    id: 'openai',
    title: 'Just OpenAI',
    desc: 'One OpenAI key for answers, speech to text and voice.',
    settings: { chatProvider: 'openai', sttProvider: 'openai', ttsProvider: 'openai' },
  },
  {
    id: 'openrouter',
    title: 'OpenRouter',
    desc: 'Any model through OpenRouter, AssemblyAI for speech, Windows voice.',
    settings: { chatProvider: 'openrouter', sttProvider: 'assemblyai', ttsProvider: 'system' },
  },
];

const STEPS = ['welcome', 'providers', 'keys', 'mic', 'key', 'done'] as const;
let step = 0;

function presetFor(s: Settings): string | null {
  return (
    PRESETS.find(
      (p) =>
        p.settings.chatProvider === s.chatProvider &&
        p.settings.sttProvider === s.sttProvider &&
        p.settings.ttsProvider === s.ttsProvider,
    )?.id ?? null
  );
}

function openWizard(at = 0): void {
  step = at;
  $('wizard').hidden = false;
  renderWizard();
}

async function closeWizard(): Promise<void> {
  await stopMicTest();
  $('wizard').hidden = true;
  if (!snap.settings.onboardingDone) await save({ onboardingDone: true }, true);
  render();
}

function renderWizard(): void {
  if ($('wizard').hidden) return;
  const body = $('wizard-body');
  const s = snap.settings;
  const key = HOLD_KEY_LABELS[s.holdKey];
  $('wizard-steps').replaceChildren(...STEPS.map((_, i) => el('span', { className: i <= step ? 'done' : '' })));
  const back = $<HTMLButtonElement>('wizard-back');
  const next = $<HTMLButtonElement>('wizard-next');
  back.hidden = step === 0;
  next.disabled = false;
  next.textContent = 'Next';
  $('wizard-skip').hidden = step === STEPS.length - 1;

  const name = STEPS[step];
  if (name === 'welcome') {
    body.replaceChildren(
      el('h1', { text: 'Meet Clicky', className: '' }),
      el('p', {
        text: 'A little companion that lives next to your mouse pointer. Ask it about anything on your screen and it answers out loud, then points at the right spot.',
      }),
      el('ol', { className: 'steps-list' }, [
        el('li', {}, ['Hold ', el('span', { className: 'big-key', text: key }), ' and ask a question.']),
        el('li', { text: 'Let go. Clicky looks at your screen and starts talking right away.' }),
        el('li', { text: 'The triangle flies to whatever it is talking about.' }),
      ]),
      el('p', {
        text: 'Setup takes about two minutes: pick your AI services, paste their keys, and check your microphone.',
      }),
    );
    next.textContent = 'Get started';
  } else if (name === 'providers') {
    const current = presetFor(s);
    body.replaceChildren(
      el('h1', { text: 'Choose your AI services' }),
      el('p', { text: 'You can change this any time in AI and voice.' }),
      el(
        'div',
        { className: 'choices' },
        PRESETS.map((p) => {
          const c = el('button', { className: `choice${current === p.id ? ' selected' : ''}` }, [
            el('div', { className: 'title', text: p.title }),
            el('div', { className: 'desc', text: p.desc }),
          ]);
          c.type = 'button';
          c.addEventListener('click', () => void save(p.settings, true).then(renderWizard));
          return c;
        }),
      ),
    );
    if (!current) body.append(el('p', { text: 'You have a custom combination selected. Keep it, or pick one above.' }));
  } else if (name === 'keys') {
    const needed = requiredCredentials(s);
    const list = el(
      'div',
      { className: 'card' },
      needed.map((id) => keyRow(id, true, () => renderWizard())),
    );
    body.replaceChildren(
      el('h1', { text: 'Add your keys' }),
      el('p', {
        text: 'Paste each key and press Save. Clicky checks it right away. Keys are encrypted by Windows and never leave this PC except to call that service.',
      }),
      list,
    );
    const missing = needed.filter((id) => !snap.keys[id]);
    next.disabled = missing.length > 0;
    if (missing.length)
      body.append(el('p', { text: `Waiting for: ${missing.map((id) => KEY_INFO[id].name).join(', ')}.` }));
  } else if (name === 'mic') {
    const desc = el('div', { className: 'desc', text: 'Press Test and say something.' });
    const meter = el('div', { className: 'meter-fill' });
    const testBtn = button('Test microphone', 'secondary', async () => {
      if (micTesting) {
        await stopMicTest();
        testBtn.textContent = 'Test microphone';
      } else {
        await startMicTest({ desc, meter, button: testBtn });
      }
    });
    const sel = el('select');
    sel.append(new Option('Windows default', ''));
    void api
      .micDevices()
      .then((devices) => {
        sel.append(...devices.map((d) => new Option(d.label, d.deviceId)));
        sel.value = devices.some((d) => d.deviceId === s.micDeviceId) ? s.micDeviceId : '';
      })
      .catch(() => undefined);
    sel.addEventListener('change', () => void save({ micDeviceId: sel.value }, true));
    body.replaceChildren(
      el('h1', { text: 'Check your microphone' }),
      el('p', { text: 'Clicky only listens while you hold the key.' }),
      el('div', { className: 'card' }, [
        el('div', { className: 'row' }, [
          el('div', { className: 'label' }, [el('div', { className: 'title', text: 'Microphone' })]),
          sel,
        ]),
        el('div', { className: 'row' }, [
          el('div', { className: 'label' }, [el('div', { className: 'title', text: 'Level' }), desc]),
          el('div', { className: 'meter-wrap' }, [el('div', { className: 'meter' }, [meter]), testBtn]),
        ]),
      ]),
    );
  } else if (name === 'key') {
    const sel = el('select');
    for (const k of HOLD_KEYS) sel.add(new Option(HOLD_KEY_LABELS[k], k));
    sel.value = s.holdKey;
    sel.addEventListener(
      'change',
      () => void save({ holdKey: sel.value as Settings['holdKey'] }, true).then(renderWizard),
    );
    const voiceDesc = el('div', { className: 'desc', text: 'Hear how Clicky sounds.' });
    const play = button('Play sample', 'secondary', async () => {
      play.disabled = true;
      voiceDesc.textContent = 'Playing…';
      const r = await api.voiceTest();
      voiceDesc.textContent = r.message;
      voiceDesc.className = r.ok ? 'key-ok' : 'key-error';
      play.disabled = false;
    });
    body.replaceChildren(
      el('h1', { text: 'Your talk key and voice' }),
      el('p', { text: 'Pick a key you can hold comfortably. It does nothing else while Clicky is running.' }),
      el('div', { className: 'card' }, [
        el('div', { className: 'row' }, [
          el('div', { className: 'label' }, [el('div', { className: 'title', text: 'Hold-to-talk key' })]),
          sel,
        ]),
        el('div', { className: 'row' }, [
          el('div', { className: 'label' }, [el('div', { className: 'title', text: 'Voice' }), voiceDesc]),
          play,
        ]),
      ]),
    );
  } else {
    body.replaceChildren(
      el('h1', { text: "You're all set" }),
      el('p', { text: 'Try it now. Close this window or leave it open, then:' }),
      el('ol', { className: 'steps-list' }, [
        el('li', {}, ['Hold ', el('span', { className: 'big-key', text: key }), '.']),
        el('li', { text: 'Ask “What am I looking at?” or “Where is the settings button?”' }),
        el('li', { text: 'Let go and listen. Press Esc to stop an answer.' }),
      ]),
      el('p', { text: 'Clicky lives in the tray (bottom right, near the clock). Click it to come back here.' }),
    );
    next.textContent = 'Finish';
  }
}

// ----------------------------------------------------------------- render all

/** True while the user is typing a key: re-rendering the key rows would wipe what they typed. */
function typingKey(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLInputElement && a.type === 'password' && a.value !== '';
}

function render(): void {
  renderControls(snap.settings);
  renderHome();
  renderHistory();
  renderActions();
  if (!typingKey()) renderKeys();
  renderMissing();
  $('version').textContent = `Version ${snap.appVersion}`;
}

async function refresh(): Promise<void> {
  snap = await api.get();
  render();
  // Keep the wizard's key list in sync, but don't rebuild steps with live mic meters.
  if ((STEPS[step] === 'keys' || STEPS[step] === 'providers') && !typingKey()) renderWizard();
}

async function init(): Promise<void> {
  const holdKey = $<HTMLSelectElement>('holdKey');
  for (const k of HOLD_KEYS) holdKey.add(new Option(HOLD_KEY_LABELS[k], k));
  const swatches = $('swatches');
  for (const c of CURSOR_COLORS) {
    const sw = el('button', { className: 'swatch', title: c });
    sw.type = 'button';
    sw.dataset['color'] = c;
    sw.style.background = CURSOR_COLOR_HEX[c];
    sw.setAttribute('aria-label', `${c} cursor`);
    sw.addEventListener('click', () => void save({ cursorColor: c }));
    swatches.append(sw);
  }

  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    b.addEventListener('click', () => showPage(b.dataset['page'] ?? 'home'));
  }
  document.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-goto]');
    if (t) showPage(t.dataset['goto'] ?? 'home');
  });

  bindSelect('holdKey');
  bindToggle('paused');
  bindToggle('launchAtLogin');
  bindToggle('captureAllDisplays');
  bindSelect('captureMaxEdge', Number);
  bindToggle('rememberHistory');
  bindToggle('useRecentContext');
  bindSelect('micDeviceId');
  bindToggle('micAlwaysReady');
  bindSelect('cursorSize');
  bindToggle('showPointLabels');
  bindSelect('chatProvider');
  bindText('chatModel');
  bindSelect('sttProvider');
  bindSelect('ttsProvider');
  bindText('ttsVoice');

  $('ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('ask-input');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    void api.ask(q);
  });

  $('history-search').addEventListener('input', renderHistory);
  $('history-clear').addEventListener('click', async () => {
    if (!snap.history.length) return;
    if (!window.confirm('Delete all history? Saved actions are kept.')) return;
    snap = await api.clearHistory();
    render();
    toast('History cleared');
  });

  $('action-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $<HTMLInputElement>('action-id').value;
    const r = await api.saveAction({
      ...(id ? { id } : {}),
      name: $<HTMLInputElement>('action-name').value,
      question: $<HTMLInputElement>('action-question').value,
    });
    if (!r.ok) {
      $('action-error').textContent = r.reason;
      $('action-error').hidden = false;
      return;
    }
    resetActionForm();
    toast(id ? 'Action updated' : 'Action saved');
  });
  $('action-cancel').addEventListener('click', resetActionForm);

  const micBtn = $<HTMLButtonElement>('mic-test');
  micBtn.addEventListener('click', () => {
    if (micTesting) void stopMicTest();
    else void startMicTest({ desc: $('mic-test-desc'), meter: $('mic-meter'), button: micBtn });
  });
  $('voice-test').addEventListener('click', async () => {
    const b = $<HTMLButtonElement>('voice-test');
    const d = $('voice-test-desc');
    b.disabled = true;
    d.className = 'desc';
    d.textContent = 'Playing…';
    const r = await api.voiceTest();
    d.className = r.ok ? 'key-ok' : 'key-error';
    d.textContent = r.message;
    b.disabled = false;
  });
  $('rerun-setup').addEventListener('click', () => openWizard());

  $('wizard-next').addEventListener('click', async () => {
    if (STEPS[step] === 'mic') await stopMicTest();
    if (step >= STEPS.length - 1) return void closeWizard();
    step++;
    renderWizard();
  });
  $('wizard-back').addEventListener('click', async () => {
    if (STEPS[step] === 'mic') await stopMicTest();
    step = Math.max(0, step - 1);
    renderWizard();
  });
  $('wizard-skip').addEventListener('click', () => void closeWizard());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('wizard').hidden && snap.settings.onboardingDone) void closeWizard();
  });

  api.onChanged((page) => {
    if (page) showPage(page);
    void refresh();
  });

  snap = await api.get();
  render();
  void refreshMicDevices();
  const page = new URLSearchParams(location.search).get('page');
  if (page) showPage(page);
  if (!snap.settings.onboardingDone) openWizard();
  else if (snap.missing.length) showPage('keys');
  // Relative times ("2 min ago") stay fresh.
  window.setInterval(() => {
    if (currentPage === 'home') renderHome();
    else if (currentPage === 'history') renderHistory();
  }, 60_000);
}

void init();
