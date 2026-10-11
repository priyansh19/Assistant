import type { SttProvider, VisionChatProvider } from '@clicky/core';

/**
 * Offline stand-ins for the cloud services, used when CLICKY_DEMO=1. They let the whole loop
 * (hold key, mic, capture, overlay flight, voice, history) run on the laptop without API keys,
 * which is how the app is smoke-tested end to end. Never used in a normal run.
 */
export const DEMO = process.env['CLICKY_DEMO'] === '1';

export function demoStt(): SttProvider {
  return {
    id: 'demo-stt',
    async start() {
      let frames = 0;
      return {
        pushAudio: () => void frames++,
        // Answer even if the mic produced nothing, so the loop can be tested on a silent machine.
        finish: async () => 'Where is the start button?',
        close: () => undefined,
      };
    },
  };
}

export function demoChat(): VisionChatProvider {
  return {
    id: 'demo-chat',
    async *stream(req) {
      if (req.system.startsWith("You are Clicky's agent")) {
        // Agent mode: one harmless step, then finish.
        await new Promise((r) => setTimeout(r, 120));
        yield req.question.includes('Steps so far')
          ? '{"action":"done","say":"The demo task is finished."}'
          : '{"action":"wait","ms":300,"say":"Waiting a moment"}';
        return;
      }
      const img = req.images[0];
      // Point near the bottom-left of the first screenshot, where the Start button usually is.
      const x = img ? Math.round(img.width * 0.42) : 100;
      const y = img ? Math.round(img.height * 0.97) : 100;
      const w = img?.width ?? 1000;
      const h = img?.height ?? 600;
      const parts = [
        `[POINT:${x},${y}:Start button]`,
        // Show the drawing marks too: an arrow from the middle of the screen down to the taskbar.
        `[ARROW:${Math.round(w * 0.5)},${Math.round(h * 0.55)},${x},${Math.round(h * 0.9)}:here][BOX:0,${Math.round(h * 0.94)},${w},${Math.round(h * 0.06)}:Taskbar]`,
        'The Start button is in the taskbar at the bottom of your screen. ',
        'Click it to open your apps.',
      ];
      for (const p of parts) {
        await new Promise((r) => setTimeout(r, 120));
        if (req.signal.aborted) throw new Error('aborted');
        yield p;
      }
    },
  };
}
