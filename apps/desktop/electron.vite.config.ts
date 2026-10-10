import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

// Workspace packages (@clicky/*) are devDependencies so they get bundled; only real runtime
// dependencies such as the native uiohook-napi addon stay external.
export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      rollupOptions: { input: { overlay: resolve(__dirname, 'src/preload/overlay.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: { overlay: resolve(__dirname, 'src/renderer/overlay/index.html') } },
    },
  },
});
