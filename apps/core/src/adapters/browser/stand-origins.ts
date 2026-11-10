import type { OriginVerdict, StandOrigins } from './browser.types.ts';
import { RESERVED_PORTS } from '../../platform/ports.ts';
import { readStandEnvironments } from './stand-secrets.ts';

/**
 * Ворота источника прохода (этап 12, W3-D): страница модели — только на стенде проекта (источник
 * `baseUrl` неархивного окружения «Тестов» — тот же набор, к которому привязаны доступы стенда) или
 * на петле (`localhost`, `127.*`, `[::1]` — буквой адреса, без DNS: имя, которое резолвится в
 * петлю, петлёй не считается). Иначе проход вынес бы снимок страницы, адрес с данными или
 * подставленный пароль на любой сайт, который модель назовёт.
 *
 * Сама панель — не стенд никогда, даже на петле и даже записанная окружением: её страница в
 * браузере прохода получает у ядра число страницы и ходит в API панели с её источника, то есть
 * модель кликала бы «ответить», «одобрить» и «показать секрет» как человек.
 *
 * До перехода — только http(s) и `about:blank`; после действия — куда страница пришла
 * (перенаправление, ссылка, скрипт): пустая и страница ошибки Chromium не уводят никуда, прочее —
 * по источнику.
 */

export const ORIGIN_NOT_ALLOWED = 'origin-not-allowed' as const;
/** Порт веба панели по умолчанию — как у сервера панели (`apps/server/src/index.ts`). */
const PANEL_WEB_PORT = 8888;

const WEB = new Set(['http:', 'https:']);
/** Адреса без источника, на которых страница остаться может: пустая, ошибка навигации. */
const INERT = new Set(['about:blank']);
const INERT_PROTOCOLS = new Set(['chrome-error:']);

/** Петля буквой адреса: `localhost`, IPv4 `127.0.0.0/8`, IPv6 `::1`. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]') return true;
  const octets = host.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
  );
}

/** Источники зарегистрированных стендов задачи: `baseUrl` неархивных окружений её корней. */
export function standOriginsOf(roots: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const root of roots) {
    const read = readStandEnvironments(root);
    if (!('value' in read)) continue;
    for (const env of read.value) {
      if (env.archived || !env.baseUrl) continue;
      const origin = webOrigin(env.baseUrl);
      if (origin) out.add(origin);
    }
  }
  return out;
}

function webOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return WEB.has(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

const defaultPort = (protocol: string): number => (protocol === 'https:' ? 443 : 80);

/** Порт панели на петле: её API и шлюз контура (5170–5180) и её веб (`WEB_PORT`, 8888). */
function isPanelPort(port: number, panelWebPort: number): boolean {
  return port === panelWebPort || (port >= RESERVED_PORTS.from && port <= RESERVED_PORTS.to);
}

/** Порт веба панели: та же настройка, что у сервера панели (`WEB_PORT`, по умолчанию 8888). */
export function panelWebPortOf(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.WEB_PORT);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : PANEL_WEB_PORT;
}

function judge(
  roots: readonly string[],
  url: string,
  after: boolean,
  panelWebPort: number,
): OriginVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      code: ORIGIN_NOT_ALLOWED,
      why: `${ORIGIN_NOT_ALLOWED}: ${url} is not a URL`,
    };
  }
  if (INERT.has(parsed.href) || (after && INERT_PROTOCOLS.has(parsed.protocol)))
    return { ok: true };
  // blob: несёт источник страницы, что его создала (`blob:http://стенд/…`): судится по нему.
  const viaBlob = after && parsed.protocol === 'blob:';
  if ((!WEB.has(parsed.protocol) && !viaBlob) || parsed.origin === 'null')
    return {
      ok: false,
      code: ORIGIN_NOT_ALLOWED,
      why: `${ORIGIN_NOT_ALLOWED}: ${parsed.protocol} pages are outside the walk; only http(s) stand pages`,
    };
  const origin = parsed.origin;
  const at = new URL(origin);
  const loopback = isLoopbackHost(at.hostname);
  if (loopback && isPanelPort(Number(at.port || defaultPort(at.protocol)), panelWebPort))
    return {
      ok: false,
      code: ORIGIN_NOT_ALLOWED,
      why: `${ORIGIN_NOT_ALLOWED}: ${origin} is the agentdeck panel itself (its web or API port): a walk acting there would act as the human; only project stands`,
    };
  if (loopback) return { ok: true };
  if (standOriginsOf(roots).has(origin)) return { ok: true };
  return {
    ok: false,
    code: ORIGIN_NOT_ALLOWED,
    why: `${ORIGIN_NOT_ALLOWED}: ${origin} is not a stand of this project (no environment in Tests > Environments has this base URL) and not loopback`,
  };
}

export interface StandOriginsOptions {
  /** Порт веба панели; по умолчанию — `panelWebPortOf(process.env)`. */
  panelWebPort?: number;
}

export function createStandOrigins(options: StandOriginsOptions = {}): StandOrigins {
  const panelWebPort = options.panelWebPort ?? panelWebPortOf();
  return {
    open: (roots, url) => judge(roots, url, false, panelWebPort),
    stay: (roots, url) => judge(roots, url, true, panelWebPort),
  };
}
