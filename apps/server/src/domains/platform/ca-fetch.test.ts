import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createCaFetch, createCaStreamFetch, readCaCert } from './ca-fetch.ts';

/**
 * Транспорт с корневым сертификатом компании — против НАСТОЯЩЕГО сервера.
 *
 * Здесь заглушек нет намеренно: это единственный модуль партии, который сам
 * говорит по HTTP, и подменять в нём сеть значит не проверить ровно то, ради
 * чего он написан. Поднимается локальный `node:http`, и через него проверяется,
 * что своя реализация ведёт себя как `fetch` там, где вызывающий на это
 * рассчитывает: код, заголовки, тело, коды без тела, отмена по сигналу.
 *
 * TLS здесь не поднимается: проверять чужой корень доверия можно только с
 * настоящим сертификатом на настоящее имя, а это уже стенд, а не тест. Что
 * проверено на живом контуре, а что нет, сказано в `probe.ts` и в подписи
 * `probe-guess`.
 */

let server: Server;
let base: string;
let dir: string;
let pem: string;
/** Что сервер увидел последним запросом — так проверяется исходящая сторона. */
let seen: { method: string; url: string; auth: string; body: string };
/** Второй адрес: перенаправление НА ЧУЖОЙ хост — отдельный случай для ключа. */
let other: Server;
let otherBase: string;
let seenOther: { url: string; auth: string; headers: Record<string, string> };

