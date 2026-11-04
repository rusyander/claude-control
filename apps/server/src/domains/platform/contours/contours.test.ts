import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreContoursReply } from '@agentdeck/contracts/core/hops';
import type { CoreIdentityDeps } from '../../../lib/listen-identity/listen-identity.ts';
import { createRightsFeed } from '../watch/rights-feed.ts';
import { ContourLinkError, createCoreContours } from './contours.ts';

/**
 * Клиент учёта контуров ядра (C3b) — на настоящем HTTP: ядро здесь — сервер на loopback с тем
 * же API (`/v1/contours*`), строка `procs.json` и токен лежат во временном доме, как их пишет
 * ядро. Подменена только таблица TCP/живость процесса (внешняя граница — ОС). Настоящее ядро за
 * этим клиентом — `tools/qa/check-core-contours.mjs`.
 */

const TOKEN = 'contours-test-token';

interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

let home: string;
let server: Server;
let port: number;
let seen: Seen[];
let status: number;
let reply: CoreContoursReply;
/** Ядро приняло запрос и молчит (зависло) — для границы ожидания конца хода. */
let hang: boolean;
/** Сколько раз ядро выдало звено (`POST /v1/contours/:id/link`). */
let linked: number;
const logs: string[] = [];

/** Личность строки: порт слушает этот процесс (`ownerPid`), процесс жив. */
const identity =
  (ownerPid = process.pid) =>
  (): CoreIdentityDeps => ({
    tcp: async () => ({
      value: [{ state: 'listen', localAddress: '127.0.0.1', localPort: port, pid: ownerPid }],
    }),
    isAlive: async () => 'alive',
    exists: async () => true,
  });

