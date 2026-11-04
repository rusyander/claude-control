import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DlpRule } from '@agentdeck/contracts';
import { joinUpstream } from '../http.ts';
import { startDlpProxy, type DlpProxy } from './dlp-proxy.ts';

/**
 * Прокси защиты данных хоста звеньев на настоящем сокете — то, что раньше доказывал
 * `DlpProxy.test.ts` панели (C3c перенёс слушатель в ядро). Маска, разворот ответа, поток,
 * блок, неразобранное и журнал ведёт `bootstrap/boot.dlp-proxy.integration.test.ts` через
 * настоящий boot; здесь — свойства самого слушателя: петля, заголовки, запрос без тела,
 * забытый словарь меток и недоступный адрес наверху.
 */

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const NAMES: DlpRule = {
  id: 'names',
  name: 'Сотрудники',
  enabled: true,
  kind: 'terms',
  terms: ['Рустам Урманов', 'Иван Петров'],
  pattern: '',
  action: 'mask',
  label: 'ИМЯ',
};

/** Первый не-петлевой IPv4 машины: на нём прокси слышать не должен. */
function outwardAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? [])
      if (item.family === 'IPv4' && !item.internal) return item.address;
  }
  return undefined;
}

function refused(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(1_500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
  });
}

describe('прокси защиты данных хоста звеньев: свойства слушателя', () => {
  let proxy: DlpProxy;
  let upstream: Server;
  let seen: {
    path: string;
    body: string;
    headers: Record<string, string | string[] | undefined>;
  }[];
  let dir: string;
  let port: number;
  let upstreamPort: number;

  beforeEach(async () => {
    port = await freePort();
    upstreamPort = await freePort();
    dir = mkdtempSync(join(tmpdir(), 'core-dlp-proxy-'));
    writeFileSync(join(dir, 'dlp-rules.json'), JSON.stringify({ version: 1, rules: [NAMES] }));
    seen = [];
    upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({
          path: request.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          headers: request.headers,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));
    proxy = startDlpProxy({ panelAppData: dir, language: 'ru', now: () => Date.now() });
  });

  afterEach(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (upstreamUrl = `http://127.0.0.1:${upstreamPort}`) =>
    proxy.configure({ port, upstream: upstreamUrl, passUnknown: false, journal: false });

  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });

  const say = (content: string) =>
    post('/v1/messages', JSON.stringify({ messages: [{ role: 'user', content }] }));

  it('слушает только петлю: адрес машины наружу порт не открывает', async () => {
    const state = await open();
    expect(state?.state).toBe('listening');
    expect(state?.port).toBe(port);
    expect(await refused('127.0.0.1', port)).toBe(false);
    const outward = outwardAddress();
    if (outward) expect(await refused(outward, port)).toBe(true);
  });

  it('просит несжатый ответ и не пересылает заголовки соединения', async () => {
    await open();
    // node:http, а не fetch: undici сам отказывается слать заголовки соединения.
    const body = JSON.stringify({ messages: [] });
    await new Promise<void>((resolve, reject) => {
      const outgoing = request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'accept-encoding': 'gzip, br',
            'proxy-authorization': 'Basic c2VjcmV0',
            'keep-alive': 'timeout=9',
            'x-api-key': 'cli-key',
          },
        },
        (response) => {
          response.resume();
          response.on('end', resolve);
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
    expect(seen[0]?.headers['accept-encoding']).toBe('identity');
    expect(seen[0]?.headers['proxy-authorization']).toBeUndefined();
    expect(seen[0]?.headers['keep-alive']).not.toBe('timeout=9');
    // Сквозной заголовок (ключ CLI) уходит как есть.
    expect(seen[0]?.headers['x-api-key']).toBe('cli-key');
  });

  it('запрос без тела пересылается как есть', async () => {
    await open();
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(response.status).toBe(200);
    expect(seen[0]?.path).toBe('/v1/models');
    expect(seen[0]?.body).toBe('');
  });

  it('закрытие забывает словарь меток: после нового открытия нумерация с начала', async () => {
    await open();
    await say('Рустам Урманов');
    expect(seen[0]?.body).toContain('[ИМЯ_1]');
    // Тот же словарь — второе имя получило бы следующий номер.
    await proxy.configure(null);
    expect(proxy.state()).toBeNull();
    await open();
    await say('Иван Петров');
    expect(seen[1]?.body).toContain('[ИМЯ_1]');
    expect(seen[1]?.body).not.toContain('[ИМЯ_2]');
  });

  it('пока открыт — одно и то же имя в двух ходах одна метка, другое имя — следующая', async () => {
    await open();
    await say('Рустам Урманов');
    await say('Иван Петров и Рустам Урманов');
    expect(seen[1]?.body).toContain('[ИМЯ_1]');
    expect(seen[1]?.body).toContain('[ИМЯ_2]');
    expect(seen[1]?.body).not.toContain('Урманов');
  });

  it('недоступный адрес наверху — понятный отказ 502, а не зависание', async () => {
    await open(`http://127.0.0.1:${await freePort()}`);
    const response = await say('привет');
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBeTruthy();
  });
});

describe('joinUpstream', () => {
  it('приклеивает путь запроса к адресу', () => {
    expect(joinUpstream('http://127.0.0.1:1234', '/v1/messages')).toBe(
      'http://127.0.0.1:1234/v1/messages',
    );
  });

  it('не удваивает префикс, который CLI прислал сам', () => {
    // Адрес настроен как `…/v1`, а CLI просит `/v1/messages` — иначе `/v1/v1/messages` и 404.
    expect(joinUpstream('http://gw.local/v1', '/v1/messages')).toBe('http://gw.local/v1/messages');
  });

  it('добавляет префикс, если его нет', () => {
    expect(joinUpstream('http://gw.local/api', '/chat/completions')).toBe(
      'http://gw.local/api/chat/completions',
    );
  });
});
