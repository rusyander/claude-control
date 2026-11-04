import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreDlpProxyReply } from '@agentdeck/contracts/core/hops';
import type { CoreIdentityDeps } from '../../lib/listen-identity/listen-identity.ts';
import { createCoreDlpProxy, DlpStartError } from './core-dlp.ts';

/**
 * Прокси защиты данных глазами панели (C3c) — на настоящем HTTP: ядро здесь — сервер на loopback
 * с тем же API (`GET /v1/dlp-proxy`, `POST /v1/dlp-proxy/apply`), строка `procs.json` и токен
 * лежат во временном доме, как их пишет ядро. Подменена только таблица TCP (внешняя граница —
 * ОС). Настоящее ядро за этим путём — `apps/core/src/bootstrap/boot.dlp-proxy.integration.test.ts`
 * (слушатель) и живой стенд (панель → ядро).
 */

const TOKEN = 'dlp-client-test-token';

let home: string;
let server: Server;
let port: number;
let seen: { method: string; path: string; authorization: string | undefined }[];
let reply: CoreDlpProxyReply;
let status: number;

const identity = (): CoreIdentityDeps => ({
  tcp: async () => ({
    value: [{ state: 'listen', localAddress: '127.0.0.1', localPort: port, pid: process.pid }],
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

const listening = (patch: Partial<NonNullable<CoreDlpProxyReply['proxy']>> = {}) => ({
  port: 5179,
  state: 'listening' as const,
  since: 1,
  upstream: 'http://127.0.0.1:9100',
  lastError: null,
  requests: 3,
  masked: 2,
  blocked: 1,
  ...patch,
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'cc-dlp-client-'));
  seen = [];
  status = 200;
  reply = { enabled: true, port: 5179, proxy: listening(), problem: null };
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization,
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  writeProcs();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

const client = () => createCoreDlpProxy({ home: () => home, identity, settingsPort: () => 5179 });

describe('прокси защиты данных у панели: состояние и тумблер — ответ ядра', () => {
  it('до первого ответа — адрес из настроек, не работает, без ошибки', () => {
    const proxy = client();
    expect(proxy.running).toBe(false);
    expect(proxy.status()).toEqual({
      running: false,
      address: 'http://127.0.0.1:5179',
      upstream: '',
      requests: 0,
      masked: 0,
      blocked: 0,
    });
  });

  it('refresh: GET /v1/dlp-proxy с токеном ядра; состояние и счётчики ядра в форме страницы', async () => {
    const proxy = client();
    await proxy.refresh?.();
    expect(seen).toEqual([
      { method: 'GET', path: '/v1/dlp-proxy', authorization: `Bearer ${TOKEN}` },
    ]);
    expect(proxy.running).toBe(true);
    expect(proxy.status()).toEqual({
      running: true,
      address: 'http://127.0.0.1:5179',
      upstream: 'http://127.0.0.1:9100',
      requests: 3,
      masked: 2,
      blocked: 1,
    });
  });

  it('start: POST apply; ядро держит порт — без исключения', async () => {
    const proxy = client();
    await proxy.start();
    expect(seen.map((item) => `${item.method} ${item.path}`)).toEqual(['POST /v1/dlp-proxy/apply']);
    expect(proxy.running).toBe(true);
  });

  it('start: причина ядра — DlpStartError с её кодом и кодом текста', async () => {
    reply = {
      enabled: true,
      port: 5179,
      proxy: null,
      problem: { code: 'dlp-no-rules', detail: 'нет ни одного включённого правила' },
    };
    const error = await client()
      .start()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DlpStartError);
    expect((error as DlpStartError).code).toBe('dlp-no-rules');
    expect((error as { messageCode?: string }).messageCode).toBe('dlp-no-rules');
  });

  it('start: порт занят (ждёт) — отказ «порт занят», статус называет причину ожидания', async () => {
    reply = {
      enabled: true,
      port: 5179,
      proxy: listening({ state: 'waiting', lastError: 'EADDRINUSE', requests: 0 }),
      problem: null,
    };
    const proxy = client();
    const error = await proxy.start().catch((caught: unknown) => caught);
    expect((error as DlpStartError).code).toBe('dlp-port-busy');
    expect(proxy.running).toBe(false);
    expect(proxy.status().error).toBe('EADDRINUSE');
  });

  it('ядро не отвечает — start отказывает кодом недоступности, статус говорит, что держит ядро', async () => {
    status = 500;
    const proxy = client();
    const error = await proxy.start().catch((caught: unknown) => caught);
    expect((error as DlpStartError).code).toBe('dlp-core-unreachable');
    expect(proxy.status().error).toMatch(/держит ядро.*500/);
  });

  it('строки ядра нет — refresh не бросает, статус называет причину', async () => {
    rmSync(join(home, 'procs.json'));
    const proxy = client();
    await proxy.refresh?.();
    expect(seen).toEqual([]);
    expect(proxy.running).toBe(false);
    expect(proxy.status().error).toMatch(/ядро не найдено/);
  });

  it('stop: POST apply (тумблер уже записан), закрытый ответ ядра — не работает', async () => {
    const proxy = client();
    await proxy.start();
    reply = { enabled: false, port: 5179, proxy: null, problem: null };
    await proxy.stop();
    expect(seen.map((item) => item.path)).toEqual(['/v1/dlp-proxy/apply', '/v1/dlp-proxy/apply']);
    expect(proxy.running).toBe(false);
    expect(proxy.status().requests).toBe(0);
  });
});
