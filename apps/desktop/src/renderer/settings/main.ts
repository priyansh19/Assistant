import { HOLD_KEY_LABELS, HOLD_KEYS, requiredCredentials, type CredentialId, type Settings } from '@clicky/core';
import type { SettingsApi } from '../../preload/settings';
import type { SettingsSnapshot } from '../../shared/ipc';

declare global {
  interface Window {
    clickySettings: SettingsApi;
  }
}

const api = window.clickySettings;

const KEY_INFO: Record<CredentialId, { name: string; desc: string; url: string }> = {
  anthropic: { name: 'Anthropic', desc: 'Claude models for answers.', url: 'console.anthropic.com' },
  openrouter: { name: 'OpenRouter', desc: 'One key for many models.', url: 'openrouter.ai/keys' },
  openai: { name: 'OpenAI', desc: 'GPT models, speech to text and voice.', url: 'platform.openai.com/api-keys' },
  assemblyai: { name: 'AssemblyAI', desc: 'Fast live speech to text.', url: 'assemblyai.com/dashboard' },
  elevenlabs: { name: 'ElevenLabs', desc: 'Natural voices.', url: 'elevenlabs.io/app/settings/api-keys' },
};

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`settings: #${id} missing`);
  return el as T;
}

let snapshot: SettingsSnapshot;
let toastTimer: number | undefined;

function toast(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 1600);
}

function showPage(page: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    b.classList.toggle('active', b.dataset['page'] === page);
  }
  for (const s of document.querySelectorAll<HTMLElement>('.page')) {
    s.classList.toggle('active', s.id === `page-${page}`);
  }
}

async function save(partial: Partial<Settings>): Promise<void> {
  snapshot = await api.update(partial);
  render();
  toast('Saved');
}

// ---- General + AI pages: plain controls bound to settings fields ----

function bindSelect(id: keyof Settings, parse: (v: string) => unknown = (v) => v): void {
  const el = $<HTMLSelectElement>(id);
  el.addEventListener('change', () => void save({ [id]: parse(el.value) } as Partial<Settings>));
}

function bindToggle(id: keyof Settings): void {
  const el = $<HTMLInputElement>(id);
  el.addEventListener('change', () => void save({ [id]: el.checked } as Partial<Settings>));
}

function bindText(id: keyof Settings): void {
  const el = $<HTMLInputElement>(id);
  el.addEventListener('change', () => void save({ [id]: el.value } as Partial<Settings>));
}

function renderControls(s: Settings): void {
  $<HTMLSelectElement>('holdKey').value = s.holdKey;
  $<HTMLInputElement>('launchAtLogin').checked = s.launchAtLogin;
  $<HTMLInputElement>('captureAllDisplays').checked = s.captureAllDisplays;
  const edge = $<HTMLSelectElement>('captureMaxEdge');
  if (![...edge.options].some((o) => o.value === String(s.captureMaxEdge))) {
    edge.add(new Option(`Custom (${s.captureMaxEdge} px)`, String(s.captureMaxEdge)));
  }
  edge.value = String(s.captureMaxEdge);
  $<HTMLSelectElement>('chatProvider').value = s.chatProvider;
  $<HTMLInputElement>('chatModel').value = s.chatModel;
  $<HTMLSelectElement>('sttProvider').value = s.sttProvider;
  $<HTMLSelectElement>('ttsProvider').value = s.ttsProvider;
  $<HTMLInputElement>('ttsVoice').value = s.ttsVoice;
  $('ttsVoiceRow').hidden = s.ttsProvider !== 'elevenlabs';
}

// ---- API keys page ----

function renderKeys(): void {
  const needed = new Set(requiredCredentials(snapshot.settings));
  const list = $('keys-list');
  list.replaceChildren();
  const ordered = (Object.keys(KEY_INFO) as CredentialId[]).sort(
    (a, b) => Number(needed.has(b)) - Number(needed.has(a)),
  );
  for (const id of ordered) {
    const info = KEY_INFO[id];
    const saved = snapshot.keys[id];
    const row = document.createElement('div');
    row.className = 'row key-row';

    const label = document.createElement('div');
    label.className = 'label';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = info.name;
    const status = document.createElement('span');
    status.className = `status ${saved ? 'saved' : needed.has(id) ? 'needed' : 'optional'}`;
    status.textContent = saved ? 'Saved' : needed.has(id) ? 'Needed' : 'Optional';
    title.append(status);
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = `${info.desc} Get a key at ${info.url}`;
    const error = document.createElement('div');
    error.className = 'key-error';
    error.hidden = true;
    label.append(title, desc, error);

    const controls = document.createElement('div');
    controls.className = 'key-input';
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = saved ? '•••••••••• (paste to replace)' : 'Paste key';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.disabled = !snapshot.encryptionAvailable;
    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Save';
    saveBtn.disabled = true;
    input.addEventListener('input', () => {
      saveBtn.disabled = input.value.trim() === '';
      error.hidden = true;
    });
    const doSave = async (): Promise<void> => {
      saveBtn.disabled = true;
      const r = await api.setKey(id, input.value);
      input.value = '';
      if (r.ok) {
        snapshot = r.snapshot;
        render();
        toast(`${info.name} key saved`);
      } else {
        error.textContent = r.reason;
        error.hidden = false;
      }
    };
    saveBtn.addEventListener('click', () => void doSave());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) void doSave();
    });
    controls.append(input, saveBtn);
    if (saved) {
      const remove = document.createElement('button');
      remove.className = 'secondary';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        snapshot = await api.clearKey(id);
        render();
        toast(`${info.name} key removed`);
      });
      controls.append(remove);
    }

    row.append(label, controls);
    list.append(row);
  }
}

function renderMissing(): void {
  const missing = requiredCredentials(snapshot.settings).filter((id) => !snapshot.keys[id]);
  $('missing-banner').hidden = missing.length === 0;
  $('missing-text').textContent =
    `Add your ${missing.map((id) => KEY_INFO[id].name).join(', ')} key${missing.length > 1 ? 's' : ''}, or pick other providers.`;
  const badge = $('keys-badge');
  badge.hidden = missing.length === 0;
  badge.textContent = String(missing.length);
}

function render(): void {
  renderControls(snapshot.settings);
  renderKeys();
  renderMissing();
  $('encryption-banner').hidden = snapshot.encryptionAvailable;
  $('version').textContent = `Version ${snapshot.appVersion}`;
}

async function init(): Promise<void> {
  const holdKey = $<HTMLSelectElement>('holdKey');
  for (const k of HOLD_KEYS) holdKey.add(new Option(HOLD_KEY_LABELS[k], k));

  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    b.addEventListener('click', () => showPage(b.dataset['page'] ?? 'general'));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-goto]')) {
    b.addEventListener('click', () => showPage(b.dataset['goto'] ?? 'general'));
  }

  bindSelect('holdKey');
  bindToggle('launchAtLogin');
  bindToggle('captureAllDisplays');
  bindSelect('captureMaxEdge', Number);
  bindSelect('chatProvider');
  bindText('chatModel');
  bindSelect('sttProvider');
  bindSelect('ttsProvider');
  bindText('ttsVoice');

  snapshot = await api.get();
  render();
  // First run: land on the keys page if something is missing.
  if (requiredCredentials(snapshot.settings).some((id) => !snapshot.keys[id])) showPage('keys');
}

void init();
