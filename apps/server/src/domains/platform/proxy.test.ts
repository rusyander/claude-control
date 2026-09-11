import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  hasProxyEnv,
  noProxyBypasses,
  redactProxyValue,
  resolveProxy,
  tunnelAgent,
  unsupportedProxyReason,
  type ProxyEnv,
} from './proxy.ts';
import { createCaFetch } from './ca-fetch.ts';

/**
 * Прокси на пути к контуру. Проверяется не только «умеем ходить через прокси»,
 * но и обратное свойство, ради которого всё и написано: панель НЕ уходит мимо
 * названного прокси молча — ни при неподдержанной схеме, ни при отказе.
 *
 * Табличная часть — чистая функция выбора маршрута; живая — настоящий локальный
 * прокси, а не заглушка: разница между «сформировали строку запроса» и «прокси
 * её принял» и есть то место, где ошибаются.
 */

const route = (url: string, env: ProxyEnv): ReturnType<typeof resolveProxy> =>
  resolveProxy(new URL(url), env);

describe('выбор маршрута', () => {
  it('без прокси в окружении — напрямую', () => {
    expect(hasProxyEnv({})).toBe(false);
    expect(hasProxyEnv({ HTTPS_PROXY: '   ' })).toBe(false);
    expect(hasProxyEnv({ HTTPS_PROXY: 'http://p:3128' })).toBe(true);
    expect(route('https://api.corp.ru/v1', {})).toEqual({ kind: 'direct' });
  });

  it('строчная переменная выигрывает у прописной', () => {
    const chosen = route('https://api.corp.ru/v1', {
      https_proxy: 'http://lower:3128',
      HTTPS_PROXY: 'http://upper:3128',
    });
    expect(chosen).toMatchObject({ kind: 'proxy', source: 'https_proxy' });
    expect(chosen.kind === 'proxy' && chosen.url.host).toBe('lower:3128');
  });

  it('пустое значение — осознанное «без прокси», а не «не задано»', () => {
    expect(
      route('https://api.corp.ru/v1', { https_proxy: '', HTTPS_PROXY: 'http://p:3128' }),
    ).toEqual({ kind: 'direct' });
  });

  it('подмены схемы нет: https не берёт http_proxy и наоборот', () => {
    expect(route('https://api.corp.ru/v1', { http_proxy: 'http://p:3128' })).toEqual({
      kind: 'direct',
    });
    expect(route('http://api.corp.ru/v1', { https_proxy: 'http://p:3128' })).toEqual({
      kind: 'direct',
    });
  });

  it('адрес без схемы достраивается до http', () => {
    const chosen = route('https://api.corp.ru/v1', { https_proxy: 'proxy.corp.ru:3128' });
    expect(chosen.kind === 'proxy' && chosen.url.href).toBe('http://proxy.corp.ru:3128/');
  });

  it('до петли ходим сами, даже когда прокси назван', () => {
    const env = { https_proxy: 'http://p:3128', http_proxy: 'http://p:3128' };
    for (const url of [
      'http://127.0.0.1:5178/api',
      'http://127.9.9.9/api',
      'http://localhost:8888/',
      'https://panel.localhost/',
      'http://[::1]:5178/',
    ]) {
      expect(route(url, env), url).toEqual({ kind: 'direct' });
    }
  });

  it('чего не умеем — называем, а не обходим', () => {
    const socks = route('https://api.corp.ru/v1', { https_proxy: 'socks5://127.0.0.1:1080' });
    expect(socks).toMatchObject({ kind: 'unsupported', source: 'https_proxy' });
    // TLS до самого прокси — тоже не наш случай: молча пойти напрямую значило бы
    // отправить корпоративный трафик мимо политики компании.
    expect(route('https://api.corp.ru/v1', { https_proxy: 'https://p:3128' })).toMatchObject({
      kind: 'unsupported',
    });
    expect(route('https://api.corp.ru/v1', { https_proxy: 'http://:::' })).toMatchObject({
      kind: 'unsupported',
    });

    expect(
      unsupportedProxyReason({
        kind: 'unsupported',
        value: 'socks5://user:secret@127.0.0.1:1080',
        source: 'https_proxy',
      }),
    ).toContain('https_proxy');
    // Пароль прокси — такой же секрет, как ключ контура.
    expect(redactProxyValue('socks5://user:secret@127.0.0.1:1080')).toBe(
      'socks5://user:***@127.0.0.1:1080',
    );
  });
});

describe('NO_PROXY', () => {
  const bypass = (url: string, rules: string): boolean => noProxyBypasses(new URL(url), rules);

  it('звёздочка выводит из-под прокси всё', () => {
    expect(bypass('https://api.corp.ru/v1', '*')).toBe(true);
  });

  it('совпадение суффикса — только по границе точки', () => {
    expect(bypass('https://api.corp.ru/v1', 'corp.ru')).toBe(true);
    expect(bypass('https://corp.ru/v1', 'corp.ru')).toBe(true);
    // Иначе `corp.ru` вывел бы из-под прокси чужой `evilcorp.ru`.
    expect(bypass('https://evilcorp.ru/v1', 'corp.ru')).toBe(false);
  });

  it('ведущая точка, звёздочка и регистр равнозначны', () => {
    expect(bypass('https://API.Corp.ru/v1', '.corp.ru')).toBe(true);
    expect(bypass('https://api.corp.ru/v1', '*.CORP.RU')).toBe(true);
  });

  it('разделителем может быть запятая или пробел', () => {
    expect(bypass('https://api.corp.ru/v1', 'example.com, api.corp.ru')).toBe(true);
    expect(bypass('https://api.corp.ru/v1', 'example.com api.corp.ru')).toBe(true);
    expect(bypass('https://api.corp.ru/v1', 'example.com')).toBe(false);
  });

  it('порт в правиле сужает его, а не расширяет', () => {
    expect(bypass('https://api.corp.ru/v1', 'api.corp.ru:443')).toBe(true);
    expect(bypass('https://api.corp.ru:8443/v1', 'api.corp.ru:443')).toBe(false);
    expect(bypass('http://api.corp.ru/v1', 'api.corp.ru:80')).toBe(true);
  });

  it('пустое правило не выводит никого', () => {
    expect(bypass('https://api.corp.ru/v1', '')).toBe(false);
    expect(bypass('https://api.corp.ru/v1', '  ,  ')).toBe(false);
  });

  it('правило участвует в выборе маршрута, а не только само по себе', () => {
    expect(
      route('https://api.corp.ru/v1', { https_proxy: 'http://p:3128', no_proxy: '.corp.ru' }),
    ).toEqual({ kind: 'direct' });
  });
});