function writeProcs(): void {
  writeFileSync(join(home, 'token'), `${TOKEN}\n`);
  writeFileSync(
    join(home, 'procs.json'),
    JSON.stringify({
      v: 1,
      cores: [
        {
          build: 'test',
          pid: process.pid,
          pidStart: 'start',
          bootId: 'boot',
          port,
          url: `http://127.0.0.1:${port}`,
          startedAt: 1,
          home,
          portDecision: { rejected: [] },
        },
      ],
      servers: [],
    }),
  );
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'cc-contours-client-'));
  seen = [];
  status = 200;
  hang = false;
  linked = 0;
  logs.length = 0;
  reply = {
    live: {
      since: 1,
      requests: 2,
      failures: 0,
      usage: [],
      events: [],
      summarized: { total: 0, recent: [] },
      notices: [],
    },
    records: { dev: { platformId: 'dev', days: [], exhaustedAt: '2026-11-02T00:00:00.000Z' } },
  };
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    request.on('end', () => {
      seen.push({
        method: request.method!,
        path: request.url!,
        authorization: request.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      });
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      if (hang) return;
      if (status !== 200) return response.end('{"error":"no"}');
      if (request.url?.startsWith('/v1/contours/run?'))
        return response.end(JSON.stringify({ summarized: true, toolCalls: 4 }));
      if (request.url === '/v1/contours/summarized')
        return response.end(JSON.stringify({ messageIds: ['msg_a', 'msg_b'] }));
      if (request.url === '/v1/contours') return response.end(JSON.stringify(reply));
      if (request.url === '/v1/contours/apply')
        return response.end(
          JSON.stringify({
            applied: true,
            userGateway: { port: 5179, state: 'listening', since: 9, routes: [] },
          }),
        );
      if (request.url?.startsWith('/v1/contours/notices'))
        return response.end(
          JSON.stringify({
            notices: [
              {
                seq: 3,
                at: 'x',
                platformId: 'dev',
                platformTitle: 'Dev',
                level: 'near',
                share: 0.9,
              },
            ],
          }),
        );
      if (request.url?.endsWith('/clear-exhausted'))
        return response.end(JSON.stringify({ cleared: true }));
      if (request.url?.endsWith('/link')) {
        linked += 1;
        return response.end(
          JSON.stringify({ baseUrl: 'http://127.0.0.1:5100', key: `adk-hop-${linked}` }),
        );
      }
      return response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

const client = (ownerPid?: number, factsTimeoutMs?: number) =>
  createCoreContours({
    home: () => home,
    identity: identity(ownerPid),
    ...(factsTimeoutMs !== undefined ? { factsTimeoutMs } : {}),
    log: (line) => logs.push(line),
  });

describe('клиент учёта контуров ядра', () => {
  it('чтение: последний ответ ядра держится в памяти, запрос несёт токен ядра', async () => {
    writeProcs();
    const contours = client();
    expect(contours.live()).toBeUndefined();
    expect(await contours.refresh()).toBe(true);
    expect(contours.live()?.requests).toBe(2);
    expect(contours.records().dev?.exhaustedAt).toBeTruthy();
    expect(seen).toEqual([
      { method: 'GET', path: '/v1/contours', authorization: `Bearer ${TOKEN}`, body: undefined },
    ]);
  });

  it('ядра нет — одна строка журнала на причину; ядро появилось — снятие отметки и свежее чтение', async () => {
    const contours = client();
    expect(await contours.refresh()).toBe(false);
    expect(await contours.refresh()).toBe(false);
    expect(seen).toEqual([]);
    // Каждая неудача с той же причиной журнал не множит.
    expect(logs.filter((line) => line.includes('procs.json'))).toHaveLength(1);
    expect(new Set(logs).size).toBe(logs.length);

    writeProcs();
    expect(await contours.clearExhausted('dev')).toBe(true);
    expect(seen.map((item) => [item.method, item.path])).toEqual([
      ['POST', '/v1/contours/dev/clear-exhausted'],
      ['GET', '/v1/contours'],
    ]);
  });

  it('применить контур: POST /v1/contours/apply, шлюз из ответа виден сразу (s10 G7)', async () => {
    writeProcs();
    const contours = client();
    expect(contours.userGatewayPort()).toBe(0);
    expect(await contours.apply()).toBe(true);
    expect(seen.map((item) => [item.method, item.path, item.authorization])).toEqual([
      ['POST', '/v1/contours/apply', `Bearer ${TOKEN}`],
    ]);
    expect(contours.userGatewayPort()).toBe(5179);
  });

  it('применить контур: ядро молчит, отказывает или зависло — false без исключения, строка одна', async () => {
    const contours = client(undefined, 50);
    expect(await contours.apply()).toBe(false);
    writeProcs();
    status = 500;
    expect(await contours.apply()).toBe(false);
    status = 200;
    hang = true;
    const started = Date.now();
    expect(await contours.apply()).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(logs.filter((line) => line.startsWith('contours: apply'))).toHaveLength(3);
  });

  it('порт слушает чужой процесс — токен не уходит никуда (F-19)', async () => {
    writeProcs();
    const contours = client(process.pid + 1);
    expect(await contours.refresh()).toBe(false);
    await contours.stop();
    expect(seen).toEqual([]);
    expect(logs.join('\n')).toContain('not verified');
  });

  it('шлюз человека у ядра: слушает — порт уходит панели один раз; ждёт порт — прогоны получают 0', async () => {
    writeProcs();
    const announced: number[] = [];
    const contours = createCoreContours({
      home: () => home,
      identity: identity(),
      log: (line) => logs.push(line),
      onUserGatewayPort: (gatewayPort) => announced.push(gatewayPort),
    });
    expect(contours.userGatewayPort()).toBe(0);
    reply = { ...reply, userGateway: { port: 5179, state: 'listening', since: 1, routes: [] } };
    expect(await contours.refresh()).toBe(true);
    expect(await contours.refresh()).toBe(true);
    expect(contours.userGatewayPort()).toBe(5179);
    expect(announced).toEqual([5179]);
    // Порт занят чужим процессом: шлюз ждёт, адреса для прогонов нет, панели сказать нечего.
    reply = {
      ...reply,
      userGateway: { port: 5179, state: 'waiting', since: 2, routes: [], lastError: 'EADDRINUSE' },
    };
    expect(await contours.refresh()).toBe(true);
    expect(contours.userGatewayPort()).toBe(0);
    expect(contours.userGateway()).toMatchObject({ state: 'waiting', lastError: 'EADDRINUSE' });
    expect(announced).toEqual([5179]);
  });

  it('события книги контуров — читателю с каждым ответом: отказ 401 будит сторожа прав (C3d)', async () => {
    writeProcs();
    const noted: string[] = [];
    const seenEvents: number[] = [];
    const feed = createRightsFeed({ note: (id) => noted.push(id), now: () => 0 });
    const contours = createCoreContours({
      home: () => home,
      identity: identity(),
      log: (line) => logs.push(line),
      onEvents: (events) => {
        seenEvents.push(events.length);
        feed(events);
      },
    });
    const refusal = {
      at: '2026-11-02T10:00:00.000Z',
      platformId: 'dev',
      path: '/v1/messages',
      dialect: 'anthropic-messages',
      status: 401,
      stages: [],
      summarized: false,
      violations: [],
      masked: false,
      blocked: false,
      interrupted: false,
      unknownFrames: [],
      lost: [],
      shimmed: [],
      toolCalls: 0,
      contourCalls: 0,
      toolFlaws: [],
      claimedWithoutCall: false,
      totalTokens: 0,
    };
    reply = { ...reply, live: { ...reply.live, events: [refusal] } };
    expect(await contours.refresh()).toBe(true);
    expect(await contours.refresh()).toBe(true);
    expect(noted).toEqual(['dev']);
    // Ядро отказало — читатель не зовётся вовсе: прошлый снимок не повторяется.
    status = 503;
    expect(await contours.refresh()).toBe(false);
    expect(seenEvents).toEqual([1, 1]);
  });

  it('читатель событий упал — ответ ядра принят, опрос не врёт отказом', async () => {
    writeProcs();
    const contours = createCoreContours({
      home: () => home,
      identity: identity(),
      log: (line) => logs.push(line),
      onEvents: () => {
        throw new Error('vault locked');
      },
    });
    expect(await contours.refresh()).toBe(true);
    expect(contours.live()?.requests).toBe(2);
    expect(logs).toEqual(['contours: events not handled: vault locked']);
  });

  it('извещения о бюджете — курсор передаётся ядру как есть', async () => {
    writeProcs();
    const notices = await client().notices(7);
    expect(seen[0]!.path).toBe('/v1/contours/notices?after=7');
    expect(notices.map((item) => item.seq)).toEqual([3]);
  });

  describe('факты прогона и журнал сжатий (C3b, piece 2)', () => {
    it('факты прогона: вопрос с меткой и началом хода (целые миллисекунды)', async () => {
      // Сжатие записывает шлюз человека у ядра сам, в своём процессе: очереди у панели нет.
      writeProcs();
      expect(await client().runFacts('run-1', 1_700_000_000_123.7)).toEqual({
        summarized: true,
        toolCalls: 4,
      });
      expect(seen.map((item) => [item.method, item.path])).toEqual([
        ['GET', '/v1/contours/run?tag=run-1&since=1700000000123'],
      ]);
    });

    it('журнал сжатий — множество id сообщений ленты', async () => {
      writeProcs();
      const ids = await client().summarizedIds();
      expect([...ids]).toEqual(['msg_a', 'msg_b']);
      expect(seen[0]!.path).toBe('/v1/contours/summarized');
    });

    it('ядра нет или оно отказало — без подсказки, но и без исключения; строка журнала одна', async () => {
      const contours = client();
      expect(await contours.runFacts('run-1', 0)).toEqual({ summarized: false });
      expect(await contours.runFacts('run-1', 0)).toEqual({ summarized: false });
      expect((await contours.summarizedIds()).size).toBe(0);
      expect(logs.filter((line) => line.includes('run facts not read'))).toHaveLength(1);
      expect(logs.filter((line) => line.includes('summarized ids not read'))).toHaveLength(1);

      writeProcs();
      status = 500;
      expect(await contours.runFacts('run-1', 0)).toEqual({ summarized: false });
      expect(logs.join('\n')).toContain('/v1/contours/run?tag=run-1&since=0: 500');
    });

    it('ядро зависло — конец хода ждёт не дольше границы и получает «без подсказки»', async () => {
      writeProcs();
      hang = true;
      const started = Date.now();
      expect(await client(undefined, 150).runFacts('run-1', 0)).toEqual({ summarized: false });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(logs.join('\n')).toContain('run facts not read');
    });
  });

  describe('адрес звена для картинок и колод (метка панели)', () => {
    it('каждый зов спрашивает ядро (адрес держит оно, по фактам контура); «заново» ему сказано', async () => {
      writeProcs();
      const contours = client();

      const first = await contours.link('dev');
      expect(first).toEqual({ baseUrl: 'http://127.0.0.1:5100', key: 'adk-hop-1' });
      // Своей памяти у панели нет: звено, записанное до правки карточки (манифест объявил ручку
      // картинок позже), отдавалось бы из неё, и ядро не успело бы его перерегистрировать.
      expect((await contours.link('dev')).key).toBe('adk-hop-2');
      expect(seen).toEqual([
        {
          method: 'POST',
          path: '/v1/contours/dev/link',
          authorization: `Bearer ${TOKEN}`,
          body: {},
        },
        {
          method: 'POST',
          path: '/v1/contours/dev/link',
          authorization: `Bearer ${TOKEN}`,
          body: {},
        },
      ]);

      await contours.link('dev', true);
      expect(seen[2]).toMatchObject({ path: '/v1/contours/dev/link', body: { fresh: true } });
    });

    it('отказ ядра — его код и слова; следующий зов снова идёт к ядру', async () => {
      writeProcs();
      const contours = client();
      status = 409;

      const refused = await contours.link('dev').catch((thrown: unknown) => thrown);
      expect(refused).toBeInstanceOf(ContourLinkError);
      expect(refused).toMatchObject({ status: 409, message: 'no' });

      status = 200;
      expect((await contours.link('dev')).key).toBe('adk-hop-1');
      expect(seen).toHaveLength(2);
    });

    it('ядра нет — 503 со словами «не найдено», запрос не уходит никуда', async () => {
      const refused = await client()
        .link('dev')
        .catch((thrown: unknown) => thrown);
      expect(refused).toMatchObject({ status: 503 });
      expect((refused as Error).message).toContain('Ядро не найдено');
      expect(seen).toHaveLength(0);
    });
  });

  describe('звено маршрута панели и шлюз человека (Q5, 5179)', () => {
    it('прямой вызов по ключу: POST /v1/links с id маршрута, «заново» — флагом', async () => {
      writeProcs();
      const contours = client();

      await contours.linkRoute('api-key:endpoint:e1');
      await contours.linkRoute('api-key:claude', true);
      expect(seen).toEqual([
        {
          method: 'POST',
          path: '/v1/links',
          authorization: `Bearer ${TOKEN}`,
          body: { routeId: 'api-key:endpoint:e1' },
        },
        {
          method: 'POST',
          path: '/v1/links',
          authorization: `Bearer ${TOKEN}`,
          body: { routeId: 'api-key:claude', fresh: true },
        },
      ]);
    });

    it('отказ ядра на маршруте — его код и слова (404 — ключа у звена нет)', async () => {
      writeProcs();
      status = 404;
      const refused = await client()
        .linkRoute('api-key:qwen')
        .catch((thrown: unknown) => thrown);
      expect(refused).toBeInstanceOf(ContourLinkError);
      expect(refused).toMatchObject({ status: 404, message: 'no' });
    });

    it('порт шлюза человека: слушает — его порт; ждёт или ядра нет — 0; сбой чтения хранит прежний', async () => {
      writeProcs();
      const contours = client();
      expect(contours.userGatewayPort()).toBe(0);

      reply = {
        ...reply,
        userGateway: { port: 5179, state: 'waiting', since: 1, routes: [] },
      };
      await contours.refresh();
      expect(contours.userGatewayPort()).toBe(0);

      reply = {
        ...reply,
        userGateway: { port: 5179, state: 'listening', since: 1, routes: ['user:dev'] },
      };
      await contours.refresh();
      expect(contours.userGatewayPort()).toBe(5179);

      status = 500;
      await contours.refresh();
      expect(contours.userGatewayPort()).toBe(5179);
    });
  });
});
