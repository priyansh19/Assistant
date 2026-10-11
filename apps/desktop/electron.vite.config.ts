import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

// Workspace packages (@clicky/*) are devDependencies so they get bundled; only real runtime
// dependencies such as the native uiohook-napi addon stay external.
// Preloads must not share runtime modules: sandboxed preloads can't load the shared chunk
// Rollup would create. They import only types from ../shared and inline their channel names.
export default defineConfig({
  main: {
    build: {
      // The engine is a second Node entry, run as an Electron utilityProcess (architecture §4).
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          engine: resolve(__dirname, 'src/engine/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
          dashboard: resolve(__dirname, 'src/preload/dashboard.ts'),
          worker: resolve(__dirname, 'src/preload/worker.ts'),
          strip: resolve(__dirname, 'src/preload/strip.ts'),
          orb: resolve(__dirname, 'src/preload/orb.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          dashboard: resolve(__dirname, 'src/renderer/dashboard/index.html'),
          worker: resolve(__dirname, 'src/renderer/worker/index.html'),
          strip: resolve(__dirname, 'src/renderer/strip/index.html'),
          orb: resolve(__dirname, 'src/renderer/orb/index.html'),
        },
      },
    },
  },
});
