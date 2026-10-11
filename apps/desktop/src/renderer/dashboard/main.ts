import {
  CURSOR_COLOR_HEX,
  CURSOR_COLORS,
  HOLD_KEY_LABELS,
  HOLD_KEYS,
  actionNameFrom,
  requiredCredentials,
  searchHistory,
  STAGE_METRICS,
  type CredentialId,
  type HistoryEntry,
  type SavedAction,
  type Settings,
} from '@clicky/core';
import type { DashboardApi } from '../../preload/dashboard';
import type { DashboardSnapshot, TestResult } from '../../shared/ipc';

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

const BUSY_TEXT: Partial<Record<string, string>> = {
  listening: 'Listening…',
  transcribing: 'Got it, one moment…',
  thinking: 'Thinking…',
  speaking: 'Answering…',
};

// ----------------------------------------------------------------- small DOM helpers

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`dashboard: #${id} missing`);
  return e as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; title?: string; id?: string } = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.className) e.className = props.className;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.title) e.title = props.title;
  if (props.id) e.id = props.id;
  for (const c of children) e.append(c);
  return e;
}

/** A button that disables itself while its handler runs, so double clicks can't repeat an action. */
function button(text: string, cls: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const b = el('button', { className: cls, text });
  b.type = 'button';
  b.addEventListener('click', async () => {
    if (b.dataset['busy']) return;
    b.dataset['busy'] = '1';
    b.disabled = true;
    try {
      await onClick();
    } finally {
      delete b.dataset['busy'];
      b.disabled = false;
    }
  });
  return b;
}

let snap: DashboardSnapshot;
let toastTimer: number | undefined;

function toast(text: string): void {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2200);
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

