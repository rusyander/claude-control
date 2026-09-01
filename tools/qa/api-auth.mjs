/**
 * Заголовок доступа для прогонов, которые ходят в API НАПРЯМУЮ, мимо страницы.
 *
 * Браузеру он не нужен: запросы идут через прокси Vite, и токен подставляет он.
 * А `fetch` из самого прогона — уже не браузер: при включённом удалённом доступе
 * сервер отвечает такому запросу 401, и прогон падает не там, где сломано.
 * Ровно на этом сломался `check-resources`: `scripts.find is not a function` —
 * потому что вместо списка приехал объект отказа.
 *
 * Гейт может быть и выключен — тогда файла с токеном просто нет, и заголовка не
 * будет: проверка остаётся рабочей в обоих состояниях.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function authHeaders() {
  try {
    const token = readFileSync(join(homedir(), '.claude-control', 'api-token'), 'utf8').trim();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/** `fetch` до API с уже подставленным доступом. */
export function apiFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { ...(init.headers ?? {}), ...authHeaders() } });
}
