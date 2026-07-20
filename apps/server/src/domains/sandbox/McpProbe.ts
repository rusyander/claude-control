import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpServer } from '@claude-control/contracts';
import { openMcpSession, type McpTool } from '../mcp-client.ts';

/**
 * Стенд для MCP-сервера: подключиться, посмотреть, что он умеет, и вызвать
 * конкретный инструмент с заданными параметрами.
 *
 * Проверка соединения на странице MCP отвечает только «отзывается или нет».
 * Здесь на шаг дальше: видно список инструментов с их параметрами и можно
 * посмотреть настоящий ответ — примерно как в отладчике запросов.
 *
 * Соединение поднимается на время одного вопроса и закрывается сразу после
 * ответа, поэтому проверка не влияет на серверы, подключённые к самому
 * Claude Code. Сам разговор ведёт общий клиент из domains/mcp-client.ts —
 * он же обслуживает проверку здоровья, и транспорт ему безразличен.
 */

export type { McpTool };

export interface McpCallResult {
  ok: boolean;
  /** Ответ инструмента или текст ошибки. */
  content: string;
  isError: boolean;
  durationMs: number;
}

/** Список инструментов запрашивается сразу после рукопожатия — ждать долго нечего. */
const LIST_TIMEOUT = 30_000;

/**
 * Вызов инструмента ждём дольше: в отличие от служебных запросов, инструмент
 * делает настоящую работу — ходит в чужой API, ищет по репозиторию, — и минута
 * для него не аномалия, а норма.
 */
const CALL_TIMEOUT = 60_000;

export async function listMcpTools(
  server: McpServer,
  timeoutMs = LIST_TIMEOUT,
  authProvider?: OAuthClientProvider,
): Promise<McpTool[]> {
  const session = await openMcpSession(server, timeoutMs, authProvider);
  try {
    return await session.listTools();
  } finally {
    await session.close();
  }
}

export async function callMcpTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = CALL_TIMEOUT,
  authProvider?: OAuthClientProvider,
): Promise<McpCallResult> {
  const startedAt = Date.now();

  // Неудачу возвращаем значением, а не исключением: маршрут песочницы
  // показывает её тем же блоком ответа, что и успешный вызов, — пользователю
  // важно увидеть текст ошибки инструмента, а не пустой экран.
  try {
    const session = await openMcpSession(server, timeoutMs, authProvider);
    try {
      const result = await session.callTool(toolName, args);
      return {
        ...result,
        content: result.content.slice(0, 100_000),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      await session.close();
    }
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : String(error),
      isError: true,
      durationMs: Date.now() - startedAt,
    };
  }
}
