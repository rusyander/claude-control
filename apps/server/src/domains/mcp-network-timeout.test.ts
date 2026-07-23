import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { McpServer } from '@claude-control/contracts';
import { checkMcpHealth } from './mcp.ts';

/**
 * Настраиваемый потолок подключения к сетевым MCP-серверам.
 *
 * Сервер в стенде принимает соединение и молчит — то есть «порт открыт, но
 * MCP не отвечает». Раньше сеть ждала фиксированные ~10с; теперь потолок задаёт
 * настройка mcpNetworkTimeoutMs, и проверка обязана сдаться примерно на нём, а
 * не позже. Значение берём заведомо маленькое, чтобы тест был быстрым и чтобы
 * промах мимо параметра (уход на дефолт 10с) тест ловил разницей во времени.
 */

/** Принимает запрос и никогда не отвечает — имитация зависшего сервера. */
function createHangingServer(): Server {
  return createServer((req: IncomingMessage) => {
    // Читаем тело, но намеренно не отвечаем: соединение висит до дедлайна клиента.
    req.resume();
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

function makeNetworkServer(url: string): McpServer {
  return {
    id: 'fixture',
    name: 'fixture',
    transport: 'http',
    args: [],
    env: {},
    headers: {},
    health: 'unknown',
    isEnabled: true,
    groupIds: [],
    hasOAuth: false,
    url: `${url}/mcp`,
  };
}

describe('mcpNetworkTimeoutMs', () => {
  let hanging: Server;
  let hangingUrl: string;

  beforeAll(async () => {
    hanging = createHangingServer();
    hangingUrl = await listen(hanging);
  });

  afterAll(async () => {
    await shutdown(hanging);
  });

  it('маленький потолок обрывает молчащий сетевой сервер примерно на нём', async () => {
    const startedAt = Date.now();
    const result = await checkMcpHealth(makeNetworkServer(hangingUrl), 30_000, undefined, 2_000);
    const elapsed = Date.now() - startedAt;

    expect(result.health).toBe('failed');
    // Сдаться на ~2с, а не на дефолтных ~10с: иначе настройка не подействовала.
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(6_000);
  });
});
