import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { invalidField } from './errors.ts';
import {
  hasProxyEnv,
  openTunnel,
  proxyRequestOptions,
  resolveProxy,
  tunnelAgent,
  unsupportedProxyReason,
  type ProxyEnv,
} from './proxy.ts';
import { serverText } from '../../lib/server-texts.ts';

/**
 * Поход в контур с СВОИМ корневым сертификатом компании.
 *
 * Зачем отдельная реализация вместо `fetch`: встроенный `fetch` Node не
 * принимает список доверенных сертификатов — ни параметром, ни опцией. Внутри
 * компании шлюз почти всегда стоит за своим корневым сертификатом, и без этого
 * остаётся ровно два выхода: правка переменной окружения всей машины
 * (`NODE_EXTRA_CA_CERTS`, требует перезапуска и действует на всё) — или
 * выключение проверки сертификата. Второго в этой панели нет и не будет:
 * `rejectUnauthorized` здесь не выставляется ни разу, ни в какую сторону, —
 * доверие только РАСШИРЯЕТСЯ прочитанным файлом.
 *
 * Реализована та часть `fetch`, которой пользуется контур: метод, заголовки,
 * тело строкой, отмена по сигналу. Ответ собирается в настоящий `Response`,
 * поэтому вызывающий не знает, какой транспорт ему достался, а `globalThis.fetch`
 * остаётся законной подстановкой в тестах.
 *
 * Вторая причина своего транспорта появилась в Т2: встроенный `fetch` не
 * уважает `HTTPS_PROXY`/`NO_PROXY` (план §3) — он ходит напрямую всегда. Куда
 * идёт запрос, решает `proxy.ts`, и решает НА КАЖДЫЙ адрес: перенаправление
 * могло увести на хост, для которого правило другое.
 */

/** Та часть `fetch`, которой пользуется контур: `globalThis.fetch` ей соответствует. */
export type PlatformFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

/** Потолок чужого тела: ответ-ошибка бывает страницей на сотни килобайт. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Сколько перенаправлений проходит ПРОБА. Встроенный `fetch` их проходит, и
 * контур, который с корневым сертификатом вдруг перестал бы их проходить,
 * отвечал бы на одну и ту же настройку по-разному — «не то» вместо списка
 * моделей.
 *
 * У ШЛЮЗА их ноль, и это не осторожность, а инвариант: запрос уходит ровно на
 * один адрес — тот, что стоит в настройке контура. `Location` от контура
 * (переехавший ingress, портал перехвата, подмена на пути) увёл бы туда весь
 * промпт, а панель показала бы 200 и путь клиента — то есть согласие, которого
 * никто не давал. Шлюз такой ответ превращает в НАЗВАННЫЙ отказ
 * (`gateway/upstream.ts`).
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
 * Прочитать корневой сертификат — и УБЕДИТЬСЯ, что это он.
 *
 * Проверяется не только читаемость: файл разбирается как сертификат. Иначе
 * подсунутый не тот файл (ключ вместо сертификата, письмо с ним же внутри,
 * пустышка) проходил бы сохранение молча и всплывал бы позже отказом связи — то
 * есть человек шёл бы чинить сеть вместо одного неверного пути. Отказ здесь —
 * ошибка НАСТРОЙКИ, с именем поля.
 */
export function readCaCert(path: string): Buffer {
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw invalidField(
      'caCertPath',
      `корневой сертификат не прочитан: ${reason}`,
      'request-ca-unreadable',
      { field: 'caCertPath', reason },
    );
  }

  try {
    new X509Certificate(content);
  } catch {
    throw invalidField(
      'caCertPath',
      'файл прочитан, но это не сертификат: нужен корневой сертификат компании (PEM или DER)',
      'request-ca-not-certificate',
      { field: 'caCertPath' },
    );
  }
  return content;
}

/**
 * `fetch` поверх `node:https` с добавленным корнем доверия. Пустой путь —
 * возвращаем встроенный `fetch`: своя реализация нужна только там, где без
 * неё не обойтись.
 */
export function createCaFetch(caCertPath: string, env: ProxyEnv = process.env): PlatformFetch {
  return createFetch(caCertPath, false, MAX_REDIRECTS, env);
}

/**
 * То же, но ответ отдаётся ПОТОКОМ, а не собранным телом.
 *
 * Нужно шлюзу: ценность потока в том, что первые токены видны до конца ответа,
 * и собранное тело убивает её целиком. Пробе, наоборот, поток не нужен —
 * она читает список моделей, — поэтому у двух вызывающих два входа, а не
 * общий с флагом на каждом вызове.
 *
 * Второе отличие того же порядка: перенаправления НЕ проходятся вовсе (см.
 * `MAX_REDIRECTS`). Ответ 3xx возвращается вызывающему как есть, и решать, что
 * он значит, — его дело.
 */
