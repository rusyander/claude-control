/**
 * Кто имеет право обращаться к API.
 *
 * У API нет аутентификации — он по построению отдаёт секреты
 * (`/api/env/reveal`) и заводит хуки, то есть команды, которые Claude Code
 * выполнит сам. Пока сервер запущен, он доступен и любой открытой вкладке:
 * браузер отправит запрос на localhost с чужой страницы. Отражать присланный
 * Origin поэтому нельзя — иначе сторонний сайт вычитает токены из
 * `.mcp-secrets.env` и поставит хук с произвольной командой.
 *
 * Вынесено из index.ts отдельным модулем ради проверок: сам index.ts при
 * импорте поднимает сервер и слушает порт, так что в тесте его не завести.
 */

/** Что от запроса нужно решению. Ровно это есть и у Fastify, и у теста. */
export interface GuardedRequest {
  method: string;
  /** Путь с query-строкой, как в `request.url`. */
  url: string;
  origin?: string;
  /** Заголовок `Sec-Fetch-Site`. Отсутствует у не-браузерных клиентов. */
  site?: string;
}

export function allowedOrigins(webPort: number): Set<string> {
  return new Set([`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`]);
}

/**
 * Возврат с сервера авторизации MCP — переход по адресу в отдельном окне с
 * чужого домена, то есть заведомо cross-site. Пропускаем именно его: это GET
 * без побочных эффектов, а сам вход защищён параметром state, который
 * сгенерировали мы, — подделать его нельзя. Всё прочее остаётся под запретом.
 */
export function isOAuthCallback(request: GuardedRequest): boolean {
  return request.method === 'GET' && request.url.split('?')[0] === '/api/mcp/oauth/callback';
}

/**
 * Проверок две. Origin ловит обычный кросс-доменный вызов: `fetch` и XHR его
 * присылают всегда. Sec-Fetch-Site нужен там, где Origin не присылают вовсе —
 * `<img>`, форма, переход по адресу: CORS ограничивает лишь чтение ответа, а не
 * саму отправку, и без этой проверки чужая страница дёргала бы GET-маршруты
 * панели ради их побочных действий (обход всех переписок, поход в сеть, запись
 * кэша).
 *
 * Раньше запрос без Origin проходил при любом Sec-Fetch-Site, кроме
 * `cross-site`, — и этого было мало: порт в понятие «site» не входит, поэтому
 * страница с ДРУГОГО порта того же localhost (в том числе dev-сервер, который
 * панель сама и запустила) считается `same-site` и проходила. Теперь без Origin
 * пропускаются только `none` (адрес ввели руками), `same-origin` (свой же
 * интерфейс: браузер не шлёт Origin для GET на свой источник) и запросы вовсе
 * без заголовка — curl и прочие не-браузерные клиенты, на которых держится
 * диагностика; браузер этот заголовок присылает всегда, так что подделать
 * «отсутствие» со страницы нельзя.
 */
export function isRequestAllowed(request: GuardedRequest, allowed: Set<string>): boolean {
  if (isOAuthCallback(request)) return true;

  const { origin, site } = request;
  if (origin !== undefined) return allowed.has(origin) && site !== 'cross-site';

  return site === undefined || site === 'none' || site === 'same-origin';
}