describe('живой прокси', () => {
  let proxy: Server;
  let target: Server;
  let proxyPort = 0;
  let targetPort = 0;
  let seen: { url: string; headers: IncomingMessage['headers'] }[] = [];
  let connects: { path: string; headers: IncomingMessage['headers'] }[] = [];
  /** Чем прокси отвечает на CONNECT: код меняется по ходу теста. */
  let connectStatus = 200;

  beforeAll(async () => {
    proxy = createServer((request, response) => {
      seen.push({ url: request.url ?? '', headers: request.headers });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ via: 'proxy' }));
    });
    proxy.on('connect', (request: IncomingMessage, socket: Socket) => {
      connects.push({ path: request.url ?? '', headers: request.headers });
      socket.write(`HTTP/1.1 ${connectStatus} nope\r\n\r\n`);
      socket.destroy();
    });
    target = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ via: 'target' }));
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    proxyPort = (proxy.address() as AddressInfo).port;
    targetPort = (target.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  const reset = (): void => {
    seen = [];
    connects = [];
    connectStatus = 200;
  };

  it('http идёт полным адресом в строке запроса и с логином к прокси', async () => {
    reset();
    const fetchImpl = createCaFetch('', { http_proxy: `http://user:pa ss@127.0.0.1:${proxyPort}` });
    const response = await fetchImpl('http://contour.corp.test/v1/models', {
      headers: { authorization: 'Bearer key' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ via: 'proxy' });
    expect(seen).toHaveLength(1);
    // Прокси-форма запроса: полный адрес, а не путь.
    expect(seen[0]?.url).toBe('http://contour.corp.test/v1/models');
    expect(seen[0]?.headers.host).toBe('contour.corp.test');
    // Пробел в пароле — законный: значение из переменной раскодируется.
    expect(seen[0]?.headers['proxy-authorization']).toBe(
      `Basic ${Buffer.from('user:pa ss').toString('base64')}`,
    );
    // Ключ контура едет контуру, а прокси — только своё.
    expect(seen[0]?.headers.authorization).toBe('Bearer key');
  });

  it('https идёт туннелем: прокси видит имя хоста и больше ничего', async () => {
    reset();
    connectStatus = 403;
    const fetchImpl = createCaFetch('', { https_proxy: `http://127.0.0.1:${proxyPort}` });

    await expect(fetchImpl('https://contour.corp.test/v1/models')).rejects.toThrow(/403/);
    expect(connects).toHaveLength(1);
    expect(connects[0]?.path).toBe('contour.corp.test:443');
    // Ни тела, ни заголовка с ключом в CONNECT нет — только адрес.
    expect(connects[0]?.headers.authorization).toBeUndefined();
    // Обычным запросом до прокси при этом не ходили.
    expect(seen).toHaveLength(0);
  });

  it('407 назван логином, а не «прокси не пропустил»', async () => {
    reset();
    connectStatus = 407;
    const fetchImpl = createCaFetch('', { https_proxy: `http://127.0.0.1:${proxyPort}` });
    await expect(fetchImpl('https://contour.corp.test/v1/models')).rejects.toThrow(
      /нужен логин к прокси/,
    );
  });

  it('неподдержанный прокси — отказ, и НИ ОДИН байт не ушёл в обход', async () => {
    reset();
    const fetchImpl = createCaFetch('', { https_proxy: `socks5://127.0.0.1:${proxyPort}` });

    await expect(fetchImpl('https://contour.corp.test/v1/models')).rejects.toThrow(
      /панель не умеет/,
    );
    expect(seen).toHaveLength(0);
    expect(connects).toHaveLength(0);
  });

  it('до петли ходим сами, даже когда прокси назван', async () => {
    reset();
    const fetchImpl = createCaFetch('', { http_proxy: `http://127.0.0.1:${proxyPort}` });
    const response = await fetchImpl(`http://127.0.0.1:${targetPort}/v1/models`);

    await expect(response.json()).resolves.toEqual({ via: 'target' });
    expect(seen).toHaveLength(0);
  });

  it('без прокси и без своего корня транспорт остаётся встроенным', () => {
    expect(createCaFetch('', {})).toBe(globalThis.fetch);
    expect(createCaFetch('', { https_proxy: 'http://p:3128' })).not.toBe(globalThis.fetch);
  });
});

describe('агент туннеля', () => {
  it('отдаёт готовый сокет, а не открывает свой', () => {
    // Ровно это и есть та грабля: `https.request` с `agent:false` и
    // `createConnection` открывает соединение сам — мимо прокси.
    const socket = { fake: true } as unknown as Parameters<typeof tunnelAgent>[0];
    const agent = tunnelAgent(socket);
    const opened = (agent as unknown as { createConnection: () => unknown }).createConnection();
    expect(opened).toBe(socket);
    expect(agent.options.keepAlive).toBe(false);
  });
});
