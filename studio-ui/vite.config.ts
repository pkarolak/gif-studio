import path from 'node:path';
import {fileURLToPath} from 'node:url';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const target = process.env.GIF_STUDIO_URL ?? 'http://localhost:4455';

export default defineConfig({
  root,
  base: '/',
  plugins: [react()],
  build: {outDir: path.join(root, '..', 'dist', 'studio'), emptyOutDir: true},
  server: {
    proxy: {
      '/api': target,
      '/files': target,
      '/__studio': target,
      '/ws': {target: target.replace(/^http/, 'ws'), ws: true},
    },
  },
});
