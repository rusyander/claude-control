import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { McpServer } from '@claude-control/contracts';
import { checkMcpHealth, listMcpServerTools } from './mcp.ts';

/**
 * Кого считать «требующим авторизации».
 *
 * Догадка по тексту ошибки применялась ко всему сообщению целиком, а у stdio в
 * него подклеивается stderr упавшего процесса (`describeFailure`). Любой лог со
 * словом unauthorized или числом 401 внутри превращал причину в «войдите через
 * OAuth» — при том, что у stdio входить некуда (кнопки на карточке нет), а
 * настоящая причина из stderr при этом терялась.
 *
 * Сеть не выходит за пределы 127.0.0.1, токенов здесь нет.
 */

const BUDGET = 5_000;

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
    hasOAuth: false,
    ...partial,
  };
}

const OAUTH_HINT = 'Требуется авторизация OAuth';

/**
 * Сервер, который падает на старте с чужим 401 в stderr: так ведёт себя
 * обёртка над чужим API, не получившая токен из окружения. Выход отложен —
 * иначе stderr мог не успеть доехать до сборки сообщения.
 */
const FAILING_STDIO = [
  '-e',
  "console.error('AuthError: request to api failed with status 401'); setTimeout(() => process.exit(1), 150);",
];

describe('признак отказа по авторизации', () => {
  let unauthorizedHttp: Server;
  let unauthorizedUrl: string;

  beforeAll(async () => {
    unauthorizedHttp = createServer((_req, res) => res.writeHead(401).end('unauthorized'));
    unauthorizedUrl = await new Promise<string>((resolve) => {
      unauthorizedHttp.listen(0, '127.0.0.1', () => {
        const address = unauthorizedHttp.address();
        resolve(
          `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`,
        );
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      unauthorizedHttp.closeAllConnections();
      unauthorizedHttp.close(() => resolve());
    });
  });

  it('stdio: чужой 401 в stderr остаётся причиной, а не советом войти', async () => {
    const result = await checkMcpHealth(
      makeServer({ transport: 'stdio', command: process.execPath, args: FAILING_STDIO }),
      BUDGET,
    );

    expect(result.health).toBe('failed');
    expect(result.detail).not.toContain(OAUTH_HINT);
    expect(result.detail).toContain('401');
  });

  it('stdio: список инструментов объясняет отказ тем же stderr', async () => {
    const result = await listMcpServerTools(
      makeServer({ transport: 'stdio', command: process.execPath, args: FAILING_STDIO }),
      BUDGET,
    );

    expect(result.tools).toEqual([]);
    expect(result.error).not.toContain(OAUTH_HINT);
    expect(result.error).toContain('401');
  });

  it('http: настоящий 401 по-прежнему зовёт авторизоваться', async () => {
    const result = await checkMcpHealth(
      makeServer({ transport: 'http', url: unauthorizedUrl }),
      BUDGET,
    );

    expect(result).toEqual({
      health: 'failed',
      detail: expect.stringContaining(OAUTH_HINT),
      // Итог проверки хранится в state.json с отметкой времени (аудит MCP 2026-09-02).
      checkedAt: expect.any(String),
    });
  });
});
