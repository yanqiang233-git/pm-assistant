import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'material-split': resolve(__dirname, 'modules/material-split/index.html')
      }
    }
  },
  server: {
    port: 5175,
    strictPort: true
  }
});
