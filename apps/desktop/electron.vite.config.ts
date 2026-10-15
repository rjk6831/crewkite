import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: { externalizeDeps: false, rollupOptions: { input: resolve('src/main/index.ts') } },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs', codeSplitting: false },
      },
    },
  },
  renderer: { plugins: [react(), tailwindcss()] },
});
