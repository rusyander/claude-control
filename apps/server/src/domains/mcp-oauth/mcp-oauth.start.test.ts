import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@agentdeck/contracts';
import { startOAuth } from './mcp-oauth.ts';
import { PanelOAuthProvider } from './provider.ts';
import { oauthStorePath, hasOAuthTokens } from './store.ts';

/**
 * «Авторизоваться» у figma (локальный Dev Mode, sse на 127.0.0.1:3845) не делало
 * ничего: сервер входа не требует, подключение проходило, старт отвечал
 * `authorized` — и карточка молча закрывала окно без значка и без слов.
 *
 * Здесь оба настоящих сервера на живых портах: локальный SSE без входа (как
 * Dev Mode) и удалённый сервер с OAuth — 401, обнаружение (RFC 9728 / 8414),
 * регистрация клиента (RFC 7591). Клиент — тот же SDK, что у панели.
 */

function makeServer(partial: Partial<McpServer>): McpServer {
  return {
    id: 'figma',
    name: 'figma',
    transport: 'sse',
    args: [],
    env: {},
    headers: {},
    health: 'unknown',
    isEnabled: true,
    groupIds: [],
    hasOAuth: false,
    ...partial,
  };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
    });
  });
}

function shutdown(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Локальный SSE без входа — так отвечает Dev Mode Figma. */
function localSse(): Server {
  const sessions = new Map<string, SSEServerTransport>();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        sessions.set(transport.sessionId, transport);
        res.on('close', () => sessions.delete(transport.sessionId));
        await new SdkMcpServer({ name: 'dev-mode', version: '1.0.0' }).connect(transport);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const transport = sessions.get(url.searchParams.get('sessionId') ?? '');
        if (!transport) return void res.writeHead(404).end();
        await transport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404).end();
    })();
  });
}

/** Удалённый сервер с OAuth: сам MCP за 401, рядом метаданные и регистрация. */
function remoteOAuth(base: () => string): Server {
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${base()}/mcp`, authorization_servers: [base()] });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      return json(res, 200, {
        issuer: base(),
        authorization_endpoint: `${base()}/authorize`,
        token_endpoint: `${base()}/token`,
        registration_endpoint: `${base()}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const asked = JSON.parse(raw || '{}') as Record<string, unknown>;
        json(res, 201, { ...asked, client_id: 'panel-client' });
      });
      return;
    }
    if (url.pathname === '/mcp') {
      res
        .writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource"`,
        })
        .end('unauthorized');
      return;
    }
    res.writeHead(404).end();
  });
}

describe('startOAuth: сервер без входа и сервер с OAuth', () => {
  let appData: string;
  const servers: Server[] = [];

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-mcp-oauth-start-'));
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(shutdown));
    rmSync(appData, { recursive: true, force: true });
  });

  it('локальный SSE без входа — `not-required`, а не молчаливое `authorized`', async () => {
    const http = localSse();
    servers.push(http);
    const base = await listen(http);

    const result = await startOAuth(makeServer({ url: `${base}/sse` }), appData);

    expect(result).toEqual({ status: 'not-required' });
    expect(hasOAuthTokens(appData, 'figma')).toBe(false);
  });

  it('тот же сервер с сохранённым токеном — `authorized` (вход уже выполнен)', async () => {
    const http = localSse();
    servers.push(http);
    const base = await listen(http);
    await new PanelOAuthProvider(
      'figma',
      oauthStorePath(appData),
      'http://127.0.0.1/cb',
    ).saveTokens({ access_token: 'tok', token_type: 'bearer' });

    const result = await startOAuth(makeServer({ url: `${base}/sse` }), appData);

    expect(result).toEqual({ status: 'authorized' });
  });

  it('удалённый сервер с OAuth — адрес входа с PKCE и state', async () => {
    let address = '';
    const http = remoteOAuth(() => address);
    servers.push(http);
    address = await listen(http);

    const result = await startOAuth(
      makeServer({ id: 'remote', transport: 'http', url: `${address}/mcp` }),
      appData,
    );

    expect(result.status).toBe('redirect');
    const url = new URL(result.status === 'redirect' ? result.authorizationUrl : '');
    expect(`${url.origin}${url.pathname}`).toBe(`${address}/authorize`);
    expect(url.searchParams.get('client_id')).toBe('panel-client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('сервер не отвечает вовсе — ошибка, а не «авторизован»', async () => {
    const http = localSse();
    servers.push(http);
    const base = await listen(http);
    await shutdown(http);
    servers.length = 0;

    await expect(startOAuth(makeServer({ url: `${base}/sse` }), appData)).rejects.toThrow();
  });
});
