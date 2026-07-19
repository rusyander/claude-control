import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@claude-control/contracts';
import { openMcpSession } from './mcp-client.ts';
import { checkMcpHealth } from './mcp.ts';
import { listMcpTools, callMcpTool } from './sandbox/McpProbe.ts';

/**
 * Проверка клиента MCP на всех трёх транспортах.
 *
 * Мокать здесь нечего: смысл правки был именно в том, что http и sse раньше
 * проверялись HEAD-запросом, то есть протокол не трогали вовсе. Поэтому на
 * время теста поднимается настоящий MCP-сервер — на SDK, на живом порту, — и
 * рукопожатие с tools/list идут по-настоящему.
 *
 * Транспорт stdio проверяется наоборот, сервером, написанным руками поверх
 * JSON-RPC: SDK, говорящий сам с собой, согласится с любой своей же ошибкой,
 * а посторонняя реализация ловит расхождение со спецификацией.
 *
 * Токен в тестах ненастоящий, сеть не выходит за пределы 127.0.0.1.
 */

/** Общий бюджет: локальный сервер отвечает мгновенно, ждать нечего. */
const BUDGET = 5_000;

const TOKEN = 'Bearer test-token';

/** Заготовка записи из конфига — тесты меняют только то, что проверяют. */
function makeServer(partial: Partial<McpServer>): McpServer {
  return {
    id: 'fixture',
    name: 'fixture',
    transport: 'stdio',
    args: [],
    env: {},
    headers: {},
    health: 'unknown',
    isEnabled: true,
    groupIds: [],
    ...partial,
  };
}

/** Сервер с двумя инструментами: по числу видно, что список настоящий. */
function buildSdkServer(): SdkMcpServer {
  const server = new SdkMcpServer({ name: 'fixture-server', version: '1.0.0' });

  server.registerTool(
    'echo',
    { description: 'Возвращает переданный текст', inputSchema: { text: z.string() } },
    ({ text }) => ({ content: [{ type: 'text' as const, text }] }),
  );

  server.registerTool('ping', { description: 'Отвечает pong' }, () => ({
    content: [{ type: 'text' as const, text: 'pong' }],
  }));

  return server;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
  });
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

/** Заголовок пропускаем, если сервер его требует, — так проверяются headers. */
function isAuthorized(req: IncomingMessage, requireAuth: boolean): boolean {
  return !requireAuth || req.headers.authorization === TOKEN;
}

/**
 * Streamable HTTP без сессий: на каждый запрос свой сервер и свой транспорт.
 * Ответы обычным JSON, а не потоком, — тесту хватает, а разбор проще.
 */
function createHttpFixture(requireAuth: boolean): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (!isAuthorized(req, requireAuth)) {
        res.writeHead(401).end('unauthorized');
        return;
      }

      const body = await readBody(req);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = buildSdkServer();

      res.on('close', () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })();
  });
}

/**
 * Legacy SSE: поток событий на GET, сообщения отдельными POST-ами. Сессию
 * сервер выдаёт сам и подставляет её в адрес, который присылает клиенту.
 */
function createSseFixture(requireAuth: boolean): Server {
  const sessions = new Map<string, SSEServerTransport>();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/sse') {
        // Проверяем заголовок именно на подписке: авторизованный сервер
        // отбивает клиента здесь, до всякого JSON-RPC.
        if (!isAuthorized(req, requireAuth)) {
          res.writeHead(401).end('unauthorized');
          return;
        }

        const transport = new SSEServerTransport('/messages', res);
        sessions.set(transport.sessionId, transport);
        res.on('close', () => sessions.delete(transport.sessionId));
        await buildSdkServer().connect(transport);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/messages') {
        const transport = sessions.get(url.searchParams.get('sessionId') ?? '');
        if (!transport) {
          res.writeHead(404).end('no session');
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404).end();
    })();
  });
}

/**
 * Сервер stdio без единой зависимости: разговаривает JSON-RPC построчно.
 * Он же служит проверкой на регрессию — раньше этот путь был единственным
 * рабочим, и переезд на SDK не должен был его сломать.
 */