function seconds(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? '–' : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

/** "A", "A and B", "A, B and C" */
function listNames(ids: CredentialId[]): string {
  const names = ids.map((id) => KEY_INFO[id].name);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

function isBusy(): boolean {
  return BUSY_TEXT[snap.state] !== undefined;
}

// ----------------------------------------------------------------- key check results

/**
 * Result of the last live check per key, kept across re-renders so a rejected key stays visibly
 * rejected (and blocks the wizard) until it's replaced.
 */
const keyChecks: Partial<Record<CredentialId, TestResult & { checking?: boolean }>> = {};
/** What the user pasted but hasn't saved yet, so re-renders never wipe it. */
const keyDrafts: Partial<Record<CredentialId, string>> = {};

function isRejected(id: CredentialId): boolean {
  const c = keyChecks[id];
  return !!c && !c.ok && c.kind === 'invalid';
}

async function checkKeyNow(id: CredentialId): Promise<void> {
  keyChecks[id] = { ok: true, message: 'Checking the key…', checking: true };
  updateKeyRows(id);
  const r = await api.testKey(id);
  keyChecks[id] = r;
  updateKeyRows(id);
  if (!$('wizard').hidden && STEPS[step] === 'keys') updateWizardNext();
}

// ----------------------------------------------------------------- navigation

let currentPage = 'home';
function showPage(page: string): void {
  if (!document.getElementById(`page-${page}`)) page = 'home';
  currentPage = page;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    const active = b.dataset['page'] === page;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  for (const s of document.querySelectorAll<HTMLElement>('.page'))
    s.classList.toggle('active', s.id === `page-${page}`);
  if (page !== 'general') void stopMicTest();
  if (snap) renderMissing();
  document.querySelector('main')?.scrollTo(0, 0);
}

async function save(partial: Partial<Settings>, quiet = false): Promise<void> {
  if ('chatProvider' in partial || 'chatModel' in partial || 'sttProvider' in partial || 'ttsProvider' in partial) {
    for (const id of Object.keys(keyChecks) as CredentialId[]) {
      if (keyChecks[id]?.ok === false && keyChecks[id]?.kind !== 'invalid') Reflect.deleteProperty(keyChecks, id);
    }
  }
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

/** Toggles and selects sit next to a visible title; give them that as their accessible name. */
function labelControls(): void {
  for (const row of document.querySelectorAll<HTMLElement>('.row')) {
    const title = row.querySelector('.title')?.textContent?.trim();
    if (!title) continue;
    for (const c of row.querySelectorAll<HTMLElement>('input, select')) {
      if (!c.getAttribute('aria-label')) c.setAttribute('aria-label', title);
    }
  }
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
  const micSel = $<HTMLSelectElement>('micDeviceId');
  if (s.micDeviceId && ![...micSel.options].some((o) => o.value === s.micDeviceId)) {
    micSel.add(new Option('Saved microphone', s.micDeviceId));
  }
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
  renderLocal(s);
  if (s.sttProvider === 'model' && s.chatProvider === 'anthropic') {
    $('model-desc').textContent = "Claude can't listen to audio. Pick OpenRouter, or a speech-to-text service below.";
  }
  for (const sw of document.querySelectorAll<HTMLElement>('.swatch')) {
    const on = sw.dataset['color'] === s.cursorColor;
    sw.classList.toggle('selected', on);
    sw.setAttribute('aria-pressed', String(on));
  }
  document.documentElement.style.setProperty('--cursor', CURSOR_COLOR_HEX[s.cursorColor]);
}

// ----------------------------------------------------------------- on-device speech

function renderLocal(s: Settings): void {
  const local = snap.local;
  $('openwhispr-note').hidden = !local.openWhispr;
  const voices = local.models.filter((m) => m.kind === 'voice');
  const sel = $<HTMLSelectElement>('localVoice');
  const installed = voices.filter((v) => v.installed);
  const current = s.localVoice;
  if (document.activeElement !== sel) {
    sel.replaceChildren(
      ...(installed.length ? installed : voices).map((v) => {
        const o = new Option(`${v.name} (${v.desc})${v.installed ? '' : ' — not downloaded'}`, `piper:${v.id}`);
        o.disabled = !v.installed;
        return o;
      }),
    );
    sel.value = current;
  }
  const speed = $<HTMLInputElement>('localVoiceSpeed');
  if (document.activeElement !== speed) speed.value = String(s.localVoiceSpeed);
  $('speed-desc').textContent = `${s.localVoiceSpeed.toFixed(2)}×`;
  if (document.activeElement !== $('localSttModel')) $<HTMLSelectElement>('localSttModel').value = s.localSttModel;

  $('local-models').replaceChildren(
    ...local.models.map((m) => {
      const meta = el('div', { className: 'item-meta' }, [
        el('span', { className: 'pill', text: m.kind === 'stt' ? 'Speech recognition' : 'Voice' }),
        el('span', { text: `${m.sizeMb} MB` }),
      ]);
      let status = m.installed ? '✓ Downloaded' : '';
      if (m.progress !== undefined)
        status = m.progress === null ? 'Unpacking…' : `Downloading ${Math.round(m.progress * 100)}%`;
      if (m.error) status = `Failed: ${m.error}`;
      if (status) meta.append(el('span', { className: m.error ? 'pill err' : '', text: status }));
      const buttons = el('div', { className: 'item-buttons' });
      const busy = m.progress !== undefined;
      if (!m.installed && !busy) {
        buttons.append(
          button(m.error ? 'Retry' : 'Download', 'primary small', async () => {
            const r = await api.localDownload(m.id);
            toast(r.ok ? `${m.name} is ready` : r.message);
          }),
        );
      }
      if (m.kind === 'voice' && m.installed) {
        buttons.append(
          button('Use', 'secondary small', () => save({ localVoice: `piper:${m.id}`, ttsProvider: 'local' })),
        );
      }
      if (m.installed) {
        buttons.append(
          button('Remove', 'secondary small', async () => {
            await api.localRemove(m.id);
          }),
        );
      }
      return el('div', { className: 'item' }, [
        el('div', { className: 'item-main' }, [
          el('div', { className: 'item-q', text: m.name }),
          el('div', { className: 'item-a', text: m.desc }),
          meta,
        ]),
        buttons,
      ]);
    }),
  );
}

/** Start the downloads a local preset needs (Moonshine + the chosen voice), in the background. */
function ensureLocalModels(s: Settings): void {
  const want: string[] = [];
  if (s.sttProvider === 'local' && !snap.local.openWhispr) {
    const stt = s.localSttModel === 'parakeet-v3' ? 'parakeet-v3' : 'moonshine-tiny';
    if (!snap.local.models.some((m) => m.kind === 'stt' && m.installed)) want.push(stt);
  }
  if (s.ttsProvider === 'local') want.push(s.localVoice.replace(/^piper:/, ''));
  for (const id of want) {
    const m = snap.local.models.find((x) => x.id === id);
    if (m && !m.installed && m.progress === undefined) void api.localDownload(id);
  }
}

// ----------------------------------------------------------------- home

/** The newest failure the user hasn't dismissed, if it's recent. */
let dismissedErrorId: string | null = null;
function lastError(): HistoryEntry | null {
  const latest = snap.history[0];
  if (!latest || latest.outcome !== 'error' || latest.id === dismissedErrorId) return null;
  return Date.now() - latest.at < 30 * 60_000 ? latest : null;
}

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
  if (snap.missing.length) {
    title.textContent = 'Almost ready';
    desc.textContent = `Add your ${listNames(snap.missing)} key${snap.missing.length > 1 ? 's' : ''} to start.`;
    action.hidden = false;
    action.textContent = 'Finish setup';
    action.onclick = () => openWizard(firstIncompleteStep());
  } else if (s.paused) {
    title.textContent = 'Paused';
    desc.textContent = `Clicky is ignoring ${key} until you resume.`;
    action.hidden = false;
    action.textContent = 'Resume';
    action.onclick = () => void save({ paused: false });
  } else if (isBusy()) {
    card.classList.add('busy');
    title.textContent = BUSY_TEXT[snap.state] ?? '';
    desc.textContent = 'Press Esc to stop.';
  } else {
    card.classList.add('ok');
    title.textContent = 'Ready';
    desc.textContent = `Hold ${key}, ask about anything on your screen, and let go.`;
  }

  const err = lastError();
  $('last-error').hidden = !err;
  if (err) {
    $('last-error-text').textContent = `The last question failed: ${err.detail ?? 'unknown error'}`;
    const fix = $<HTMLButtonElement>('last-error-fix');
    const d = (err.detail ?? '').toLowerCase();
    const target = /key|credit|billing/.test(d)
      ? 'keys'
      : /microphone/.test(d)
        ? 'general'
        : /model/.test(d)
          ? 'ai'
          : null;
    fix.hidden = target === null;
    fix.textContent =
      target === 'keys' ? 'Open API keys' : target === 'general' ? 'Microphone settings' : 'AI settings';
    fix.onclick = () => {
      if (target) showPage(target);
    };
  }

  $<HTMLButtonElement>('ask-btn').disabled = snap.missing.length > 0 || isBusy();
  $('stat-count').textContent = String(snap.stats.count);
  $('stat-last').textContent = seconds(snap.stats.lastMs);
  $('stat-p50').textContent = seconds(snap.stats.p50Ms);
  renderSpeed(snap);
  const recent = $('recent-list');
  recent.dataset['empty'] = `Nothing yet. Hold ${key} and ask “What am I looking at?”`;
  recent.replaceChildren(...snap.history.slice(0, 5).map((e) => historyItem(e, true)));
}

const STAGE_LABELS: Record<(typeof STAGE_METRICS)[number], string> = {
  keyUpToFirstAudioMs: 'Letting go → first word',
  transcriptMs: 'Finishing the transcript',
  keyUpToRequestMs: 'Letting go → question sent',
  modelFirstTokenMs: 'AI writing its first word',
  tokenToSpeechMs: 'First words → voice',
  speechToAudioMs: 'Voice starting to play',
  keyUpToPointMs: 'Letting go → cursor moves',
  recordingStartMs: 'Key press → recording',
};

function ms(v: number | null): string {
  return v === null ? '–' : `${v} ms`;
}

/** Per-stage p50/p95, so a slow step is visible without reading logs. */
function renderSpeed(snap: DashboardSnapshot): void {
  const stages = snap.stats.stages;
  const rows = STAGE_METRICS.filter((m) => stages[m].n > 0).map((m) =>
    el('tr', {}, [
      el('td', { text: STAGE_LABELS[m] }),
      el('td', { text: ms(stages[m].p50) }),
      el('td', { text: ms(stages[m].p95) }),
    ]),
  );
  $('speed').hidden = rows.length === 0;
  $('speed-rows').replaceChildren(...rows);
}

// ----------------------------------------------------------------- history

function historyItem(e: HistoryEntry, compact = false): HTMLElement {
  const meta = el('div', { className: 'item-meta' }, [
    el('span', { text: timeAgo(e.at), title: new Date(e.at).toLocaleString() }),
    el('span', { className: 'pill', text: e.source === 'voice' ? 'Voice' : e.source === 'typed' ? 'Typed' : 'Action' }),
  ]);
  if (e.outcome !== 'answered') {
    meta.append(el('span', { className: 'pill err', text: e.outcome === 'cancelled' ? 'Stopped' : 'Failed' }));
  }
  if (e.pointLabel) meta.append(el('span', { text: `Pointed at: ${e.pointLabel}` }));
  if (typeof e.keyUpToFirstAudioMs === 'number')
    meta.append(el('span', { text: `${seconds(e.keyUpToFirstAudioMs)} to answer` }));
  // Failures show their reason in the text itself, not only in a tooltip.
  const body = e.outcome === 'answered' ? e.answer : [e.answer, e.detail].filter(Boolean).join(' · ');
  const main = el('div', { className: 'item-main' }, [
    el('div', { className: 'item-q', text: e.question || '(no question heard)' }),
    el('div', { className: 'item-a', text: body }),
    meta,
  ]);
  const buttons = el('div', { className: 'item-buttons' });
  if (e.question) {
    buttons.append(
      button('Ask again', 'secondary small', async () => {
        if (snap.missing.length) return toast('Add your API keys first.');
        if (isBusy()) return toast('Clicky is busy. Press Esc to stop the current answer.');
        await api.ask(e.question);
      }),
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
        if (snap.missing.length) return toast('Add your API keys first.');
        if (isBusy()) return toast('Clicky is busy. Press Esc to stop the current answer.');
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
        if ($<HTMLInputElement>('action-id').value === a.id) resetActionForm();
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

function keyStatus(id: CredentialId, needed: boolean): { cls: string; text: string } {
  const c = keyChecks[id];
  if (snap.keys[id] && c?.checking) return { cls: 'optional', text: 'Checking…' };
  if (snap.keys[id] && isRejected(id)) return { cls: 'rejected', text: 'Rejected' };
  if (snap.keys[id] && c && !c.ok) return { cls: 'warn', text: 'Saved · needs attention' };
  if (snap.keys[id]) return { cls: 'saved', text: snap.keyHints[id] ? `Saved · …${snap.keyHints[id]}` : 'Saved' };
  return needed ? { cls: 'needed', text: 'Needed' } : { cls: 'optional', text: 'Optional' };
}

function showFeedback(target: HTMLElement, r: TestResult & { checking?: boolean }): void {
  target.className = `key-feedback ${r.checking ? 'desc' : r.ok ? 'key-ok' : 'key-error'}`;
  target.textContent = r.checking ? r.message : r.ok ? `✓ ${r.message}` : r.message;
}

function keyRow(id: CredentialId, needed: boolean): HTMLElement {
  const info = KEY_INFO[id];
  const saved = snap.keys[id];
  const st = keyStatus(id, needed);
  const status = el('span', { className: `status ${st.cls}`, text: st.text });
  const title = el('div', { className: 'title', text: info.name }, [status]);
  const getKey = el('button', { className: 'link', text: 'Get a key' });
  getKey.type = 'button';
  getKey.addEventListener('click', () => void api.openLink(info.url));
  const desc = el('div', { className: 'desc' }, [`${info.desc} `, getKey]);
  const feedback = el('div', { className: 'key-feedback' });
  const label = el('div', { className: 'label' }, [title, desc, feedback]);

  const input = el('input');
  input.type = 'password';
  input.placeholder = saved ? 'Paste a new key to replace' : 'Paste key';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.disabled = !snap.encryptionAvailable;
  input.setAttribute('aria-label', `${info.name} API key`);
  input.value = keyDrafts[id] ?? '';
  const saveBtn = el('button', { className: 'primary', text: 'Save' });
  saveBtn.type = 'button';
  saveBtn.disabled = input.value.trim() === '';
  let saving = false;
  saveBtn.addEventListener('click', async () => {
    if (saving || !input.value.trim()) return;
    saving = true;
    saveBtn.disabled = true;
    try {
      const r = await api.setKey(id, input.value);
      if (!r.ok) {
        // Keep what they pasted so a small mistake doesn't force a re-copy. The saved key (if any)
        // is unchanged, so this doesn't touch its check result.
        showFeedback(feedback, { ok: false, message: r.reason });
        return;
      }
      input.value = '';
      Reflect.deleteProperty(keyDrafts, id);
      snap = r.snapshot;
      toast(`${info.name} key saved`);
      rerenderKeyLists();
      renderMissing();
      renderHome();
      await checkKeyNow(id);
    } finally {
      saving = false;
      saveBtn.disabled = input.value.trim() === '';
    }
  });
  input.addEventListener('input', () => {
    keyDrafts[id] = input.value;
    saveBtn.disabled = saving || input.value.trim() === '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBtn.click();
  });
  const controls = el('div', { className: 'key-actions' }, [input, saveBtn]);
  if (saved) {
    controls.append(
      button('Test', 'secondary', () => checkKeyNow(id)),
      button('Remove', 'secondary', async () => {
        snap = await api.clearKey(id);
        Reflect.deleteProperty(keyChecks, id);
        rerenderKeyLists();
        renderMissing();
        renderHome();
        toast(`${info.name} key removed`);
      }),
    );
  }
  const row = el('div', { className: 'row key-row' }, [label, controls]);
  row.dataset['key'] = id;
  const c = keyChecks[id];
  if (c) showFeedback(feedback, c);
  return row;
}

/** Update only the rows for one key (status pill + feedback) without touching typed input. */
function updateKeyRows(id: CredentialId): void {
  const needed = new Set(requiredCredentials(snap.settings));
  for (const row of document.querySelectorAll<HTMLElement>(`.key-row[data-key="${id}"]`)) {
    const st = keyStatus(id, needed.has(id));
    const pill = row.querySelector<HTMLElement>('.status');
    if (pill) {
      pill.className = `status ${st.cls}`;
      pill.textContent = st.text;
    }
    const fb = row.querySelector<HTMLElement>('.key-feedback');
    const c = keyChecks[id];
    if (fb && c) showFeedback(fb, c);
  }
}

/** True while focus is in a key field: rebuilding the rows would steal focus mid-typing. */
function typingKey(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLInputElement && a.type === 'password';
}

function rerenderKeyLists(): void {
  if (typingKey()) return;
  renderKeys();
  if (!$('wizard').hidden && STEPS[step] === 'keys') renderWizard();
}

function renderKeys(): void {
  const needed = new Set(requiredCredentials(snap.settings));
  const ids = (Object.keys(KEY_INFO) as CredentialId[]).sort((a, b) => Number(needed.has(b)) - Number(needed.has(a)));
  $('keys-list').replaceChildren(...ids.map((id) => keyRow(id, needed.has(id))));
  $('encryption-banner').hidden = snap.encryptionAvailable;
}

function renderMissing(): void {
  const m = snap.missing;
  // Home says this in its status card, and the keys page lists them itself.
  $('missing-banner').hidden = m.length === 0 || currentPage === 'home' || currentPage === 'keys';
  $('missing-text').textContent =
    `Add your ${listNames(m)} key${m.length > 1 ? 's' : ''}, or pick other providers in AI and voice.`;
  const badge = $('keys-badge');
  badge.hidden = m.length === 0;
  badge.textContent = String(m.length);
}

// ----------------------------------------------------------------- mic test

let micTesting = false;
let micStarting = false;
let activeMeter: HTMLElement | null = null;
/** Bumped whenever the UI that started a test goes away, so a slow start can tell it's stale. */
let micTestOwner = 0;

async function startMicTest(target: {
  desc: HTMLElement;
  meter: HTMLElement;
  button: HTMLButtonElement;
}): Promise<void> {
  if (micStarting || micTesting) return;
  micStarting = true;
  const owner = ++micTestOwner;
  target.button.disabled = true;
  target.desc.className = 'desc';
  target.desc.textContent = 'Starting the microphone…';
  const r = await api.micTest(true);
  micStarting = false;
  target.button.disabled = false;
  if (owner !== micTestOwner) {
    // The user moved on while it was starting.
    if (r.ok) await api.micTest(false);
    return;
  }
  if (!r.ok) {
    target.desc.textContent = r.message;
    target.desc.className = 'key-error';
    return;
  }
  micTesting = true;
  activeMeter = target.meter;
  target.button.textContent = 'Stop';
  target.desc.textContent = 'Speak now. The bar should move when you talk.';
  void refreshMicDevices(); // device names become available once permission is granted
}

async function stopMicTest(): Promise<void> {
  micTestOwner++;
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

async function fillMicSelect(sel: HTMLSelectElement): Promise<void> {
  try {
    const devices = await api.micDevices();
    const current = snap.settings.micDeviceId;
    sel.replaceChildren(new Option('Windows default', ''), ...devices.map((d) => new Option(d.label, d.deviceId)));
    sel.value = devices.some((d) => d.deviceId === current) ? current : '';
  } catch {
    // worker not ready yet; keep the default option
  }
}

async function refreshMicDevices(): Promise<void> {
  await fillMicSelect($<HTMLSelectElement>('micDeviceId'));
  const wizardSel = document.getElementById('wizard-mic') as HTMLSelectElement | null;
  if (wizardSel) await fillMicSelect(wizardSel);
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
    id: 'fastest',
    title: 'Fastest (recommended): OpenRouter + on-device speech',
    desc: 'One OpenRouter key. Your voice is recognised and the answer spoken right here on this PC (downloads ~175 MB once).',
    settings: { chatProvider: 'openrouter', sttProvider: 'local', ttsProvider: 'local' },
  },
  {
    id: 'best',
    title: 'Claude + cloud speech',
    desc: 'Claude answers, AssemblyAI hears you live, ElevenLabs speaks. 3 keys.',
    settings: { chatProvider: 'anthropic', sttProvider: 'assemblyai', ttsProvider: 'elevenlabs' },
  },
  {
    id: 'fewer',
    title: 'Two keys, free voice',
    desc: 'Claude and AssemblyAI, with the built-in Windows voice. 2 keys.',
    settings: { chatProvider: 'anthropic', sttProvider: 'assemblyai', ttsProvider: 'system' },
  },
  {
    id: 'openai',
    title: 'Fastest to set up: just OpenAI',
    desc: 'One OpenAI key for answers, speech to text and voice. 1 key.',
    settings: { chatProvider: 'openai', sttProvider: 'openai', ttsProvider: 'openai' },
  },
  {
    id: 'openrouter',
    title: 'Just OpenRouter (1 key)',
    desc: 'A fast Gemini model sees your screen and hears your question directly; Windows voice reads the answer. No AssemblyAI needed.',
    settings: { chatProvider: 'openrouter', sttProvider: 'model', ttsProvider: 'system' },
  },
  {
    id: 'openrouter-live',
    title: 'OpenRouter + live speech to text',
    desc: 'OpenRouter answers, AssemblyAI transcribes while you talk, Windows voice. 2 keys.',
    settings: { chatProvider: 'openrouter', sttProvider: 'assemblyai', ttsProvider: 'system' },
  },
];

const STEPS = ['welcome', 'providers', 'keys', 'mic', 'key', 'done'] as const;
let step = 0;
let focusedStep = -1;

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

/** Keys that are missing or failed their last check. */
function keysBlocking(): CredentialId[] {
  return requiredCredentials(snap.settings).filter((id) => !snap.keys[id] || isRejected(id) || keyChecks[id]?.checking);
}

function firstIncompleteStep(): number {
  return keysBlocking().length ? STEPS.indexOf('keys') : STEPS.indexOf('mic');
}

function openWizard(at = 0): void {
  step = at;
  focusedStep = -1;
  $('wizard').hidden = false;
  document.querySelector('main')?.setAttribute('inert', '');
  document.querySelector('nav')?.setAttribute('inert', '');
  renderWizard();
}

async function closeWizard(): Promise<void> {
  await stopMicTest();
  await setKeyDetection(false);
  $('wizard').hidden = true;
  document.querySelector('main')?.removeAttribute('inert');
  document.querySelector('nav')?.removeAttribute('inert');
  if (!snap.settings.onboardingDone) await save({ onboardingDone: true }, true);
  render();
}

let keyDetectOn = false;
async function setKeyDetection(on: boolean): Promise<void> {
  if (keyDetectOn === on) return;
  keyDetectOn = on;
  await api.holdKeyTest(on);
}

api.onHoldKey((down) => {
  const target = document.getElementById('key-detect');
  if (!target) return;
  target.className = 'detected';
  target.textContent = down
    ? `✓ ${HOLD_KEY_LABELS[snap.settings.holdKey]} detected. Let go…`
    : '✓ Works. When you use Clicky, talk while holding it.';
});

function updateWizardNext(): void {
  if (STEPS[step] !== 'keys') return;
  const blocking = keysBlocking();
  $<HTMLButtonElement>('wizard-next').disabled = blocking.length > 0;
  const note = document.getElementById('wizard-keys-note');
  if (note) {
    const rejected = blocking.filter((id) => snap.keys[id] && isRejected(id));
    const checking = blocking.filter((id) => keyChecks[id]?.checking);
    note.textContent = checking.length
      ? `Checking ${listNames(checking)}…`
      : blocking.length
        ? rejected.length
          ? `${listNames(rejected)} ${rejected.length > 1 ? 'were' : 'was'} rejected. Paste the key again, or skip and fix it later.`
          : `Still needed: ${listNames(blocking)}. You can also skip and add them later.`
        : 'All keys work.';
  }
}

function renderWizard(): void {
  if ($('wizard').hidden) return;
  const body = $('wizard-body');
  const s = snap.settings;
  const key = HOLD_KEY_LABELS[s.holdKey];
  $('wizard-steps').replaceChildren(...STEPS.map((_, i) => el('span', { className: i <= step ? 'done' : '' })));
  $('wizard-progress').textContent = `Step ${step + 1} of ${STEPS.length}`;
  const back = $<HTMLButtonElement>('wizard-back');
  const next = $<HTMLButtonElement>('wizard-next');
  back.hidden = step === 0;
  next.disabled = false;
  next.textContent = 'Next';
  $('wizard-skip').hidden = step === STEPS.length - 1;
  $('wizard-skip').textContent =
    step === 0 ? 'Set up later' : STEPS[step] === 'keys' ? 'Skip for now' : 'Skip the rest';
  void setKeyDetection(STEPS[step] === 'key');

  const h1 = (text: string): HTMLElement => el('h1', { text, id: 'wizard-title' });
  const name = STEPS[step];
  let focusTarget: HTMLElement | null;
  if (name === 'welcome') {
    body.replaceChildren(
      h1('Meet Clicky'),
      el('p', {
        text: 'A little companion that lives next to your mouse pointer. Ask it about anything on your screen and it answers out loud, then points at the right spot.',
      }),
      el('ol', { className: 'steps-list' }, [
        el('li', {}, ['Hold ', el('span', { className: 'big-key', text: key }), ' and ask a question.']),
        el('li', { text: 'Let go. Clicky looks at your screen and starts talking right away.' }),
        el('li', { text: 'The triangle flies to whatever it is talking about.' }),
      ]),
      el('p', {
        text: 'Setup: pick your AI services, paste their API keys, and check your microphone. Have your keys ready, or create them as you go.',
      }),
    );
    next.textContent = 'Get started';
    focusTarget = next;
  } else if (name === 'providers') {
    const current = presetFor(s);
    const choices = PRESETS.map((p) => {
      const c = el('button', { className: `choice${current === p.id ? ' selected' : ''}` }, [
        el('div', { className: 'title', text: p.title }),
        el('div', { className: 'desc', text: p.desc }),
      ]);
      c.type = 'button';
      c.setAttribute('aria-pressed', String(current === p.id));
      c.addEventListener(
        'click',
        () =>
          void save(p.settings, true).then(() => {
            ensureLocalModels(snap.settings);
            renderWizard();
          }),
      );
      return c;
    });
    body.replaceChildren(
      h1('Choose your AI services'),
      el('p', { text: 'You can change this any time in AI and voice.' }),
      el('div', { className: 'choices' }, choices),
    );
    if (!current) body.append(el('p', { text: 'You have a custom combination selected. Keep it, or pick one above.' }));
    focusTarget = choices.find((c) => c.classList.contains('selected')) ?? choices[0] ?? null;
  } else if (name === 'keys') {
    const needed = requiredCredentials(s);
    body.replaceChildren(
      h1('Add your keys'),
      el('p', {
        text: 'Paste each key and press Save. Clicky checks it right away. Keys are encrypted by Windows and only ever sent to the service they belong to.',
      }),
    );
    if (!snap.encryptionAvailable) {
      body.append(
        el('div', {
          className: 'banner error',
          text: "Windows encryption isn't available, so keys can't be saved safely right now. Restart your PC and try again.",
        }),
      );
    }
    body.append(
      el(
        'div',
        { className: 'card' },
        needed.map((id) => keyRow(id, true)),
      ),
      el('p', { id: 'wizard-keys-note' }),
    );
    updateWizardNext();
    const firstMissing = needed.find((id) => !snap.keys[id] || isRejected(id));
    focusTarget =
      body.querySelector<HTMLInputElement>(`.key-row[data-key="${firstMissing ?? ''}"] input[type=password]`) ??
      body.querySelector<HTMLInputElement>('input[type=password]');
  } else if (name === 'mic') {
    const desc = el('div', { className: 'desc', text: 'Press Test and say something.' });
    const meter = el('div', { className: 'meter-fill' });
    const testBtn = el('button', { className: 'secondary', text: 'Test microphone' });
    testBtn.type = 'button';
    testBtn.addEventListener('click', async () => {
      if (micTesting) {
        await stopMicTest();
        testBtn.textContent = 'Test microphone';
      } else {
        await startMicTest({ desc, meter, button: testBtn });
      }
    });
    const sel = el('select', { id: 'wizard-mic' });
    sel.setAttribute('aria-label', 'Microphone');
    sel.append(new Option('Windows default', ''));
    void fillMicSelect(sel);
    sel.addEventListener('change', () => void save({ micDeviceId: sel.value }, true));
    body.replaceChildren(
      h1('Check your microphone'),
      el('p', { text: 'Clicky only sends audio while you hold the key.' }),
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
    focusTarget = testBtn;
  } else if (name === 'key') {
    const sel = el('select');
    sel.setAttribute('aria-label', 'Hold-to-talk key');
    for (const k of HOLD_KEYS) sel.add(new Option(HOLD_KEY_LABELS[k], k));
    sel.value = s.holdKey;
    sel.addEventListener(
      'change',
      () => void save({ holdKey: sel.value as Settings['holdKey'] }, true).then(renderWizard),
    );
    const detect = el('div', {
      className: 'desc',
      id: 'key-detect',
      text: `Press and hold ${key} now to check it works.`,
    });
    const voiceDesc = el('div', { className: 'desc', text: 'Hear how Clicky sounds.' });
    const play = button('Play sample', 'secondary', async () => {
      voiceDesc.className = 'desc';
      voiceDesc.textContent = 'Playing…';
      const r = await api.voiceTest();
      voiceDesc.textContent = r.message;
      voiceDesc.className = r.ok ? 'key-ok' : 'key-error';
    });
    body.replaceChildren(
      h1('Your talk key and voice'),
      el('p', {
        text: 'Pick a key you can hold comfortably. Some laptops have no Right Ctrl; choose another key if nothing is detected.',
      }),
      el('div', { className: 'card' }, [
        el('div', { className: 'row' }, [
          el('div', { className: 'label' }, [el('div', { className: 'title', text: 'Hold-to-talk key' }), detect]),
          sel,
        ]),
        el('div', { className: 'row' }, [
          el('div', { className: 'label' }, [el('div', { className: 'title', text: 'Voice' }), voiceDesc]),
          play,
        ]),
      ]),
    );
    focusTarget = sel;
  } else {
    const result = el('div', { className: 'try-result desc', id: 'try-result' });
    const tryBtn = button('Try it now', 'primary', async () => {
      if (snap.missing.length) {
        result.className = 'try-result key-error';
        result.textContent = `Add your ${listNames(snap.missing)} key first.`;
        return;
      }
      result.className = 'try-result desc';
      result.textContent = 'Clicky is looking at your screen and answering…';
      const r = await api.tryIt();
      if (!r) return;
      if (r.outcome === 'answered') {
        result.className = 'try-result key-ok';
        result.textContent = `✓ “${r.answer}”${r.pointLabel ? ` (pointed at ${r.pointLabel})` : ''}`;
      } else {
        result.className = 'try-result key-error';
        result.textContent =
          r.outcome === 'cancelled'
            ? 'That was stopped before it finished. Try again.'
            : (r.detail ?? 'That did not work.');
      }
    });
    body.replaceChildren(
      h1("You're all set"),
      el('p', {
        text: 'Try a typed question first: Clicky hides this window, looks at your screen, answers out loud and points, then comes back here. Then try your voice:',
      }),
      tryBtn,
      result,
      el('ol', { className: 'steps-list' }, [
        el('li', {}, ['Hold ', el('span', { className: 'big-key', text: key }), '.']),
        el('li', { text: 'Ask “What am I looking at?” or “Where is the settings button?”' }),
        el('li', { text: 'Let go and listen. Press Esc to stop an answer.' }),
      ]),
      el('p', {
        text: 'Clicky lives in the tray. If you don’t see it near the clock, click the ^ arrow. Opening Clicky from the Start menu also brings you back here.',
      }),
    );
    next.textContent = 'Finish';
    focusTarget = tryBtn;
  }
  // Move focus into a new step so keyboard and screen-reader users land in the right place, but
  // never on background refreshes of the same step.
  if (focusedStep !== step) {
    focusedStep = step;
    (focusTarget ?? next).focus();
  }
}

// ----------------------------------------------------------------- render all

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
  // Keep the wizard in sync, but don't rebuild steps with live controls (mic meter, key detection).
  if (!$('wizard').hidden && STEPS[step] === 'providers') renderWizard();
  else if (!$('wizard').hidden && STEPS[step] === 'keys') {
    if (typingKey()) updateWizardNext();
    else renderWizard();
  }
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
  labelControls();

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
  bindSelect('localVoice');
  bindSelect('localSttModel');
  bindSelect('localVoiceSpeed', Number);

  $('ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('ask-input');
    const q = input.value.trim();
    if (!q || isBusy() || snap.missing.length) return;
    input.value = '';
    $<HTMLButtonElement>('ask-btn').disabled = true;
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

  let savingAction = false;
  $('action-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (savingAction) return;
    savingAction = true;
    try {
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
    } finally {
      savingAction = false;
    }
  });
  $('action-cancel').addEventListener('click', resetActionForm);

  const micBtn = $<HTMLButtonElement>('mic-test');
  micBtn.addEventListener('click', () => {
    if (micTesting) void stopMicTest();
    else void startMicTest({ desc: $('mic-test-desc'), meter: $('mic-meter'), button: micBtn });
  });
  $('voice-test').addEventListener('click', async () => {
    const b = $<HTMLButtonElement>('voice-test');
    if (b.disabled) return;
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
  $('copy-diagnostics').addEventListener('click', async () => {
    const text = await api.diagnostics();
    await navigator.clipboard.writeText(text);
    toast('Diagnostics copied');
  });
  $('open-logs').addEventListener('click', () => void api.openLogs());
  $('last-error-dismiss').addEventListener('click', () => {
    dismissedErrorId = snap.history[0]?.id ?? null;
    renderHome();
  });

  let moving = false;
  const move = async (delta: number): Promise<void> => {
    if (moving) return;
    moving = true;
    try {
      if (STEPS[step] === 'mic') await stopMicTest();
      if (delta > 0 && step >= STEPS.length - 1) return void (await closeWizard());
      step = Math.min(STEPS.length - 1, Math.max(0, step + delta));
      renderWizard();
    } finally {
      moving = false;
    }
  };
  $('wizard-next').addEventListener('click', () => {
    if (!$<HTMLButtonElement>('wizard-next').disabled) void move(1);
  });
  $('wizard-back').addEventListener('click', () => void move(-1));
  $('wizard-skip').addEventListener('click', () => {
    if (STEPS[step] === 'keys') {
      step++;
      renderWizard();
    } else void closeWizard();
  });
  document.addEventListener('keydown', (e) => {
    if ($('wizard').hidden) return;
    if (e.key === 'Escape' && snap.settings.onboardingDone) void closeWizard();
    // Keep Tab inside the wizard.
    if (e.key === 'Tab') {
      const focusables = [
        ...$('wizard').querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select'),
      ].filter((x) => x.offsetParent !== null);
      const first = focusables[0];
      const last = focusables.at(-1);
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
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
  else if (snap.missing.length && !page) showPage('keys');
  // Relative times ("2 min ago") stay fresh.
  window.setInterval(() => {
    if (currentPage === 'home') renderHome();
    else if (currentPage === 'history') renderHistory();
  }, 60_000);
}

void init();
