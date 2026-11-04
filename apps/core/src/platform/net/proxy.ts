import { request as httpRequest } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { LookupFunction, Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { NetErrorCode, ProxyEnv, ProxyRoute } from './net.types.ts';

/**
 * Прокси компании для походов к внешним адресам (перенос `domains/platform/proxy` панели,
 * строка миграции 10:128). Встроенный `fetch` Node `HTTPS_PROXY`/`NO_PROXY` не уважает — ходит
 * напрямую всегда, а внутри компании прямой выход либо закрыт, либо и есть утечка мимо шлюза.
 *
 * Правила, каждое на своей причине:
 * - петля этой машины — всегда напрямую: прокси не знает, что такое чужой `127.0.0.1`;
 * - пустое значение переменной — «прокси нет» (так читает его curl), а не «бери следующую»;
 * - `NO_PROXY` по хосту и суффиксу домена, с портом — только этот порт;
 * - прокси не HTTP (socks, https-прокси) — ОТКАЗ с именем переменной: тихий прямой выход мимо
 *   названного человеком прокси хуже понятного отказа;
 * - пароль прокси в причинах заменён `***`.
 */

const HTTPS_VARS = ['https_proxy', 'HTTPS_PROXY'] as const;
const HTTP_VARS = ['http_proxy', 'HTTP_PROXY'] as const;
const NO_PROXY_VARS = ['no_proxy', 'NO_PROXY'] as const;

/** Потолок установки туннеля: прокси, который молчит, иначе держал бы запрос вечно. */
const TUNNEL_TIMEOUT_MS = 20_000;

export function netError(code: NetErrorCode, message: string): Error & { code: NetErrorCode } {
  return Object.assign(new Error(message), { code });
}

function firstNamed(
  env: ProxyEnv,
  names: readonly string[],
): { value: string; source: string } | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value === undefined) continue;
    return { value, source: name };
  }
  return null;
}

export function hasProxyEnv(env: ProxyEnv): boolean {
  return [...HTTPS_VARS, ...HTTP_VARS].some((name) => Boolean(env[name]?.trim()));
}

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

/**
 * Имя под `.localhost` (`api.localhost` локального стенда в k8s) — петля по RFC 6761 §6.3. Браузер и
 * curl отвечают на него сами, а Node спрашивает ОС, и резолвер Windows такого имени не знает: проба
 * и шлюз видели «адрес недоступен» там, где браузер открывал страницу (живой стенд 03.11).
 */
export function isLocalhostName(hostname: string): boolean {
  return hostname.toLowerCase().replace(/\.$/, '').endsWith('.localhost');
}

/** `lookup` для `node:http`: имя под `.localhost` — сразу 127.0.0.1, без вопроса к ОС. */
export const loopbackLookup: LookupFunction = (_hostname, options, callback) => {
  if (options.all) {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
    return;
  }
  callback(null, '127.0.0.1', 4);
};

function targetPort(target: URL): string {
  if (target.port) return target.port;
  return target.protocol === 'https:' ? '443' : '80';
}

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

function splitHostPort(value: string): [string, string | undefined] {
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(value);
  if (bracketed) return [bracketed[1] ?? '', bracketed[2]];
  const parts = value.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1] ?? '')) return [parts[0] ?? '', parts[1]];
  return [value, undefined];
}

/** Куда идёт запрос на ЭТОТ адрес — решается на каждый адрес, перенаправление тоже. */
export function resolveProxy(target: URL, env: ProxyEnv): ProxyRoute {
  if (isLoopback(target.hostname)) return { kind: 'direct' };
  const named = firstNamed(env, target.protocol === 'https:' ? HTTPS_VARS : HTTP_VARS);
  if (!named || !named.value) return { kind: 'direct' };
  if (noProxyBypasses(target, firstNamed(env, NO_PROXY_VARS)?.value)) return { kind: 'direct' };
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

export function unsupportedProxyError(route: Extract<ProxyRoute, { kind: 'unsupported' }>): Error {
  return netError(
    'proxy-unsupported',
    `${route.source}=${redactProxyValue(route.value)}: only an http:// proxy is supported`,
  );
}

export function redactProxyValue(value: string): string {
  return value.replace(/\/\/([^/@]*):([^/@]*)@/, '//$1:***@');
}

function proxyAuth(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  const user = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

/** Обычный HTTP через прокси: полный адрес в строке запроса, вход прокси — в заголовке. */
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
 * HTTPS через прокси — туннель `CONNECT`, внутри него TLS прямо до цели: прокси видит только
 * хост и порт, тело и ключ — нет. Корень доверия компании проверяет сертификат ЦЕЛИ.
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
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      connect.destroy();
      reject(error);
    };
    connect.on('error', (error: Error) =>
      fail(netError('proxy-unreachable', `proxy ${proxy.host} unreachable: ${error.message}`)),
    );
    connect.on('timeout', () =>
      fail(
        netError(
          'proxy-timeout',
          `proxy ${proxy.host}: no CONNECT answer in ${TUNNEL_TIMEOUT_MS / 1_000} s`,
        ),
      ),
    );
    connect.on('connect', (response, socket: Socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        const status = response.statusCode ?? 0;
        fail(
          status === 407
            ? netError('proxy-login', `proxy ${proxy.host} wants a login (407) for ${authority}`)
            : netError('proxy-refused', `proxy ${proxy.host} refused ${authority}: ${status}`),
        );
        return;
      }
      if (settled) {
        socket.destroy();
        return;
      }
      const secure = tlsConnect({ socket, servername: target.hostname, ...(ca ? { ca } : {}) });
      secure.once('secureConnect', () => {
        settled = true;
        resolve(secure);
      });
      secure.once('error', (error: Error) => {
        secure.destroy();
        fail(error);
      });
    });
    if (signal) {
      const abort = (): void => fail(netError('aborted', 'request aborted'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    connect.end();
  });
}

/** Агент на один готовый сокет туннеля: https-запрос идёт по нему, а не открывает свой. */
export function tunnelAgent(socket: TLSSocket): HttpsAgent {
  class TunnelAgent extends HttpsAgent {
    override createConnection(): TLSSocket {
      return socket;
    }
  }
  return new TunnelAgent({ keepAlive: false, maxSockets: 1 });
}
