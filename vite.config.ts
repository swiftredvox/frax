import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', assetsInlineLimit: 0 },
  worker: { format: 'es' },
  // Polling makes file watching reliable on Windows when files are rewritten in place.
  server: { watch: { usePolling: true, interval: 200 } },
});
