import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { NetFetch, ProxyEnv } from './net.types.ts';
import {
  hasProxyEnv,
  isLocalhostName,
  loopbackLookup,
  netError,
  openTunnel,
  proxyRequestOptions,
  resolveProxy,
  tunnelAgent,
  unsupportedProxyError,
} from './proxy.ts';

/**
 * Поход к внешнему адресу со СВОИМ корнем доверия компании и прокси из окружения (перенос
 * `domains/platform/ca-fetch` панели, строка миграции 10:128). Встроенный `fetch` Node не берёт
 * ни списка доверенных сертификатов, ни `HTTPS_PROXY` — а внутри компании шлюз стоит за своим
 * корнем, и прямой выход закрыт. Проверка сертификата не выключается нигде: доверие только
 * РАСШИРЯЕТСЯ прочитанным файлом.
 *
 * Ответ — настоящий `Response`: вызывающий не знает, какой транспорт ему достался, и в тестах
 * законно подставить `globalThis.fetch`.
 */

/** Потолок чужого тела: ответ-ошибка бывает страницей на сотни килобайт. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Перенаправления пробы. У потока шлюза их ноль — инвариант: запрос уходит ровно на адрес из
 * настройки контура, `Location` увёл бы туда весь промпт без согласия.
 */
const MAX_REDIRECTS = 5;

/** Заголовки, которые можно нести на чужой источник: секрета в них нет. */
const SAFE_ON_HOP = ['accept', 'content-type'];

function safeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (SAFE_ON_HOP.includes(name.toLowerCase())) kept[name] = value;
  }
  return kept;
}

/**
 * Прочитать корневой сертификат и УБЕДИТЬСЯ, что это он: не тот файл (ключ, пустышка) иначе
 * всплыл бы позже отказом связи, и человек чинил бы сеть вместо одного неверного пути.
 */
export function readCaCert(path: string): Buffer {
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw netError('ca-unreadable', `company CA not read: ${reason}`);
  }
  try {
    new X509Certificate(content);
  } catch {
    throw netError('ca-not-certificate', 'file read, but it is not a certificate (PEM or DER)');
  }
  return content;
}

/** Собранное тело, до 5 перенаправлений (заголовки — только на тот же источник). */
export function createCaFetch(caCertPath: string, env: ProxyEnv = process.env): NetFetch {
  return createFetch(caCertPath, false, MAX_REDIRECTS, env);
}

/** Поток (первые токены видны до конца ответа), перенаправлений нет: 3xx отдаётся как есть. */
export function createCaStreamFetch(caCertPath: string, env: ProxyEnv = process.env): NetFetch {
  return createFetch(caCertPath, true, 0, env);
}

function createFetch(
  caCertPath: string,
  stream: boolean,
  redirects: number,
  env: ProxyEnv,
  ownTransport = false,
): NetFetch {
  const path = caCertPath.trim();
  // Ни своего корня, ни прокси — встроенный `fetch`; свой путь только для имён под `.localhost`:
  // встроенный спрашивает о них ОС, а резолвер Windows их не знает.
  if (!ownTransport && !path && !hasProxyEnv(env)) {
    const own = createFetch('', stream, redirects, env, true);
    return (url, init) => {
      if (isLocalhostName(new URL(url).hostname)) return own(url, init);
      return redirects > 0
        ? globalThis.fetch(url, init)
        : globalThis.fetch(url, { ...init, redirect: 'manual' });
    };
  }
  const ca = path ? readCaCert(path) : undefined;

  const follow = async (
    url: string,
    init: Parameters<NetFetch>[1],
    left: number,
  ): Promise<Response> => {
    const response = await once(url, init);
    const location = response.headers.get('location');
    if (left <= 0 || !location || response.status < 300 || response.status >= 400) return response;
    // Тело перенаправления читать некому: в потоке оно висело бы открытым сокетом.
    await response.body?.cancel().catch(() => undefined);
    const next = new URL(location, url);
    const sameOrigin = next.origin === new URL(url).origin;
    // На чужой источник — только безобидная пара: имя заголовка ключа задаёт драйвер, и уборка
    // по имени пропустила бы `x-api-key` вместе с ключом компании.
    const headers = sameOrigin ? { ...(init?.headers ?? {}) } : safeHeaders(init?.headers);
    const keepBody = response.status === 307 || response.status === 308;
    return follow(
      next.toString(),
      {
        ...init,
        headers,
        method: keepBody ? init?.method : 'GET',
        body: keepBody ? init?.body : undefined,
      },
      left - 1,
    );
  };

  const once = (url: string, init: Parameters<NetFetch>[1] = {}): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const target = new URL(url);
      const secure = target.protocol === 'https:';
      const route = resolveProxy(target, env);
      if (route.kind === 'unsupported') {
        // Названный человеком прокси не умеем — отказ; прямой выход здесь и есть утечка.
        reject(unsupportedProxyError(route));
        return;
      }
      const onResponse = (response: IncomingMessage): void => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') headers.set(name, value);
          else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        }
        const status = response.statusCode ?? 0;
        // 204 и 304 без тела: `Response` с телом на этих кодах бросает.
        const empty = status === 204 || status === 304;
        if (stream) {
          const body = empty
            ? null
            : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>);
          resolve(new Response(body, { status, statusText: response.statusMessage, headers }));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_BODY_BYTES) chunks.push(chunk);
        });
        response.on('end', () => {
          resolve(
            new Response(empty ? null : Buffer.concat(chunks), {
              status,
              statusText: response.statusMessage,
              headers,
            }),
          );
        });
        response.on('error', reject);
      };
      const wire = (outgoing: ClientRequest): void => {
        outgoing.on('error', reject);
        if (init.signal) {
          const signal = init.signal;
          const abort = (): void => {
            outgoing.destroy();
            reject(netError('aborted', 'request aborted'));
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        }
        if (init.body) outgoing.write(init.body);
        outgoing.end();
      };
      if (route.kind === 'proxy' && secure) {
        openTunnel({
          proxy: route.url,
          target,
          ...(ca ? { ca } : {}),
          ...(init.signal ? { signal: init.signal } : {}),
        })
          .then((socket) =>
            wire(
              httpsRequest(
                {
                  host: target.hostname,
                  port: Number(target.port || 443),
                  path: `${target.pathname}${target.search}`,
                  method: init.method ?? 'GET',
                  headers: init.headers,
                  agent: tunnelAgent(socket),
                },
                onResponse,
              ),
            ),
          )
          .catch(reject);
        return;
      }
      if (route.kind === 'proxy') {
        wire(
          httpRequest(
            {
              ...proxyRequestOptions(route.url, target, init.headers),
              method: init.method ?? 'GET',
            },
            onResponse,
          ),
        );
        return;
      }
      const send = secure ? httpsRequest : httpRequest;
      wire(
        send(
          target,
          {
            method: init.method ?? 'GET',
            headers: init.headers,
            ...(secure && ca ? { ca } : {}),
            ...(isLocalhostName(target.hostname) ? { lookup: loopbackLookup } : {}),
          },
          onResponse,
        ),
      );
    });

  return (url, init) => follow(url, init, redirects);
}
