import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const API_PORT = Number(process.env.API_PORT ?? 5178);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@app': fileURLToPath(new URL('./src/app', import.meta.url)),
      '@pages': fileURLToPath(new URL('./src/pages', import.meta.url)),
      '@features': fileURLToPath(new URL('./src/features', import.meta.url)),
      '@entities': fileURLToPath(new URL('./src/entities', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  server: {
    // Явный IPv4. По умолчанию Vite слушает localhost, а он на части систем
    // резолвится в ::1 — тогда адрес 127.0.0.1 не отвечает вовсе, и QA-скрипты
    // с инструментами, которые ходят по IPv4, до фронта не достучатся.
    host: '127.0.0.1',
    port: 8888,
    strictPort: true,
    open: true,
    // Фронт и API живут на разных портах: проксируем, чтобы в коде были
    // относительные пути и не приходилось думать про CORS.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        // Токены доступны в каждом модуле без ручного импорта.
        additionalData: `@use '@shared/styles/tokens' as *;`,
      },
    },
  },
});
