import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';
import { licenseNotices } from './notices.mjs';

const notices = licenseNotices();

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react(), notices.app],
  worker: { plugins: () => [notices.worker] },
  resolve: { alias: { '@': fileURLToPath(new URL('..', import.meta.url)) } },
  css: { postcss: { plugins: [tailwindcss()] } },
  build: { outDir: '../dist-desktop', emptyOutDir: true },
});