export function createCaStreamFetch(
  caCertPath: string,
  env: ProxyEnv = process.env,
): PlatformFetch {
  return createFetch(caCertPath, true, 0, env);
}

function createFetch(
  caCertPath: string,
  stream: boolean,
  redirects: number,
  env: ProxyEnv,
): PlatformFetch {
  const path = caCertPath.trim();
  // Своя реализация нужна ровно там, где без неё не обойтись: свой корень
  // доверия ИЛИ прокси в окружении. Ни того, ни другого — общий путь остаётся
  // встроенным `fetch`, и нашего кода на нём нет. Единственное, что ему
  // приходится сказать явно, — не ходить по перенаправлениям самому.
  if (!path && !hasProxyEnv(env)) {
    return redirects > 0
      ? globalThis.fetch
      : (url, init) => globalThis.fetch(url, { ...init, redirect: 'manual' });
  }
  const ca = path ? readCaCert(path) : undefined;

  /**
   * Пройти перенаправление. Заголовки едут дальше только на ТОТ ЖЕ источник:
   * увести `Authorization` на чужой хост чужим же ответом — способ подарить
   * корпоративный ключ кому угодно, и встроенный `fetch` его тоже не даёт.
   */
  const follow = async (
    url: string,
    init: Parameters<PlatformFetch>[1],
    left: number,
  ): Promise<Response> => {
    const response = await once(url, init);
    const location = response.headers.get('location');
    if (left <= 0 || !location || response.status < 300 || response.status >= 400) return response;

    // Тело перенаправления читать некому: в потоковом режиме оно осталось бы
    // висеть открытым сокетом до конца процесса.
    await response.body?.cancel().catch(() => undefined);
    const next = new URL(location, url);
    const sameOrigin = next.origin === new URL(url).origin;
    // На ЧУЖОЙ источник заголовки не едут вовсе, кроме безобидной пары. Убирать
    // по имени («authorization») здесь нельзя: имя заголовка ключа даёт драйвер,
    // и `x-api-key`, `api-key` или `Authorization` с большой буквы прошли бы
    // мимо такой уборки вместе с корпоративным ключом.
    const headers = sameOrigin ? { ...(init?.headers ?? {}) } : safeHeaders(init?.headers);
    // 303 и «не GET» превращаются в GET без тела — как того требует HTTP и как
    // делает встроенный fetch.
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

  const once = (url: string, init: Parameters<PlatformFetch>[1] = {}): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const target = new URL(url);
      const secure = target.protocol === 'https:';
      const route = resolveProxy(target, env);
      if (route.kind === 'unsupported') {
        // Названный человеком прокси мы не умеем — значит отказ. Пойти напрямую
        // «чтобы работало» здесь и есть тихий выход наружу.
        reject(new Error(unsupportedProxyReason(route)));
        return;
      }

      const onResponse = (response: IncomingMessage): void => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') headers.set(name, value);
          else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        }
        const status = response.statusCode ?? 0;
        // 204 и 304 не имеют тела: `Response` с телом на этих кодах бросает.
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

      /** Общий хвост для всех трёх маршрутов: отмена, тело, отправка. */
      const wire = (outgoing: ClientRequest): void => {
        outgoing.on('error', reject);

        if (init.signal) {
          const signal = init.signal;
          const abort = (): void => {
            outgoing.destroy();
            // Причина сигнала — то, по чему вызывающий отличает «вышло время» от
            // «оборвали»: у `AbortSignal.timeout` это TimeoutError.
            reject(signal.reason ?? new Error(serverText('gateway-request-aborted')));
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        }

        if (init.body) outgoing.write(init.body);
        outgoing.end();
      };

      if (route.kind === 'proxy' && secure) {
        // TLS остаётся сквозным: прокси видит только имя хоста в CONNECT.
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
        // Без TLS прокси получает запрос полным адресом в строке запроса —
        // туннель ему не нужен, и он бы только скрыл от него маршрут.
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

      // Свой корень имеет смысл только для TLS; по http его молча игнорируем,
      // а не отказываем: адрес выбирает человек, и http внутри сети законен.
      const send = secure ? httpsRequest : httpRequest;
      wire(
        send(
          target,
          {
            method: init.method ?? 'GET',
            headers: init.headers,
            // Только РАСШИРЕНИЕ доверия. Проверка сертификата остаётся включённой:
            // её умолчание в Node — строгое, и мы его не трогаем.
            ...(secure && ca ? { ca } : {}),
          },
          onResponse,
        ),
      );
    });

  return (url, init) => follow(url, init, redirects);
}
