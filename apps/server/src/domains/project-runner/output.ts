/**
 * Разбор вывода dev-сервера: адрес, жалоба на занятый порт, хвост для показа.
 * Чистые функции — тесты проверяют их без настоящего сервера.
 */

/**
 * Управляющие последовательности цвета — до разбора адреса их снимаем: адрес
 * почти всегда напечатан цветным, и без этого регулярка не совпала бы.
 */
// eslint-disable-next-line no-control-regex -- ESC и есть ровно то, что мы вырезаем
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Локальный адрес в выводе dev-сервера: `http://localhost:5173`,
 * `http://127.0.0.1:3000/`, `http://[::1]:4200`.
 *
 * Совпадения по внешним адресам (`Network: http://192.168.1.5:5173`) намеренно
 * не ловим: панель ведёт пользователя на localhost, и он должен быть тем же
 * localhost, который она проверяет TCP-пробой.
 */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/i;

/**
 * Порт, который сервер объявил занятым, — из его собственного вывода.
 *
 * Требуем именно «already in use» либо `EADDRINUSE`: Vite при свободном выборе
 * порта печатает «Port 5173 is in use, trying another one...» и спокойно
 * поднимается на следующем — это не отказ и предлагать убийство там нечего.
 */
const PORT_TAKEN = /port\s+(\d{2,5})\s+(?:is|was)\s+already\s+in\s+use/i;
const ADDR_IN_USE = /EADDRINUSE[^\n]{0,80}?:(\d{2,5})\b/i;
/** Go: `listen tcp 127.0.0.1:8080: bind: address already in use` (и вариант Windows). */
const GO_BIND = /listen tcp \S*:(\d{2,5}): bind: (?:address already in use|only one usage)/i;

/**
 * Адрес без схемы — так его печатают бэкенды: Go (`listening on :8080`,
 * `[GIN-debug] Listening and serving HTTP on :8080`), Echo (`http server
 * started on [::]:1323`), Spring (`Tomcat started on port 8080 (http)`,
 * `port(s): 8080`), Rust (`listening on 127.0.0.1:3000`).
 *
 * Глагол обязателен, и число не должно продолжаться датой или временем:
 * `Started at 10:45` или `started on 2026-10-12` портом не являются.
 */
const BARE_PORT =
  /\b(?:listening|serving|started|running)\b[^\n]{0,60}?\b(?:on|at)\s+(?:port\s*(?:\(s\))?:?\s*)?(?:(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|::)?:)?(\d{2,5})(?![\d.:\-/])/i;

/** Номер порта из совпадения регулярки; мусор и выход за диапазон — undefined. */
function toPort(raw: string | undefined): number | undefined {
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

/** Порт из вывода процесса или undefined, если адреса там ещё нет. */
export function extractServerPort(output: string): number | undefined {
  const clean = output.replace(ANSI, '');
  const match = LOCAL_URL.exec(clean) ?? BARE_PORT.exec(clean);
  return match ? toPort(match[1]) : undefined;
}

/** Порт, на который сервер пожаловался «уже занят», если он вообще жаловался. */
export function extractBusyPort(output: string): number | undefined {
  const clean = output.replace(ANSI, '');
  const match = PORT_TAKEN.exec(clean) ?? ADDR_IN_USE.exec(clean) ?? GO_BIND.exec(clean);
  return match ? toPort(match[1]) : undefined;
}

/** Хвост вывода для показа: последние непустые строки без управляющих кодов. */
export function lastLines(output: string, count = 12): string {
  return output
    .replace(ANSI, '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-count)
    .join('\n')
    .trim();
}
