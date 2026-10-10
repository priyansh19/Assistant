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
      const img = req.images[0];
      // Point near the bottom-left of the first screenshot, where the Start button usually is.
      const x = img ? Math.round(img.width * 0.42) : 100;
      const y = img ? Math.round(img.height * 0.97) : 100;
      const parts = [
        `[POINT:${x},${y}:Start button]`,
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
