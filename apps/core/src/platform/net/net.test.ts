import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCaFetch, createCaStreamFetch, readCaCert } from './ca-fetch.ts';
import { noProxyBypasses, redactProxyValue, resolveProxy, tunnelAgent } from './proxy.ts';

/**
 * Сеть к внешним адресам (10:128): прокси компании и свой корень доверия — против настоящих
 * `node:http` серверов на петле (прокси и цель). TLS цели здесь не поднимается: корень доверия
 * проверяется только настоящим сертификатом на настоящее имя — это стенд, не тест; сертификат
 * проверяется разбором файла.
 */

const PEM = join(import.meta.dirname, '__fixtures__', 'corp-root.pem');
const url = (raw: string): URL => new URL(raw);

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

describe('platform/net', () => {
  describe('proxy choice', () => {
    it('no proxy → direct; lower-case wins; empty value means no proxy', () => {
      expect(resolveProxy(url('https://gw.corp.test'), {}).kind).toBe('direct');
      const both = resolveProxy(url('https://gw.corp.test'), {
        https_proxy: 'http://a:1',
        HTTPS_PROXY: 'http://b:2',
      });
      expect(both.kind === 'proxy' && both.url.host).toBe('a:1');
      expect(
        resolveProxy(url('https://gw.corp.test'), { https_proxy: '', HTTPS_PROXY: 'http://b:2' })
          .kind,
      ).toBe('direct');
    });

    it('scheme is not swapped; bare host gets http; loopback always direct', () => {
      expect(resolveProxy(url('https://gw.corp.test'), { http_proxy: 'http://p:1' }).kind).toBe(
        'direct',
      );
      const bare = resolveProxy(url('http://gw.corp.test'), { http_proxy: 'p:3128' });
      expect(bare.kind === 'proxy' && bare.url.toString()).toBe('http://p:3128/');
      expect(resolveProxy(url('http://127.0.0.1:9'), { http_proxy: 'http://p:1' }).kind).toBe(
        'direct',
      );
    });

    it('socks or https proxy → unsupported, named, password redacted', () => {
      const route = resolveProxy(url('https://gw.corp.test'), {
        HTTPS_PROXY: 'socks5://u:secret@p:1080',
      });
      expect(route).toMatchObject({ kind: 'unsupported', source: 'HTTPS_PROXY' });
      expect(redactProxyValue('http://u:secret@p:1')).toBe('http://u:***@p:1');
    });

    it('NO_PROXY: star, suffix on a dot boundary, port narrows', () => {
      const target = url('https://api.corp.test');
      expect(noProxyBypasses(target, '*')).toBe(true);
      expect(noProxyBypasses(target, '.corp.test')).toBe(true);
      expect(noProxyBypasses(url('https://evilcorp.test'), 'corp.test')).toBe(false);
      expect(noProxyBypasses(target, 'corp.test:8443')).toBe(false);
      expect(noProxyBypasses(target, 'corp.test:443')).toBe(true);
      expect(noProxyBypasses(target, '  ')).toBe(false);
      expect(resolveProxy(target, { https_proxy: 'http://p:1', NO_PROXY: 'corp.test' }).kind).toBe(
        'direct',
      );
    });

    it('tunnel agent hands out the given socket, never opens its own', () => {
      const socket = { fake: true } as unknown as Parameters<typeof tunnelAgent>[0];
      const agent = tunnelAgent(socket);
      expect((agent as unknown as { createConnection: () => unknown }).createConnection()).toBe(
        socket,
      );
    });
  });

  describe('live proxy and target', () => {
    let proxy: Server;
    let target: Server;
    let proxyPort = 0;
    let targetBase = '';
    let otherBase = '';
    let other: Server;
    let seen: { url: string; headers: IncomingMessage['headers'] }[] = [];
    let connects: { path: string; headers: IncomingMessage['headers'] }[] = [];
    let seenOther: IncomingMessage['headers'] = {};
    let connectStatus = 200;

    const listen = async (server: Server): Promise<number> => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return (server.address() as AddressInfo).port;
    };

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
      other = createServer((request, response) => {
        seenOther = request.headers;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"data":[]}');
      });
      target = createServer((request, response) => {
        if (request.url === '/redirect-away') {
          response.writeHead(302, { location: `${otherBase}/v1/models` });
          response.end();
          return;
        }
        if (request.url === '/empty') {
          response.writeHead(204);
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ via: 'target' }));
      });
      proxyPort = await listen(proxy);
      targetBase = `http://127.0.0.1:${await listen(target)}`;
      otherBase = `http://localhost:${await listen(other)}`;
    });

    afterAll(async () => {
      for (const server of [proxy, target, other]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    beforeEach(() => {
      seen = [];
      connects = [];
      seenOther = {};
      connectStatus = 200;
    });

    it('http goes through the proxy as a full URL with the proxy login; the key rides along to the target', async () => {
      const fetchImpl = createCaFetch('', {
        http_proxy: `http://user:pa ss@127.0.0.1:${proxyPort}`,
      });
      const response = await fetchImpl('http://gw.corp.test/v1/models', {
        headers: { authorization: 'Bearer key' },
      });
      await expect(response.json()).resolves.toEqual({ via: 'proxy' });
      expect(seen[0]?.url).toBe('http://gw.corp.test/v1/models');
      expect(seen[0]?.headers['proxy-authorization']).toBe(
        `Basic ${Buffer.from('user:pa ss').toString('base64')}`,
      );
    });

    it('https goes by CONNECT: the proxy sees host:port only; refusal and 407 carry codes', async () => {
      connectStatus = 403;
      const fetchImpl = createCaFetch('', { https_proxy: `http://127.0.0.1:${proxyPort}` });
      const refused = await fetchImpl('https://gw.corp.test/v1/models').catch((e: unknown) => e);
      expect(codeOf(refused)).toBe('proxy-refused');
      expect(connects[0]?.path).toBe('gw.corp.test:443');
      expect(connects[0]?.headers.authorization).toBeUndefined();
      expect(seen).toHaveLength(0);
      connectStatus = 407;
      const login = await fetchImpl('https://gw.corp.test/v1/models').catch((e: unknown) => e);
      expect(codeOf(login)).toBe('proxy-login');
    });

    it('unsupported proxy → refused, not one byte bypasses it', async () => {
      const fetchImpl = createCaFetch('', { https_proxy: `socks5://127.0.0.1:${proxyPort}` });
      const error = await fetchImpl('https://gw.corp.test/v1/models').catch((e: unknown) => e);
      expect(codeOf(error)).toBe('proxy-unsupported');
      expect(seen).toHaveLength(0);
      expect(connects).toHaveLength(0);
    });

    it('own transport with a company CA: loopback answers, 204 has no body', async () => {
      const fetchImpl = createCaFetch(PEM, {});
      await expect((await fetchImpl(`${targetBase}/v1/models`)).json()).resolves.toEqual({
        via: 'target',
      });
      expect((await fetchImpl(`${targetBase}/empty`)).status).toBe(204);
    });

    it('a redirect to a foreign origin carries no key header; the stream fetch never follows', async () => {
      const fetchImpl = createCaFetch(PEM, {});
      const response = await fetchImpl(`${targetBase}/redirect-away`, {
        headers: { 'x-api-key': 'k', accept: 'application/json' },
      });
      expect(response.status).toBe(200);
      expect(seenOther['x-api-key']).toBeUndefined();
      expect(seenOther.accept).toBe('application/json');
      const stream = createCaStreamFetch(PEM, {});
      expect((await stream(`${targetBase}/redirect-away`)).status).toBe(302);
    });

    it('without CA and proxy the built-in fetch is returned', () => {
      expect(createCaFetch('', {})).toBe(globalThis.fetch);
      expect(createCaFetch('', { https_proxy: 'http://p:3128' })).not.toBe(globalThis.fetch);
    });
  });

  describe('company CA file', () => {
    it('missing file → ca-unreadable; not a certificate → ca-not-certificate; a PEM reads', () => {
      const unreadable = (() => {
        try {
          readCaCert(join(import.meta.dirname, '__fixtures__', 'missing.pem'));
        } catch (error) {
          return codeOf(error);
        }
        return undefined;
      })();
      expect(unreadable).toBe('ca-unreadable');
      const notCert = (() => {
        try {
          readCaCert(join(import.meta.dirname, 'net.types.ts'));
        } catch (error) {
          return codeOf(error);
        }
        return undefined;
      })();
      expect(notCert).toBe('ca-not-certificate');
      expect(readCaCert(PEM).length).toBeGreaterThan(100);
      expect(() => createCaFetch(join(import.meta.dirname, 'nope.pem'), {})).toThrow(/CA not read/);
    });
  });
});
