import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

// Workspace packages (@clicky/*) are devDependencies so they get bundled; only real runtime
// dependencies such as the native uiohook-napi addon stay external.
// Preloads must not share runtime modules: sandboxed preloads can't load the shared chunk
// Rollup would create. They import only types from ../shared and inline their channel names.
export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
          settings: resolve(__dirname, 'src/preload/settings.ts'),
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
          settings: resolve(__dirname, 'src/renderer/settings/index.html'),
        },
      },
    },
  },
});
