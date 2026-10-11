// The Allow all orb: hovering it opens a card with Turn off; leaving the card closes it again.
import type { OrbApi } from '../../preload/orb';

declare global {
  interface Window {
    clickyOrb: OrbApi;
  }
}

const api = window.clickyOrb;
const root = document.getElementById('root') as HTMLElement;
const orb = document.getElementById('orb') as HTMLElement;
const card = document.getElementById('card') as HTMLElement;
let closeTimer: number | undefined;

function open(): void {
  window.clearTimeout(closeTimer);
  root.classList.add('open');
  api.hover(true);
}

function close(): void {
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(() => {
    root.classList.remove('open');
    api.hover(false);
  }, 250);
}

orb.addEventListener('mouseenter', open);
card.addEventListener('mouseenter', open);
orb.addEventListener('mouseleave', close);
card.addEventListener('mouseleave', close);
(document.getElementById('off') as HTMLElement).addEventListener('click', () => {
  root.classList.remove('open');
  api.hover(false);
  api.off();
});
