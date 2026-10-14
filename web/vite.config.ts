import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the built page also works when inlined into a file:// snapshot.
  base: './',
  // elkjs ships its layout engine as one ~1.4 MB file; fine for a local tool.
  build: {
    chunkSizeWarningLimit: 2000,
    // Inline fonts as data URIs so the snapshot is one self-contained file with no network requests.
    assetsInlineLimit: 200_000,
  },
  server: {
    port: 4600,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4610' },
  },
});
