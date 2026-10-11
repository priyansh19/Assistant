// The task strip: what Clicky is doing for the user right now, with Pause, Stop and (for a risky
// step) Allow. It never takes focus, so the app Clicky is working in stays active.
import type { StripApi, StripState } from '../../preload/strip';

declare global {
  interface Window {
    clickyStrip: StripApi;
  }
}

const api = window.clickyStrip;
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

let paused = false;

function render(s: StripState): void {
  document.documentElement.style.setProperty('--accent', s.color);
  $('goal').textContent = s.goal ? `Doing: ${s.goal}` : 'Working…';
  $('now').textContent = s.ask
    ? s.ask
    : s.paused
      ? 'Paused. Press Resume to carry on.'
      : s.step
        ? `Step ${s.step} of up to ${s.max}: ${s.say}`
        : s.say;
  $('strip').classList.toggle('asking', !!s.ask);
  $('allow').hidden = !s.ask;
  paused = s.paused;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
}

$('allow').addEventListener('click', () => api.allow());
$('pause').addEventListener('click', () => api.pause(!paused));
$('stop').addEventListener('click', () => api.stop());
api.onState(render);
