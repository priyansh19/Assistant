// The task strip: what Clicky is doing for the user right now, with Pause, Stop, Allow (for a
// risky step) and Allow all. It never takes focus, so the app Clicky is working in stays active.
import type { StripApi, StripState } from '../../preload/strip';

declare global {
  interface Window {
    clickyStrip: StripApi;
  }
}

const api = window.clickyStrip;
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

const PAUSE = '<rect x="2" y="1.5" width="3" height="9" rx="1"/><rect x="7" y="1.5" width="3" height="9" rx="1"/>';
const PLAY = '<path d="M3 1.5 L10.5 6 L3 10.5 Z"/>';

let paused = false;
let allowAll = false;
let lastNow = '';

function render(s: StripState): void {
  document.documentElement.style.setProperty('--accent', s.color);
  $('goal').textContent = s.goal ? s.goal.charAt(0).toUpperCase() + s.goal.slice(1) : 'Working…';
  const now = s.ask
    ? s.ask
    : s.paused
      ? s.pausedForUser
        ? 'Paused while you use the mouse. I carry on when you stop.'
        : 'Paused. Press play to carry on.'
      : s.say;
  if (now !== lastNow) {
    // Replay the fade so each new step reads as new.
    const el = $('now');
    el.textContent = now;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    lastNow = now;
  }
  $('step').hidden = !s.step || !!s.ask;
  $('step').textContent = `Step ${s.step}`;
  $('strip').classList.toggle('asking', !!s.ask);
  $('strip').classList.toggle('paused', s.paused);
  $('allow').hidden = !s.ask;
  allowAll = !!s.allowAll;
  $('all').classList.toggle('on', allowAll);
  $('all').textContent = allowAll ? 'All allowed' : 'Allow all';
  paused = s.paused;
  ($('pauseIcon') as unknown as SVGElement).innerHTML = paused ? PLAY : PAUSE;
  $('pause').title = paused ? 'Resume' : 'Pause';
}

$('allow').addEventListener('click', () => api.allow());
$('all').addEventListener('click', () => api.allowAll(!allowAll));
$('pause').addEventListener('click', () => api.pause(!paused));
$('stop').addEventListener('click', () => api.stop());
api.onState(render);