beforeAll(async () => {
  other = createServer((request, response) => {
    seenOther = {
      url: request.url ?? '',
      auth: String(request.headers.authorization ?? ''),
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [name, String(value ?? '')]),
      ),
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;

  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen = {
        method: request.method ?? '',
        url: request.url ?? '',
        auth: String(request.headers.authorization ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      };

      if (request.url === '/slow') return; // ответа не будет: проверка отмены
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/v1/models' });
        response.end();
        return;
      }
      if (request.url === '/redirect-away') {
        response.writeHead(302, { location: `${otherBase}/v1/models` });
        response.end();
        return;
      }
      if (request.url === '/loop') {
        response.writeHead(302, { location: '/loop' });
        response.end();
        return;
      }
      if (request.url === '/empty') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.url === '/huge') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('x'.repeat(1_500_000));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'X-Echo': 'yes' });
      response.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const listener of [server, other]) {
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-ca-'));
  pem = join(dir, 'corp-root.pem');
  // НАСТОЯЩИЙ самоподписанный сертификат (открытая часть; закрытого ключа к
  // нему нет ни у кого): панель разбирает файл, а не верит расширению, поэтому
  // и в тесте лежит сертификат, а не строка, похожая на него.
  writeFileSync(pem, readFileSync(join(import.meta.dirname, '__fixtures__', 'corp-root.pem')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readCaCert: нечитаемый файл — ошибка НАСТРОЙКИ, а не связи', () => {
  it('несуществующий путь назван полем, а не «нет связи»', () => {
    expect(() => readCaCert(join(dir, 'нет-такого.pem'))).toThrow(
      expect.objectContaining({ code: 'invalid_body', detail: 'caCertPath' }),
    );
  });

  it('причина системы попадает в текст: человеку видно, что именно не так', () => {
    expect(() => readCaCert(join(dir, 'нет-такого.pem'))).toThrow(/ENOENT|no such file/i);
  });

  it('читаемый файл возвращается содержимым', () => {
    expect(readCaCert(pem).toString('utf8')).toContain('BEGIN CERTIFICATE');
  });

  it('файл прочитан, но это не сертификат — отказ там же, а не отказом связи потом', () => {
    // Самая частая подмена: указали закрытый ключ, письмо с сертификатом внутри
    // или пустой файл. Молча принять такой файл значит отправить человека
    // чинить сеть на первой же проверке связи.
    const notACert = join(dir, 'не-сертификат.pem');
    writeFileSync(notACert, '-----BEGIN CERTIFICATE-----\nтекст\n-----END CERTIFICATE-----\n');

    expect(() => readCaCert(notACert)).toThrow(/не сертификат/);
  });
});

describe('createCaFetch: своя реализация нужна только там, где без неё нельзя', () => {
  it('без сертификата отдаётся встроенный fetch — второй транспорт не заводится', () => {
    expect(createCaFetch('')).toBe(globalThis.fetch);
    expect(createCaFetch('   ')).toBe(globalThis.fetch);
  });

  it('нечитаемый сертификат ломается СРАЗУ при создании, до первого запроса', () => {
    expect(() => createCaFetch(join(dir, 'нет-такого.pem'))).toThrow(
      expect.objectContaining({ detail: 'caCertPath' }),
    );
  });
});

describe('createCaFetch: ведёт себя как fetch против настоящего сервера', () => {
  it('код, заголовки и тело ответа собираются в обычный Response', async () => {
    const response = await createCaFetch(pem)(`${base}/v1/models`, {
      headers: { authorization: 'Bearer sk-live' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    // Регистр имени заголовка не должен иметь значения — как у настоящего fetch.
    expect(response.headers.get('x-echo')).toBe('yes');
    expect(((await response.json()) as { data: unknown[] }).data).toHaveLength(1);
    expect(seen.method).toBe('GET');
    expect(seen.url).toBe('/v1/models');
    expect(seen.auth).toBe('Bearer sk-live');
  });

  it('метод и тело уходят как есть — на них потом поедет чат', async () => {
    await createCaFetch(pem)(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });

    expect(seen.method).toBe('POST');
    expect(seen.body).toBe('{"stream":true}');
  });

  it('204 не имеет тела — и не роняет сборку Response', async () => {
    const response = await createCaFetch(pem)(`${base}/empty`);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('чужое тело обрезано по потолку: страница ошибки не съест память панели', async () => {
    const response = await createCaFetch(pem)(`${base}/huge`);

    expect((await response.text()).length).toBeLessThanOrEqual(1_000_000);
  });

  it('отмена по сигналу отдаёт ПРИЧИНУ сигнала: проба отличит «вышло время»', async () => {
    const failure = await createCaFetch(pem)(`${base}/slow`, {
      signal: AbortSignal.timeout(50),
    }).catch((error: unknown) => error);

    expect((failure as Error).name).toBe('TimeoutError');
  });

  it('уже отменённый сигнал не доходит до ответа сервера', async () => {
    const failure = await createCaFetch(pem)(`${base}/v1/models`, {
      signal: AbortSignal.abort(new Error('передумали')),
    }).catch((error: unknown) => error);

    expect((failure as Error).message).toBe('передумали');
  });

  it('перенаправление проходится: с сертификатом и без него контур ведёт себя одинаково', async () => {
    // Иначе одна и та же настройка отвечала бы по-разному в зависимости от
    // заполненного поля сертификата — и человек чинил бы не то.
    const withCa = await createCaFetch(pem)(`${base}/redirect`, {
      headers: { authorization: 'Bearer sk-live' },
    });
    expect(withCa.status).toBe(200);
    expect(((await withCa.json()) as { data: unknown[] }).data).toHaveLength(1);
    // На свой же адрес заголовки едут дальше — иначе шлюз ответил бы 401.
    expect(seen.auth).toBe('Bearer sk-live');
    expect(seen.url).toBe('/v1/models');

    const builtin = await globalThis.fetch(`${base}/redirect`);
    expect(builtin.status).toBe(200);
    expect(seen.url).toBe('/v1/models');
  });

  it('перенаправление на ЧУЖОЙ хост уносит адрес, но НИ ОДНОГО заголовка', async () => {
    const response = await createCaFetch(pem)(`${base}/redirect-away`, {
      headers: {
        authorization: 'Bearer sk-live',
        // Имя заголовка ключа даёт драйвер, и оно бывает любым: уборка по
        // одному известному имени пропустила бы вот эти два вместе с ключом.
        'x-api-key': 'sk-anthropic-shaped',
        'api-key': 'azure-shaped',
        accept: 'text/event-stream',
      },
    });

    expect(response.status).toBe(200);
    expect(seenOther.url).toBe('/v1/models');
    // Корпоративный ключ на чужом хосте — способ подарить его кому угодно
    // чужим же ответом. Встроенный fetch его тоже не отдаёт.
    expect(seenOther.auth).toBe('');
    expect(seenOther.headers['x-api-key']).toBeUndefined();
    expect(seenOther.headers['api-key']).toBeUndefined();
    // Безобидная пара едет: без неё чужой адрес ответил бы не тем.
    expect(seenOther.headers.accept).toBe('text/event-stream');
  });

  it('шлюзу перенаправление не проходится ВООБЩЕ — ни своим транспортом, ни встроенным', async () => {
    // Ответ 3xx возвращается как есть, и шлюз превращает его в названный отказ.
    // Пойти по `Location` значило бы отправить весь промпт на адрес, которого
    // человек в настройке контура не писал, и показать ему при этом 200.
    const mine = await createCaStreamFetch(pem)(`${base}/redirect-away`, {
      headers: { authorization: 'Bearer sk-live' },
    });
    expect(mine.status).toBe(302);
    expect(mine.headers.get('location')).toBe(`${otherBase}/v1/models`);

    // Без своего корня и без прокси шлюз берёт встроенный `fetch` — и ему
    // приходится сказать про перенаправления отдельно.
    seenOther = { url: '', auth: '', headers: {} };
    const builtin = await createCaStreamFetch('')(`${base}/redirect-away`);
    expect(builtin.status).toBe(302);
    expect(seenOther.url).toBe('');
  });

  it('кольцо перенаправлений кончается ответом, а не зависанием', async () => {
    const response = await createCaFetch(pem)(`${base}/loop`);

    expect(response.status).toBe(302);
  });

  it('по http свой корень молча не применяется: адрес выбирает человек', async () => {
    // Внутри сети http законен. Отказывать в нём из-за настроенного
    // сертификата значило бы запрещать рабочую настройку из-за лишнего поля.
    const response = await createCaFetch(pem)(`${base}/v1/models`);

    expect(response.status).toBe(200);
  });

  it('мёртвый адрес — отказ обещания, а не зависание', async () => {
    const failure = await createCaFetch(pem)('http://127.0.0.1:1/v1/models').catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as NodeJS.ErrnoException).code).toMatch(/ECONNREFUSED|EADDRNOTAVAIL|EACCES/);
  });
});

/**
 * Сторож, а не проверка поведения: выключенная проверка сертификата — это
 * дыра, которую вставляют «на пять минут, чтобы заработало», и которая потом
 * живёт годами.
 *
 * Обход идёт по ВСЕМУ серверу, а не по домену контура: `NODE_TLS_REJECT_UNAUTHORIZED`
 * выключается одной строкой в загрузчике, а свой агент `undici` собирается в
 * `lib/`, и сторож, смотрящий в одну папку, не увидел бы ни того, ни другого —
 * зато утверждал бы, что смотрел.
 */
describe('инвариант: проверка сертификата не выключается нигде на сервере', () => {
  it('ни в одном файле нет присваивания rejectUnauthorized', () => {
    const offenders: string[] = [];

    const walk = (path: string): void => {
      for (const name of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, name.name);
        if (name.isDirectory()) walk(full);
        // Сами тесты пропускаем: этот файл поминает поле по имени.
        else if (name.name.endsWith('.ts') && !name.name.endsWith('.test.ts')) {
          // Комментарии вырезаются: слово в объяснении, почему выключения нет,
          // не должно ронять сборку.
          const code = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
          if (/rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED/.test(code)) offenders.push(full);
        }
      }
    };
    walk(resolve(import.meta.dirname, '../../'));

    expect(offenders).toEqual([]);
  });
});

/**
 * §8 №25: ушедшие часы машины на работу с контуром не влияют — и держится это
 * ровно одним свойством, которое легко потерять: ключ контура НЕ подписывается
 * временем. JWT со своим `exp`/`nbf` сделал бы расхождение часов отказом
 * авторизации, который человек читает как «ключ не тот». Ключ уходит
 * заголовком как есть (`drivers/*.ts`), и сверять время в нём нечему.
 *
 * Сторож по исходникам, а не по поведению: подпись временем появляется в коде
 * одной строкой, и заметить её потом можно только по такому же обходу. Обход —
 * по всему серверу: подписать запрос можно и в `routes/`, и в `lib/`, а сторож
 * над одной папкой доказывал бы только про эту папку.
 */
describe('инвариант: ключ контура не подписывается временем', () => {
  it('на сервере нет ни выпуска, ни разбора JWT — часы на доступ не влияют', () => {
    const offenders: string[] = [];

    const walk = (path: string): void => {
      for (const name of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, name.name);
        if (name.isDirectory()) walk(full);
        else if (name.name.endsWith('.ts') && !name.name.endsWith('.test.ts')) {
          const code = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
          // Именно подпись и разбор, а не слово «jwt» в имени переменной:
          // чужой JWT, ПОЛУЧЕННЫЙ от системы (так живёт Xray), — не наша
          // подпись временем и часов панели не касается.
          if (/jsonwebtoken|\bjose\b|jwt\.(sign|verify|decode)|createJwt|signJwt/i.test(code)) {
            offenders.push(full);
          }
        }
      }
    };
    walk(resolve(import.meta.dirname, '../../'));

    expect(offenders).toEqual([]);
  });
});
