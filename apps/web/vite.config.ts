import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const API_PORT = Number(process.env.API_PORT ?? 5178);

/**
 * Токен доступа к API. При включённом удалённом доступе сервер требует его от
 * ВСЕХ — иначе проверка не защищала бы ни от чего (Origin подделывает любой
 * не-браузерный клиент). Браузеру токен взять неоткуда, а прокси живёт на той же
 * машине и читает тот же файл, что и сервер, поэтому подставляет заголовок сам.
 * Кэш по времени изменения файла, а не по TTL: после «Сменить токен» сервер уже
 * ждёт новый, и с пятисекундным кэшем каждый клик в это окно получал 401.
 * `stat` на запрос стоит копейки, а окна не остаётся вовсе.
 */
const TOKEN_PATH = join(homedir(), '.claude-control', 'api-token');
let tokenCache = { value: '', mtimeMs: -1 };

function apiToken(): string {
  try {
    const { mtimeMs } = statSync(TOKEN_PATH);
    if (mtimeMs !== tokenCache.mtimeMs) {
      tokenCache = { value: readFileSync(TOKEN_PATH, 'utf8').trim(), mtimeMs };
    }
  } catch {
    // Файла нет или он недоступен — значит удалённый доступ не настраивали.
    tokenCache = { value: '', mtimeMs: -1 };
  }
  return tokenCache.value;
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
