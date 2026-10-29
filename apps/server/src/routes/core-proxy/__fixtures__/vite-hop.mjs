import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// Настоящий dev-сервер Vite с настоящим `apps/web/vite.config.ts` отдельным процессом — звено
// между браузером и панелью. Цель прокси — `API_PORT` из окружения (так её читает сам конфиг).
// Порт — свободный (`0` поверх 8888 конфига), слежение за файлами снято (`VITE_NO_RELOAD=1`
// в окружении). Первой строкой stdout — порт и pid; дальше молчит.
const [webDir] = process.argv.slice(2);
const vite = await import(
  pathToFileURL(join(webDir, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href
);
const server = await vite.createServer({
  root: webDir,
  configFile: join(webDir, 'vite.config.ts'),
  logLevel: 'silent',
  server: { port: 0, strictPort: false, host: '127.0.0.1' },
});
await server.listen();
const { port } = server.httpServer.address();
process.stdout.write(`${JSON.stringify({ port, pid: process.pid })}\n`);
