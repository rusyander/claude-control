import { request as httpRequest } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';

/**
 * Корпоративный прокси на пути к контуру (`HTTPS_PROXY`/`NO_PROXY`, план §3).
 *
 * Зачем своя реализация. Встроенный `fetch` Node переменные окружения не
 * уважает вовсе: запрос уходит НАПРЯМУЮ, и в сети, где прямого маршрута нет,
 * это выглядит как «контур не отвечает», а в сети, где он есть, — как тихий
 * выход мимо политики компании. Второе хуже: вся партия построена на инварианте
 * «тихого выхода наружу нет».
 *
 * Отсюда три решения, каждое против тихого поведения:
 *
 * 1. Прокси, который мы НЕ умеем (`socks5://`, `https://` до самого прокси),
 *    заканчивается отказом с названной причиной, а не походом напрямую: молча
 *    обойти названный человеком прокси — ровно тот самый тихий выход.
 * 2. Петля (`localhost`, `127.0.0.0/8`, `::1`) идёт мимо прокси всегда. Так же
 *    поступает curl с 7.86, и обратное означало бы, что до нашего же
 *    собственного слушателя ходит посторонний.
 * 3. Для `https` обязателен туннель `CONNECT`: только он оставляет TLS
 *    сквозным. Прокси видит имя хоста и не видит ни ключа, ни тела.
 *
 * Читается ровно то, что названо в плане: `https_proxy`/`HTTPS_PROXY` для TLS,
 * `http_proxy`/`HTTP_PROXY` для http, `no_proxy`/`NO_PROXY` — исключения.
 * Подмены `https` на `http_proxy` нет намеренно (так же строг curl): отправить
 * корпоративный TLS-трафик через прокси, который для него никто не называл, —
 * решение человека, а не догадка панели. Строчная форма выигрывает у прописной:
 * `HTTP_PROXY` в серверном процессе подделывается чужим заголовком `Proxy:`,
 * и по этой причине её первой не читает никто.
 */

const HTTPS_VARS = ['https_proxy', 'HTTPS_PROXY'] as const;
const HTTP_VARS = ['http_proxy', 'HTTP_PROXY'] as const;
const NO_PROXY_VARS = ['no_proxy', 'NO_PROXY'] as const;

/** Окружение процесса — ровно та его часть, которая нас касается. */
export type ProxyEnv = Record<string, string | undefined>;

export type ProxyRoute =
  /** Идём сами: прокси не назван, либо адрес выведен из-под него. */
  | { kind: 'direct' }
  | { kind: 'proxy'; url: URL; source: string }
  /** Прокси назван, но такой мы не умеем. Наверх — отказ, а не прямой поход. */
  | { kind: 'unsupported'; value: string; source: string };

/** Ответ на CONNECT дольше этого — прокси есть, но он не пропускает. */
export const TUNNEL_TIMEOUT_MS = 20_000;

function firstNamed(
  env: ProxyEnv,
  names: readonly string[],
): { value: string; source: string } | null {
  for (const name of names) {
    const value = env[name]?.trim();
    // Пустая переменная — осознанное «без прокси», а не «не задано»: так её и
    // используют в скриптах, выключая унаследованный прокси одной строкой.
    if (value === undefined) continue;
    return value ? { value, source: name } : { value: '', source: name };
  }
  return null;
}

/**
 * Стоит ли вообще заводить свой транспорт. Без прокси в окружении и без своего
 * корня панель остаётся на встроенном `fetch` — меньше нашего кода на общем пути.
 */
export function hasProxyEnv(env: ProxyEnv): boolean {
  return [...HTTPS_VARS, ...HTTP_VARS].some((name) => Boolean(env[name]?.trim()));
}

/** Петлевой адрес: до себя ходим всегда сами. */
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0:0:0:0:0:0:0:1' ||
    /^127\./.test(host)
  );
}

function targetPort(target: URL): string {
  if (target.port) return target.port;
  return target.protocol === 'https:' ? '443' : '80';
}

/**
 * Разбор `NO_PROXY`. Правила общие для curl, Go и Node-библиотек, и переписаны
 * они здесь потому, что различия в мелочах — та самая причина, по которой
 * «у меня работает, у него нет»: `*` целиком, запятая или пробел разделителем,
 * ведущая точка и `*.` равнозначны, порт необязателен, регистр не важен, а
 * совпадение суффикса — только по границе точки (`corp.ru` не покрывает
 * `evilcorp.ru`).
 */
export function noProxyBypasses(target: URL, noProxy: string | undefined): boolean {
  const raw = noProxy?.trim();
  if (!raw) return false;
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = targetPort(target);

  for (const entry of raw.split(/[,\s]+/)) {
    const rule = entry.trim().toLowerCase();
    if (!rule) continue;
    if (rule === '*') return true;

    const [rawHost, rulePort] = splitHostPort(rule);
    if (rulePort && rulePort !== port) continue;
    const host = rawHost.replace(/^\*?\./, '').replace(/^\[|\]$/g, '');
    if (!host) continue;
    if (hostname === host || hostname.endsWith(`.${host}`)) return true;
  }
  return false;
}

/** `host:port`, но так, чтобы IPv6 в скобках не распался по своим двоеточиям. */
function splitHostPort(value: string): [string, string | undefined] {
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(value);
  if (bracketed) return [bracketed[1] ?? '', bracketed[2]];
  const parts = value.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1] ?? '')) return [parts[0] ?? '', parts[1]];
  return [value, undefined];
}

