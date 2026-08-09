import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const API_PORT = Number(process.env.API_PORT ?? 5178);

/**
 * Токен доступа к API. При включённом удалённом доступе сервер требует его от
 * ВСЕХ — иначе проверка не защищала бы ни от чего (Origin подделывает любой
 * не-браузерный клиент). Браузеру токен взять неоткуда, а прокси живёт на той же
 * машине и читает тот же файл, что и сервер, поэтому подставляет заголовок сам.
 * Кэш на несколько секунд: смена токена подхватывается без перезапуска Vite.
 */
const TOKEN_PATH = join(homedir(), '.claude-control', 'api-token');
const TOKEN_TTL_MS = 5_000;
let tokenCache = { value: '', readAt: 0 };

function apiToken(): string {
  const now = Date.now();
  if (now - tokenCache.readAt < TOKEN_TTL_MS) return tokenCache.value;
  let value = '';
  try {
    if (existsSync(TOKEN_PATH)) value = readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch {
    // Файла нет или он недоступен — значит удалённый доступ не настраивали.
  }
  tokenCache = { value, readAt: now };
  return value;
}

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
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const token = apiToken();
            if (token) proxyReq.setHeader('authorization', `Bearer ${token}`);
          });
        },
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
