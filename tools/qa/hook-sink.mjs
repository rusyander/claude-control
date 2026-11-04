/**
 * Приёмник вебхука для проверок на стенде: копит тела POST, отвечает 204. Не заглушка модели —
 * ни одного пути модельного протокола он не знает; модель у проверок — сценарий
 * `@agentdeck/stub-model` (P120). Отдельным модулем, чтобы проверка не держала свой сервер.
 */
import { createServer } from 'node:http';
import { freePort } from './throwaway-stand.mjs';

/** Поднять приёмник на свободном порту loopback; `hooks` — разобранные тела по порядку прихода. */
export async function startHookSink() {
  const hooks = [];
  const port = await freePort();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        hooks.push(JSON.parse(raw));
      } catch {
        hooks.push({ raw });
      }
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    hooks,
    url: `http://127.0.0.1:${port}/hook`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