/** Через что идёт ЭТОТ адрес. Решение принимается на каждый запрос: перенаправление могло увести на другой хост. */
export function resolveProxy(target: URL, env: ProxyEnv): ProxyRoute {
  if (isLoopback(target.hostname)) return { kind: 'direct' };

  const named = firstNamed(env, target.protocol === 'https:' ? HTTPS_VARS : HTTP_VARS);
  if (!named || !named.value) return { kind: 'direct' };
  if (noProxyBypasses(target, firstNamed(env, NO_PROXY_VARS)?.value)) return { kind: 'direct' };

  // Адрес без схемы законен и распространён (`proxy.corp.ru:3128`): так его
  // пишут в инструкциях, и curl достраивает `http://` молча.
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(named.value)
    ? named.value
    : `http://${named.value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'unsupported', value: named.value, source: named.source };
  }
  if (url.protocol !== 'http:') {
    return { kind: 'unsupported', value: named.value, source: named.source };
  }
  return { kind: 'proxy', url, source: named.source };
}

/** Почему отказали. Значение переменной показывается как есть — пароль из него вырезан. */
export function unsupportedProxyReason(
  route: Extract<ProxyRoute, { kind: 'unsupported' }>,
): string {
  return `Прокси из ${route.source} (${redactProxyValue(route.value)}) панель не умеет: нужен обычный http-прокси. Напрямую в обход названного прокси панель не пойдёт`;
}

/** Пароль из `http://user:pass@host` не должен попасть ни в сообщение, ни в след. */
export function redactProxyValue(value: string): string {
  return value.replace(/\/\/([^/@]*):([^/@]*)@/, '//$1:***@');
}

function proxyAuth(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  const user = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

/** Заголовки к прокси для НЕ-TLS запроса: он идёт полным адресом в строке запроса. */
export function proxyRequestOptions(
  proxy: URL,
  target: URL,
  headers: Record<string, string> | undefined,
): { host: string; port: number; path: string; headers: Record<string, string> } {
  const auth = proxyAuth(proxy);
  return {
    host: proxy.hostname,
    port: Number(proxy.port || 80),
    path: target.toString(),
    headers: {
      ...(headers ?? {}),
      host: target.host,
      ...(auth ? { 'proxy-authorization': auth } : {}),
    },
  };
}

/**
 * Туннель `CONNECT` до контура и TLS поверх него.
 *
 * Здесь же — грабли, на которых это чинилось: `https.request` с
 * `agent:false` и `createConnection` СВОЙ сокет игнорирует и открывает
 * соединение сам, то есть запрос уходит мимо прокси, а человек видит ошибку
 * сертификата вместо честного «прокси не пустил». Единственный способ отдать
 * готовый сокет — свой агент (`tunnelAgent`), и проверено это живым прогоном
 * через настоящий прокси, а не чтением документации.
 */
export function openTunnel(options: {
  proxy: URL;
  target: URL;
  ca?: Buffer;
  signal?: AbortSignal;
}): Promise<TLSSocket> {
  const { proxy, target, ca, signal } = options;
  const authority = `${target.hostname}:${targetPort(target)}`;
  const auth = proxyAuth(proxy);

  return new Promise<TLSSocket>((resolve, reject) => {
    const connect = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority, ...(auth ? { 'proxy-authorization': auth } : {}) },
      timeout: TUNNEL_TIMEOUT_MS,
    });

    let settled = false;
    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      connect.destroy();
      reject(new Error(reason));
    };

    connect.on('error', (error: Error) =>
      fail(`прокси ${proxy.host} недоступен: ${error.message}`),
    );
    connect.on('timeout', () =>
      fail(`прокси ${proxy.host} не ответил на CONNECT за ${TUNNEL_TIMEOUT_MS / 1_000} с`),
    );
    connect.on('connect', (response, socket: Socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        // Тело ответа прокси наверх не несём: там бывает и страница входа
        // целиком, и присланный нами же заголовок.
        fail(
          `прокси ${proxy.host} не пропустил CONNECT к ${authority}: ${response.statusCode ?? 0}${
            response.statusCode === 407 ? ' (нужен логин к прокси)' : ''
          }`,
        );
        return;
      }
      if (settled) {
        socket.destroy();
        return;
      }
      // Дальше TLS сквозной: проверка сертификата контура остаётся нашей и
      // включённой, прокси в неё не вмешивается.
      const secure = tlsConnect({ socket, servername: target.hostname, ...(ca ? { ca } : {}) });
      secure.once('secureConnect', () => {
        settled = true;
        resolve(secure);
      });
      secure.once('error', (error: Error) => {
        secure.destroy();
        fail(error.message);
      });
    });

    if (signal) {
      const abort = (): void => {
        fail(signal.reason instanceof Error ? signal.reason.message : 'запрос отменён');
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    connect.end();
  });
}

/**
 * Агент на один запрос, отдающий уже открытый сокет туннеля. Ровно это и есть
 * единственный работающий способ (см. `openTunnel`): всё остальное в Node
 * открывает соединение заново и мимо прокси.
 */
export function tunnelAgent(socket: TLSSocket): HttpsAgent {
  class TunnelAgent extends HttpsAgent {
    override createConnection(): TLSSocket {
      return socket;
    }
  }
  return new TunnelAgent({ keepAlive: false, maxSockets: 1 });
}
