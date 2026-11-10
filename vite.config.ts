import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': `http://127.0.0.1:${process.env.PORT ?? 4317}`,
    },
  },
  build: { outDir: 'dist' },
});
