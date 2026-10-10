import { isCapturing } from '@clicky/core';
import type { OverlayApi } from '../../preload/overlay';

declare global {
  interface Window {
    clicky: OverlayApi;
  }
}

// Offset so the dot sits beside the pointer instead of under it, like the original.
const OFFSET = 18;
const dot = document.getElementById('dot');
if (!dot) throw new Error('overlay: #dot missing');

window.clicky.onCursor((cursor) => {
  dot.classList.toggle('visible', cursor !== null);
  if (cursor) dot.style.transform = `translate(${cursor.x + OFFSET}px, ${cursor.y + OFFSET}px)`;
});

window.clicky.onState((state) => {
  document.body.classList.toggle('listening', isCapturing(state));
});