const STDIO_FIXTURE = `
const tools = [
  { name: 'echo', description: 'Возвращает текст', inputSchema: { type: 'object' } },
  { name: 'ping', description: 'Отвечает pong', inputSchema: { type: 'object' } },
];

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    const message = JSON.parse(line);
    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');

    if (message.method === 'initialize') {
      reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'stdio-fixture', version: '1.0.0' },
      });
    } else if (message.method === 'tools/list') {
      reply({ tools });
    } else if (message.method === 'tools/call') {
      const text = message.params.name === 'echo' ? message.params.arguments.text : 'pong';
      reply({ content: [{ type: 'text', text }] });
    }
  }
});
`;

describe('mcp-client', () => {
  let dir: string;
  let stdioScript: string;
  let httpOpen: Server;
  let httpAuth: Server;
  let sseOpen: Server;
  let sseAuth: Server;
  let httpOpenUrl: string;
  let httpAuthUrl: string;
  let sseOpenUrl: string;
  let sseAuthUrl: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-mcp-'));
    stdioScript = join(dir, 'stdio-server.mjs');
    writeFileSync(stdioScript, STDIO_FIXTURE);

    httpOpen = createHttpFixture(false);
    httpAuth = createHttpFixture(true);
    sseOpen = createSseFixture(false);
    sseAuth = createSseFixture(true);

    [httpOpenUrl, httpAuthUrl, sseOpenUrl, sseAuthUrl] = await Promise.all([
      listen(httpOpen),
      listen(httpAuth),
      listen(sseOpen),
      listen(sseAuth),
    ]);
  });

  afterAll(async () => {
    await Promise.all([
      shutdown(httpOpen),
      shutdown(httpAuth),
      shutdown(sseOpen),
      shutdown(sseAuth),
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  const stdioServer = (): McpServer =>
    makeServer({ transport: 'stdio', command: process.execPath, args: [stdioScript] });

  const httpServer = (): McpServer => makeServer({ transport: 'http', url: `${httpOpenUrl}/mcp` });

  const sseServer = (): McpServer => makeServer({ transport: 'sse', url: `${sseOpenUrl}/sse` });

  describe('рукопожатие и список инструментов', () => {
    it('stdio: сервер представляется и отдаёт инструменты', async () => {
      const session = await openMcpSession(stdioServer(), BUDGET);
      try {
        expect(session.handshake.name).toBe('stdio-fixture');
        expect((await session.listTools()).map((tool) => tool.name)).toEqual(['echo', 'ping']);
      } finally {
        await session.close();
      }
    });

    it('http: сервер представляется и отдаёт инструменты', async () => {
      const session = await openMcpSession(httpServer(), BUDGET);
      try {
        expect(session.handshake.name).toBe('fixture-server');
        expect((await session.listTools()).map((tool) => tool.name)).toEqual(['echo', 'ping']);
      } finally {
        await session.close();
      }
    });

    it('sse: сервер представляется и отдаёт инструменты', async () => {
      const session = await openMcpSession(sseServer(), BUDGET);
      try {
        expect(session.handshake.name).toBe('fixture-server');
        expect((await session.listTools()).map((tool) => tool.name)).toEqual(['echo', 'ping']);
      } finally {
        await session.close();
      }
    });

    it('схема параметров доезжает до вызывающего — по ней рисуется форма', async () => {
      const tools = await listMcpTools(httpServer(), BUDGET);
      const echo = tools.find((tool) => tool.name === 'echo');
      expect(echo?.description).toBe('Возвращает переданный текст');
      expect(echo?.inputSchema).toMatchObject({ type: 'object' });
    });
  });

  describe('вызов инструмента', () => {
    it('stdio: ответ инструмента возвращается текстом', async () => {
      const result = await callMcpTool(stdioServer(), 'echo', { text: 'привет' }, BUDGET);
      expect(result).toMatchObject({ ok: true, isError: false, content: 'привет' });
    });

    it('http: ответ инструмента возвращается текстом', async () => {
      const result = await callMcpTool(httpServer(), 'echo', { text: 'привет' }, BUDGET);
      expect(result).toMatchObject({ ok: true, isError: false, content: 'привет' });
    });

    it('sse: ответ инструмента возвращается текстом', async () => {
      const result = await callMcpTool(sseServer(), 'echo', { text: 'привет' }, BUDGET);
      expect(result).toMatchObject({ ok: true, isError: false, content: 'привет' });
    });

    it('неизвестный инструмент — неудача значением, а не исключением', async () => {
      const result = await callMcpTool(httpServer(), 'missing', {}, BUDGET);
      expect(result.isError).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
    });
  });

  describe('заголовки', () => {
    it('http: без заголовка сервер за авторизацией не пускает', async () => {
      await expect(
        openMcpSession(makeServer({ transport: 'http', url: `${httpAuthUrl}/mcp` }), BUDGET),
      ).rejects.toThrow();
    });

    it('http: с заголовком рукопожатие проходит', async () => {
      const tools = await listMcpTools(
        makeServer({
          transport: 'http',
          url: `${httpAuthUrl}/mcp`,
          headers: { Authorization: TOKEN },
        }),
        BUDGET,
      );
      expect(tools).toHaveLength(2);
    });

    it('sse: без заголовка подписка на поток отбивается', async () => {
      await expect(
        openMcpSession(makeServer({ transport: 'sse', url: `${sseAuthUrl}/sse` }), BUDGET),
      ).rejects.toThrow();
    });

    it('sse: заголовок доезжает до самой подписки, а не только до сообщений', async () => {
      const tools = await listMcpTools(
        makeServer({
          transport: 'sse',
          url: `${sseAuthUrl}/sse`,
          headers: { Authorization: TOKEN },
        }),
        BUDGET,
      );
      expect(tools).toHaveLength(2);
    });
  });

  describe('неполные записи', () => {
    it('stdio без команды — понятная ошибка, а не падение спавна', async () => {
      await expect(openMcpSession(makeServer({ transport: 'stdio' }), BUDGET)).rejects.toThrow(
        'Не задана команда запуска',
      );
    });

    it('http без адреса — понятная ошибка', async () => {
      await expect(openMcpSession(makeServer({ transport: 'http' }), BUDGET)).rejects.toThrow(
        'Не задан адрес',
      );
    });

    it('адрес, который не разбирается, называется прямо', async () => {
      await expect(
        openMcpSession(makeServer({ transport: 'http', url: 'не-адрес' }), BUDGET),
      ).rejects.toThrow(/не разбирается как URL/);
    });
  });

  describe('checkMcpHealth', () => {
    it('stdio: отвечает и считает инструменты', async () => {
      expect(await checkMcpHealth(stdioServer(), BUDGET)).toEqual({
        health: 'connected',
        toolCount: 2,
      });
    });

    it('http: toolCount заполняется — раньше для сети его не было вовсе', async () => {
      expect(await checkMcpHealth(httpServer(), BUDGET)).toEqual({
        health: 'connected',
        toolCount: 2,
      });
    });

    it('sse: toolCount заполняется', async () => {
      expect(await checkMcpHealth(sseServer(), BUDGET)).toEqual({
        health: 'connected',
        toolCount: 2,
      });
    });

    it('выключенный сервер не проверяется вовсе', async () => {
      const result = await checkMcpHealth(makeServer({ isEnabled: false }), BUDGET);
      expect(result).toEqual({ health: 'disabled' });
    });

    it('закрытый порт — не «отвечает», а внятная неудача', async () => {
      // Порт из динамического диапазона, на котором заведомо никого нет:
      // раньше HEAD-пинг сюда же возвращал failed, но без объяснения.
      const result = await checkMcpHealth(
        makeServer({ transport: 'http', url: 'http://127.0.0.1:9/mcp' }),
        BUDGET,
      );
      expect(result.health).toBe('failed');
      expect(result.detail?.length).toBeGreaterThan(0);
    });

    it('несуществующая команда — неудача с текстом, а не зависание', async () => {
      const result = await checkMcpHealth(
        makeServer({ transport: 'stdio', command: 'нет-такой-команды-cc' }),
        BUDGET,
      );
      expect(result.health).toBe('failed');
      expect(result.detail?.length).toBeGreaterThan(0);
    });

    it('чужой сервис на живом порту не сходит за MCP', async () => {
      // Ровно то, что пропускал HEAD-пинг: порт открыт, отвечает 404 —
      // прежняя проверка сказала бы «отвечает».
      const result = await checkMcpHealth(
        makeServer({ transport: 'http', url: `${sseOpenUrl}/not-mcp` }),
        BUDGET,
      );
      expect(result.health).toBe('failed');
    });
  });
});
