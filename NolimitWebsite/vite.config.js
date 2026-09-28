import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        login: resolve(root, 'login.html'),
        payment: resolve(root, 'payment.html'),
        podminky: resolve(root, 'podminky.html'),
        soukromi: resolve(root, 'soukromi.html')
      }
    }
  }
});
